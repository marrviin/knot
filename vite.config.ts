import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),

    // Inject CSP only in production builds (required by the Electron security checklist);
    // skip in dev, otherwise inline scripts from Vite HMR / react-refresh get blocked.
    {
      name: 'inject-csp',
      apply: 'build',
      transformIndexHtml(html) {
        const csp =
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; font-src 'self' data:";
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
        );
      },
    },
  ],

  // Assets must use relative paths — the packaged Electron app loads them via file://
  base: './',

  clearScreen: false,
  server: {
    // wait-on in `pnpm dev` waits on this port
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/dist-electron/**', '**/src-tauri/**'],
    },
  },
});
