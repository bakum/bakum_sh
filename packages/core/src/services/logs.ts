import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { BmError } from '@bm/shared';
import type { Ctx } from '../context';
import { docker } from '../docker/client';
import { buildRow, testsLogPath } from '../builds/view';
import { buildContainers } from '../builds/drop';

/** Collects lines and flushes them in batches (~100 ms) so a noisy log does not flood the UI. */
function batcher(emit: (d: unknown) => void) {
  let buf: string[] = [];
  let partial = '';
  let t: NodeJS.Timeout | null = null;
  const flush = () => {
    t = null;
    if (buf.length) emit({ lines: buf.splice(0) });
  };
  return {
    push(text: string) {
      const parts = (partial + text).split(/\r?\n/);
      partial = parts.pop() ?? '';
      buf.push(...parts);
      if (buf.length > 5000) buf = buf.slice(-5000);
      t ??= setTimeout(flush, 100);
    },
    reset(lines: string[]) {
      buf = [];
      partial = '';
      emit({ lines, reset: true });
    },
    close() {
      if (t) clearTimeout(t);
    },
  };
}

function tailLines(file: string, maxLines: number): { lines: string[]; size: number } {
  if (!fs.existsSync(file)) return { lines: [], size: 0 };
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - 4 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split(/\r?\n/);
  if (start > 0) lines.shift();
  if (lines[lines.length - 1] === '') lines.pop();
  return { lines: lines.slice(-maxLines), size };
}

/** Subscription `build.log`: the build step log file (or its tests.log), followed while open. */
export function subscribeBuildLog(ctx: Ctx, buildId: number, kind: 'build' | 'tests', emit: (d: unknown) => void): () => void {
  const b = buildRow(ctx, buildId);
  if (!b?.logPath) {
    emit({ lines: ['(лог сборки не найден)'], reset: true });
    return () => {};
  }
  const file = kind === 'tests' ? testsLogPath(b.logPath) : b.logPath;
  if (kind === 'tests' && !fs.existsSync(file) && b.status !== 'building' && b.status !== 'queued') {
    emit({ lines: ['(тесты в этой сборке не запускались)'], reset: true });
    return () => {};
  }
  const bt = batcher(emit);
  const first = tailLines(file, 10000);
  bt.reset(first.lines);
  let pos = first.size;
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(file)) return;
      const size = fs.statSync(file).size;
      if (size < pos) pos = 0;
      if (size === pos) return;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      bt.push(buf.toString('utf8'));
    } catch {
      /* file rotated */
    }
  }, 500);
  return () => {
    clearInterval(timer);
    bt.close();
  };
}

/** The container to show for a build: its service container, else a running one-off step container. */
async function containerFor(buildId: number): Promise<string | null> {
  const cs = await buildContainers(buildId);
  return (cs.find((c) => !c.oneoff) ?? cs.find((c) => c.state === 'running'))?.id ?? null;
}

/** Subscription `container.log`: `docker logs -f` of the build container (odoo.log). */
export function subscribeContainerLog(_ctx: Ctx, buildId: number, emit: (d: unknown) => void): () => void {
  const bt = batcher(emit);
  let closed = false;
  let stream: NodeJS.ReadableStream | null = null;
  void (async () => {
    const id = await containerFor(buildId).catch(() => null);
    if (closed) return;
    if (!id) {
      bt.reset(['(контейнер сборки не найден: сборка остановлена, отброшена или ещё не поднята)']);
      return;
    }
    bt.reset([]);
    const c = docker.getContainer(id);
    const s = (await c.logs({ follow: true, stdout: true, stderr: true, tail: 3000 })) as NodeJS.ReadableStream;
    if (closed) {
      (s as unknown as { destroy?: () => void }).destroy?.();
      return;
    }
    stream = s;
    const out = new PassThrough();
    docker.modem.demuxStream(s, out, out);
    out.on('data', (d: Buffer) => bt.push(d.toString('utf8')));
    s.on('end', () => bt.push('\n(поток логов завершён: контейнер остановлен)\n'));
  })().catch((err) => bt.reset([`(ошибка чтения логов: ${(err as Error).message})`]));
  return () => {
    closed = true;
    bt.close();
    (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
  };
}

/** Subscription `stats`: live CPU / RAM of the build container (the Monitor tab reads `monitor.get`, D45). */
export function subscribeStats(_ctx: Ctx, buildId: number, emit: (d: unknown) => void): () => void {
  let closed = false;
  let stream: NodeJS.ReadableStream | null = null;
  void (async () => {
    const id = await containerFor(buildId);
    if (!id || closed) return;
    stream = (await docker.getContainer(id).stats({ stream: true })) as unknown as NodeJS.ReadableStream;
    let buf = '';
    stream.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const s = JSON.parse(line);
          const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
          const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
          const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus ?? 1) * 100 : 0;
          emit({ at: Date.now(), cpu, memMb: (s.memory_stats.usage ?? 0) / 1024 / 1024 });
        } catch {
          /* partial */
        }
      }
    });
  })().catch(() => {});
  return () => {
    closed = true;
    (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
  };
}

export async function readLogs(ctx: Ctx, p: { buildId: number; kind: 'build' | 'tests' | 'odoo'; tail?: number }): Promise<{ lines: string[]; path: string | null }> {
  const b = buildRow(ctx, p.buildId);
  if (!b) throw new BmError('NO_BUILD', 'Сборка не найдена');
  if (p.kind !== 'odoo') {
    const file = b.logPath && (p.kind === 'tests' ? testsLogPath(b.logPath) : b.logPath);
    return { lines: file ? tailLines(file, p.tail ?? 500).lines : [], path: file };
  }
  const id = await containerFor(b.id);
  if (!id) return { lines: [], path: null };
  const buf = (await docker.getContainer(id).logs({ stdout: true, stderr: true, tail: p.tail ?? 500, follow: false })) as unknown as Buffer;
  const out: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + len).toString('utf8'));
    i += 8 + len;
  }
  return { lines: out.join('').split(/\r?\n/), path: null };
}
