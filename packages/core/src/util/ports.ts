import { execa } from 'execa';

/**
 * TCP ports in LISTENING state on this machine, read from `netstat` — the app never opens a socket to probe
 * (criterion 15: no listening ports of its own).
 */
export async function listeningPorts(): Promise<Set<number>> {
  const r = await execa('netstat', ['-ano', '-p', 'TCP'], { reject: false, windowsHide: true });
  const out = new Set<number>();
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i.exec(line);
    if (m) out.add(Number(m[1]));
  }
  const r6 = await execa('netstat', ['-ano', '-p', 'TCPv6'], { reject: false, windowsHide: true });
  for (const line of String(r6.stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i.exec(line);
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
