import { defineConfig, loadEnv } from 'vite';

// Grok Ops prewarm is tens of seconds. Auto HMR (or the full-page reload
// fallback) mid-boot / mid-fight is pure pain: you lose pointer lock, audio
// context, and wait for prewarm again. Default = no client reload; Vite still
// watches the disk so a manual refresh picks up the latest modules.
//
// Opt back into HMR with OW_HMR=1. Capture tools set OW_NO_HMR=1 (same outcome).
const hmrEnabled = Boolean(process.env.OW_HMR) && !process.env.OW_NO_HMR;

export default defineConfig(({ mode }) => {
  // Force-load .env / .env.local so VITE_CONVEX_URL is always available to the
  // title-shell leaderboard (boot.js), even if the process env is empty.
  const env = loadEnv(mode, process.cwd(), '');
  const convexUrl =
    env.VITE_CONVEX_URL || 'https://abundant-chicken-369.convex.cloud';
  const convexSite =
    env.VITE_CONVEX_SITE_URL || 'https://abundant-chicken-369.convex.site';

  return {
    // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
    // which the capture harness (127.0.0.1) cannot reach.
    server: {
      host: '127.0.0.1',
      // Prefer 5173, but if another worktree/checkout already owns it, walk up
      // until something is free. Capture/profile harnesses that need a fixed
      // port pass `--port N --strictPort` themselves.
      port: Number(process.env.PORT) || 5173,
      strictPort: false,
      hmr: hmrEnabled ? undefined : false,
    },
    preview: {
      host: '127.0.0.1',
      port: Number(process.env.PREVIEW_PORT) || 4173,
      strictPort: false,
    },
    // Guarantee client-visible env even when import.meta.env was empty at start.
    define: {
      'import.meta.env.VITE_CONVEX_URL': JSON.stringify(convexUrl),
      'import.meta.env.VITE_CONVEX_SITE_URL': JSON.stringify(convexSite),
    },
    build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
    // Large binary game assets served verbatim.
    assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
  };
});
