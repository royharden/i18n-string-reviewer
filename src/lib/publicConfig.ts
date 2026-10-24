/** Shared by browser configuration and Vite's CSP transform; no secrets or environment reads here. */
export function configuredSupabaseOrigin(raw: string): string {
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/iu.test(url.hostname) || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Supabase URL must be an HTTPS origin (HTTP is allowed only for localhost).');
  }
  return url.origin;
}
