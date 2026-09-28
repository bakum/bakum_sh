export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}

export function fmtDuration(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return '—';
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '—');

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
