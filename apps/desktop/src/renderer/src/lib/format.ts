import { locale } from '@bm/shared';
import { t } from '../i18n';
import { isMac } from './bm';

/** A Ctrl (⌘ on macOS) shortcut as the hint shows it: `Ctrl+K` / `⌘K`. */
export const modKey = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`);

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Day and month in the interface locale (axis of a chart over days). */
export function fmtDay(t0: number | string | Date): string {
  return new Date(t0).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' });
}

/** Time of day in the interface locale; `seconds: false` gives HH:MM. */
export function fmtTime(t0: number | string | Date, seconds = true): string {
  return new Date(t0).toLocaleTimeString(locale(), seconds ? undefined : { hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t('fmt.justNow');
  if (s < 3600) return t('fmt.minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('fmt.hAgo', { n: Math.floor(s / 3600) });
  return t('fmt.dAgo', { n: Math.floor(s / 86400) });
}

export function fmtDuration(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return '—';
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('fmt.s', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('fmt.ms', { m, s: s % 60 });
  return t('fmt.hm', { h: Math.floor(m / 60), m: m % 60 });
}

const JOBS = ['build', 'start', 'stop', 'restart', 'drop', 'delete_branch', 'import_backup', 'fetch', 'apply_config', 'modules', 'tests'] as const;

/** Name of a job type in the interface language; other types are shown as they are. */
export const jobLabel = (type: string): string => ((JOBS as readonly string[]).includes(type) ? t(`job.${type as (typeof JOBS)[number]}`) : type);

const TRIGGERS = ['new_commit', 'rebuild', 'manual', 'import_backup', 'stage_change'] as const;

/** Build triggers with their labels in the interface language. */
export const triggerLabels = (): Record<string, string> => Object.fromEntries(TRIGGERS.map((k) => [k, t(`trigger.${k}`)]));

/** Start of a local calendar day (`YYYY-MM-DD`, as from `<input type="date">`) as an ISO time; `days` shifts it. */
export function dayStartIso(day: string, days = 0): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export const shortSha =(sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '—');

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const u = t('fmt.bytes').split('|');
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
