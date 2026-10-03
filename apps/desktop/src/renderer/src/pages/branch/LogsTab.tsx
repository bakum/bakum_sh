import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Group, SegmentedControl, Select, Stack, TextInput, Tooltip } from '@mantine/core';
import { IconDownload, IconSearch } from '@tabler/icons-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useComputedColorScheme } from '@mantine/core';
import type { BranchView, LogChunk } from '@bm/shared';
import { useBm } from '../../lib/query';
import { LIGHT_SURFACE } from '../../theme';
import { t } from '../../i18n';

const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
const MAX_LINES = 20000;

function levelOf(line: string): number {
  const m = / (DEBUG|INFO|WARNING|ERROR|CRITICAL) /.exec(line);
  return m ? LEVELS.indexOf(m[1]!) : -1;
}

/** Colours Odoo log lines; traceback blocks (Traceback… + indented lines) are red. */
function colorize(lines: string[]): string[] {
  let inTb = false;
  return lines.map((l) => {
    if (/^Traceback \(most recent call last\)/.test(l) || /\bTraceback\b/.test(l)) inTb = true;
    else if (inTb && !/^\s/.test(l) && !/^\w+(\.\w+)*(Error|Exception|Warning)\b/.test(l)) inTb = false;
    const lvl = levelOf(l);
    if (inTb || lvl >= 3) return `\x1b[31m${l}\x1b[0m`;
    if (lvl === 2) return `\x1b[33m${l}\x1b[0m`;
    if (/^==> |^\[step\]/.test(l)) return `\x1b[36m${l}\x1b[0m`;
    return l;
  });
}

/** Logs (spec 8.9): odoo.log (docker logs -f), build.log, tests.log; level filter, search, save. */
export function LogsTab({ branch }: { branch: BranchView }) {
  const [params] = useSearchParams();
  const builds = useBm('builds.list', { branchId: branch.id, limit: 30 });
  const defaultBuild = params.get('build') ?? String(branch.activeBuild?.id ?? branch.liveBuild?.id ?? builds.data?.items[0]?.id ?? '');
  const [buildId, setBuildId] = useState<string>(defaultBuild);
  const initialSource = params.get('source');
  const [source, setSource] = useState<'odoo' | 'build' | 'tests'>(
    initialSource === 'tests' || initialSource === 'build' ? initialSource : params.get('build') || branch.activeBuild ? 'build' : 'odoo',
  );
  const [minLevel, setMinLevel] = useState('all');
  const [search, setSearch] = useState('');
  const scheme = useComputedColorScheme('light');
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const lines = useRef<string[]>([]);
  const filterRef = useRef(minLevel);
  filterRef.current = minLevel;

  useEffect(() => {
    if (!buildId && defaultBuild) setBuildId(defaultBuild);
  }, [defaultBuild, buildId]);

  const pass = (l: string) => {
    const f = filterRef.current;
    if (f === 'all') return true;
    const lvl = levelOf(l);
    return lvl === -1 ? f === 'WARNING' ? false : true : lvl >= LEVELS.indexOf(f);
  };

  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontSize: 12,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      scrollback: MAX_LINES,
      theme: scheme === 'dark' ? { background: '#1a1b1e' } : { background: LIGHT_SURFACE, foreground: '#222222', selectionBackground: '#b3d7ff' },
    });
    const f = new FitAddon();
    const s = new SearchAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.open(host.current);
    f.fit();
    term.current = t;
    fit.current = f;
    searchAddon.current = s;
    const ro = new ResizeObserver(() => f.fit());
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      t.dispose();
      term.current = null;
    };
  }, [scheme]);

  useEffect(() => {
    lines.current = [];
    term.current?.reset();
    if (!buildId) return;
    const onChunk = (data: unknown) => {
      const chunk = data as LogChunk;
      if (chunk.reset) {
        lines.current = [];
        term.current?.reset();
      }
      lines.current.push(...chunk.lines);
      if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES);
      const shown = chunk.lines.filter(pass);
      if (shown.length) term.current?.write(colorize(shown).join('\n') + '\n');
    };
    return source === 'odoo'
      ? window.bm.subscribe('container.log', { buildId: Number(buildId) }, onChunk)
      : window.bm.subscribe('build.log', { buildId: Number(buildId), file: source }, onChunk);
  }, [buildId, source, scheme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    term.current?.reset();
    const shown = lines.current.filter(pass);
    if (shown.length) term.current?.write(colorize(shown).join('\n') + '\n');
  }, [minLevel]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildOptions = useMemo(
    () => (builds.data?.items ?? []).map((b) => ({ value: String(b.id), label: `#${b.number} · ${b.status}${b.isLive ? t('logs.live') : ''}` })),
    [builds.data],
  );


  return (
    <Stack h="calc(100vh - 250px)" gap="xs">
      {builds.data && !builds.data.items.length && <Alert color="gray">{t('logs.noBuilds')}</Alert>}
      <Group gap="xs">
        <SegmentedControl
          size="xs"
          value={source}
          onChange={(v) => setSource(v as 'odoo' | 'build' | 'tests')}
          data={[
            { value: 'odoo', label: 'odoo.log' },
            { value: 'build', label: 'build.log' },
            { value: 'tests', label: 'tests.log' },
          ]}
        />
        <Select size="xs" w={220} data={buildOptions} value={buildId} onChange={(v) => v && setBuildId(v)} />
        <Select
          size="xs"
          w={130}
          value={minLevel}
          onChange={(v) => setMinLevel(v ?? 'all')}
          data={[
            { value: 'all', label: t('logs.allLevels') },
            { value: 'INFO', label: 'INFO+' },
            { value: 'WARNING', label: 'WARNING+' },
            { value: 'ERROR', label: 'ERROR+' },
          ]}
        />
        <TextInput
          size="xs"
          w={220}
          placeholder={t('logs.search')}
          leftSection={<IconSearch size={12} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && search) {
              if (e.shiftKey) searchAddon.current?.findPrevious(search);
              else searchAddon.current?.findNext(search);
            }
          }}
        />
        <Button
          size="xs"
          variant="default"
          leftSection={<IconDownload size={12} />}
          onClick={() => void window.bm.desktop.saveFile({ defaultPath: `${branch.slug}-${source}.log`, content: lines.current.join('\n') })}
        >
          {t('logs.saveAs')}
        </Button>
        <Tooltip label={t('logs.stage3')}>
          <Button size="xs" variant="default" disabled>
            {t('logs.window')}
          </Button>
        </Tooltip>
      </Group>
      <div ref={host} style={{ flex: 1, minHeight: 0, border: '1px solid var(--mantine-color-default-border)', padding: 4 }} data-testid="log-view" />
    </Stack>
  );
}
