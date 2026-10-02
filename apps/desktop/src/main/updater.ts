import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { net } from 'electron';
import type { Logger } from 'pino';
import { compareSemver, type UpdateState } from '@bm/shared';

export type { UpdateState };

interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[];
}

export interface UpdaterOptions {
  current: string;
  log: Logger;
  userDataDir: string;
  mode: UpdateState['mode'];
  settings: () => { repository: string; includePrerelease: boolean };
  /** Test-only release list URL (unpackaged builds only). */
  testEndpoint: string | null;
  onChange: (s: UpdateState) => void;
}

/**
 * The release asset this platform installs from (D67): the NSIS Setup exe on Windows, the arm64 disk image on macOS.
 * Portable exe, blockmaps and the other platform's files never match.
 */
export function isInstallerAsset(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' ? /-mac-arm64\.dmg$/i.test(name) : /setup.*\.exe$/i.test(name);
}

/**
 * Checks GitHub Releases of the configured repository for a newer version and downloads its Setup installer.
 * Only outgoing HTTPS to api.github.com / github.com release assets; nothing listens.
 */
export class Updater {
  state: UpdateState;
  private release: Release | null = null;
  private file: string | null = null;
  private stateFile: string;

  constructor(private readonly o: UpdaterOptions) {
    this.stateFile = path.join(o.userDataDir, 'update.json');
    this.state = {
      status: 'idle',
      current: o.current,
      latest: null,
      notes: null,
      url: null,
      publishedAt: null,
      asset: null,
      progress: null,
      error: null,
      checkedAt: null,
      mode: o.mode,
      skipped: false,
    };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.o.onChange(this.state);
  }

  private skippedVersion(): string | null {
    try {
      return (JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { skipped?: string }).skipped ?? null;
    } catch {
      return null;
    }
  }

  /** «Пропустить эту версию»: the start-up check stays silent for it, a manual check still shows it. */
  skip(): void {
    if (!this.state.latest) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify({ skipped: this.state.latest }));
    this.set({ skipped: true });
  }

  private endpoint(repo: string): string {
    return this.o.testEndpoint ?? `https://api.github.com/repos/${repo}/releases?per_page=20`;
  }

  async check(manual: boolean): Promise<UpdateState> {
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'installing') return this.state;
    const { repository, includePrerelease } = this.o.settings();
    this.set({ status: 'checking', error: null });
    try {
      const res = await net.fetch(this.endpoint(repository), {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Odoo-Branch-Manager/${this.o.current}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub ответил ${res.status} ${res.statusText}`);
      const list = (await res.json()) as Release[];
      const candidates = list.filter((r) => !r.draft && (includePrerelease || !r.prerelease));
      candidates.sort((a, b) => compareSemver(b.tag_name, a.tag_name));
      const best = candidates[0] ?? null;
      const checkedAt = new Date().toISOString();
      if (!best || compareSemver(best.tag_name, this.o.current) <= 0) {
        this.release = null;
        this.set({ status: 'none', latest: best?.tag_name.replace(/^v/, '') ?? null, checkedAt, asset: null, notes: null, url: best?.html_url ?? null });
        this.o.log.info({ manual, latest: best?.tag_name ?? null }, 'update check: up to date');
        return this.state;
      }
      this.release = best;
      const latest = best.tag_name.replace(/^v/, '');
      const setup = best.assets.find((a) => isInstallerAsset(a.name)) ?? null;
      this.file = null;
      this.set({
        status: 'available',
        latest,
        notes: best.body ?? '',
        url: best.html_url,
        publishedAt: best.published_at,
        asset: setup ? { name: setup.name, size: setup.size } : null,
        progress: null,
        checkedAt,
        skipped: this.skippedVersion() === latest,
      });
      this.o.log.info({ manual, latest, asset: setup?.name ?? null }, 'update available');
      return this.state;
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? 'нет ответа от GitHub за 15 с' : (err as Error).message;
      this.set({ status: 'error', error: `Не удалось проверить обновления: ${msg}. Проверьте подключение к интернету.` });
      this.o.log.warn({ err, manual }, 'update check failed');
      return this.state;
    }
  }

  /** Downloads the installer to the temp folder and verifies its size (and SHA-256 when GitHub provides a digest). */
  async download(): Promise<string> {
    if (this.file && this.state.status === 'ready') return this.file;
    const rel = this.release;
    const asset = rel?.assets.find((a) => isInstallerAsset(a.name));
    if (!rel || !asset) throw new Error(process.platform === 'darwin' ? 'В релизе нет образа для macOS (…-mac-arm64.dmg)' : 'В релизе нет установщика (…Setup….exe)');
    const dir = path.join(os.tmpdir(), 'odoo-branch-manager-update');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(asset.name));
    const part = `${target}.part`;
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      const res = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': `Odoo-Branch-Manager/${this.o.current}` } });
      if (!res.ok || !res.body) throw new Error(`загрузка: ${res.status} ${res.statusText}`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let done = 0;
      let lastPct = -1;
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        hash.update(value);
        done += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        const pct = asset.size ? Math.floor((done / asset.size) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          this.set({ progress: pct / 100 });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
      if (asset.size && done !== asset.size) throw new Error(`размер ${done} байт вместо ${asset.size}`);
      const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
      const actual = hash.digest('hex');
      if (digest && digest.toLowerCase() !== actual) throw new Error('контрольная сумма SHA-256 не совпадает с указанной в релизе');
      fs.renameSync(part, target);
      this.file = target;
      this.set({ status: 'ready', progress: 1 });
      this.o.log.info({ target, bytes: done, sha256: actual, verified: !!digest }, 'update downloaded');
      return target;
    } catch (err) {
      fs.rmSync(part, { force: true });
      this.set({ status: 'error', progress: null, error: `Не удалось скачать обновление: ${(err as Error).message}` });
      throw err;
    }
  }

  markInstalling(): void {
    this.set({ status: 'installing' });
  }
}
