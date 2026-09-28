/** Only these external targets may be opened from the app (spec 11). */
export function isAllowedExternal(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'vscode:' || u.protocol === 'cursor:') return true;
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost')) return true;
    if (u.protocol === 'https:' && u.hostname === 'github.com') return true;
  }
  return false;
}
