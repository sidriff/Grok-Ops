import { defineConfig } from 'vite';

// Grok Ops prewarm is tens of seconds. Auto HMR (or the full-page reload
// fallback) mid-boot / mid-fight is pure pain: you lose pointer lock, audio
// context, and wait for prewarm again. Default = no client reload; Vite still
// watches the disk so a manual refresh picks up the latest modules.
//
// Opt back into HMR with OW_HMR=1. Capture tools set OW_NO_HMR=1 (same outcome).
const hmrEnabled = Boolean(process.env.OW_HMR) && !process.env.OW_NO_HMR;

export default defineConfig({
  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: hmrEnabled ? undefined : false,
  },
  preview: { host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});
