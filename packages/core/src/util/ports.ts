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
