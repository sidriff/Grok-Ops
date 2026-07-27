# Grok Ops

A five-minute gunfight you can actually play.

Fork of [Claude of Duty](https://github.com/mshumer/Claude-of-Duty) (mshumer) — browser FPS, Three.js, procedural everything. Same scaffold; different mission. We are not chasing Call of Duty screenshots. We want a short, sharp firefight that feels good on real hardware.

## Run

```bash
bun install
bun run dev          # http://127.0.0.1:5173 (or next free port; HMR off — refresh for changes)
OW_HMR=1 bun run dev # optional: classic Vite hot reload
```

Click the canvas to lock the cursor. WASD move, mouse aim, LMB fire, RMB ADS,
R reload, Shift sprint, Ctrl crouch, Space jump, Q/E lean, Esc release.

**Graphics:** boots with GPU auto-detect (`src/core/gpu.js`) and picks
`low|medium|high` (auto never selects ultra) plus a max device-pixel-ratio for
that tier. Force a tier with `?q=low|medium|high|ultra`. Capture mode
(`?capture=1`) still defaults to ultra for baselines. Open the console for
`[grok-ops] quality=…` and inspect `window.__GPU__`.

## North star

1. **Actually fun for five minutes** — one clear combat loop.
2. **Stable frame time and audio** — no hang-and-glitch firefights.
3. **Honest scope** — browser FPS craft, not AAA cosplay.

## Upstream

Upstream built ~55k lines across 11 subsystems with no external art assets.
Their README is worth reading for the architecture and the honest self-score.
This fork changes defaults and gameplay direction; credit for the engine
scaffold stays with the original project.

## License

Same as upstream (ISC) unless noted.
