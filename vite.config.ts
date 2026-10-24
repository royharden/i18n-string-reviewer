import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are public. Never add another VITE_ variable
// for a secret: anything with that prefix is bundled into the browser.
export default defineConfig({
  plugins: [react()],
  envPrefix: 'VITE_',
  build: {
    sourcemap: true,
    target: 'es2022',
  },
});
