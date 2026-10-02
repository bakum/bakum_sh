import { execa } from 'execa';

/**
 * TCP ports in LISTENING state on this machine, read from `netstat` — the app never opens a socket to probe
 * (criterion 15: no listening ports of its own).
 */
export async function listeningPorts(): Promise<Set<number>> {
  if (process.platform !== 'win32') {
    // macOS netstat lists both families with `-p tcp` and, unlike lsof, other users' sockets too (D67).
    const r = await execa('netstat', ['-an', '-p', 'tcp'], { reject: false });
    return parseBsdNetstat(String(r.stdout ?? ''));
  }
  const out = new Set<number>();
  for (const family of ['TCP', 'TCPv6']) {
    const r = await execa('netstat', ['-ano', '-p', family], { reject: false, windowsHide: true });
    for (const p of parseWindowsNetstat(String(r.stdout ?? ''))) out.add(p);
  }
  return out;
}

/** `TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    4` */
export function parseWindowsNetstat(text: string): Set<number> {
  const out = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i.exec(line);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/** `tcp46  0  0  *.8080  *.*  LISTEN` / `tcp4  0  0  127.0.0.1.5433  *.*  LISTEN` (macOS) */
export function parseBsdNetstat(text: string): Set<number> {
  const out = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*tcp\S*\s+\d+\s+\d+\s+\S*\.(\d+)\s+\S+\s+LISTEN\b/i.exec(line);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/**
 * TCP port ranges Windows reserved for Hyper-V / WSL / WinNAT (`netsh interface ipv4 show excludedportrange`). They are
 * taken from the dynamic range 49152–65535 and move after a reboot; Docker Desktop cannot publish a port inside one, yet
 * the container still starts with the port silently unpublished (D62).
 */
export async function excludedPortRanges(): Promise<Array<[number, number]>> {
  if (process.platform !== 'win32') return [];
  const r = await execa('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { reject: false, windowsHide: true });
  return parseExcludedPortRanges(String(r.stdout ?? ''));
}

/** Rows «start end [*]»; the headers are localised (and in the OEM code page), so only the numbers are relied on. */
export function parseExcludedPortRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\b/.exec(line);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

export const inPortRanges = (port: number, ranges: Array<[number, number]>): boolean => ranges.some(([lo, hi]) => port >= lo && port <= hi);
