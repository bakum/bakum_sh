/**
 * GitHub avatar of a commit author, as odoo.sh shows it (D65). No API and no token: GitHub serves the avatar of the
 * account an email belongs to, and an identicon for an unknown email. The renderer falls back to the initial when the
 * image does not load (offline, GitHub unreachable) or the email is unknown to the app (older builds, folder commits).
 */
export function githubAvatarUrl(email: string | undefined, size: number): string | null {
  if (!email) return null;
  // <id>+<login>@users.noreply.github.com — the account id is right there.
  const id = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email)?.[1];
  if (id) return `https://avatars.githubusercontent.com/u/${id}?s=${size}`;
  return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=${size}`;
}
