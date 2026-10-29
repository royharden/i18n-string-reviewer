import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { configuredSupabaseOrigin } from './src/lib/publicConfig.ts';

// Only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are public. Never add another VITE_ variable
// for a secret: anything with that prefix is bundled into the browser.
export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  const rawUrl = (environment['VITE_SUPABASE_URL'] ?? '').trim();
  const origin = rawUrl ? configuredSupabaseOrigin(rawUrl) : '';
  const development = command === 'serve' && mode !== 'production';
  const policy = [
    "default-src 'self'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
    `style-src 'self'${development ? " 'unsafe-inline'" : ''}`,
    "img-src 'self' data:", "font-src 'self'",
    `connect-src 'self'${origin ? ` ${origin}` : ''}${development ? ' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*' : ''}`,
    "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; ');
  // URL.origin is validated above; HTML escaping is still applied at the attribute boundary.
  const escaped = policy.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  return {
    plugins: [react(), {
      name: 'review-csp',
      transformIndexHtml: {
        order: 'post' as const,
        handler: (html: string) => {
          const marker = /(<meta\s+http-equiv="Content-Security-Policy"\s+data-review-csp\s+content=")[^"]*("\s*\/?>)/u;
          if (!marker.test(html)) throw new Error('Missing marked CSP meta element.');
          return html.replace(marker, (_match: string, before: string, after: string) => before + escaped + after);
        },
      },
    }],
    envPrefix: 'VITE_',
    build: {
      sourcemap: true,
      target: 'es2022',
    },
  };
});
