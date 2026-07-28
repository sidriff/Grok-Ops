# Grok Ops

### Five Minute Firefight

**Grok Ops** is a [fork](https://github.com/sidriff/Grok-Ops) of the
one-shot [Claude of Duty](https://github.com/mshumer/Claude-of-Duty) by
[@mattshumer_](https://x.com/mattshumer_).
The scaffold was really impressive. But a lot of it was DOA when I tried to play it.

I was able to refine it with **Grok** and my experience as a game designer.
After spending 5 hours making small iterative changes, I feel pretty confident that
the Bitter Lesson doesn’t apply to game design. Yet.

— [@sidriff](https://x.com/sidriff)

## Deploy

```bash
bun install
bun run dev          # http://127.0.0.1:5173 (or next free port; HMR off — refresh for changes)
OW_HMR=1 bun run dev # optional: classic Vite hot reload
```

Click the canvas to lock the cursor. WASD move, mouse aim, LMB fire, RMB ADS,
R reload, Shift sprint, Ctrl crouch, Space jump, Q/E lean, Esc pause / release.

**Graphics:** GPU auto-detect picks `low|medium|high` (auto never selects ultra).
Force a tier with `?q=low|medium|high|ultra`. Capture mode (`?capture=1`) still
defaults to ultra. Console: `[grok-ops] quality=…` · `window.__GPU__`.

## The fight

**Survival** (default): you + three blue operators. Red hostiles spawn up to 12
at a time for 5:00. Soft early, hard after ~1:00, then refills almost as fast as
they drop. Die once → death cam + score + **Retry** / **Retreat**. Hold the
clock → mission complete. Optional leaderboard via X on the title shell.

## What this fork ships

Priorities in order — product first, then feel, then AI that actually fights.

A lot of the upstream scaffold *looked* finished: systems, banks, hooks, whole
subsystems with names that promised a working game. In practice a surprising
amount was DOA — present in the tree, never called, half-wired, or broken on the
first real round. That is not a dunk on the one-shot; it is the usual gap
between “generated” and “ships.” Most of the list below is either new product,
or bringing dead code to life until the fight holds up.

### Product
- **Survival mode** — 5:00 hold, squad of three, wave hostiles (max 12), live score bar, Retry / Retreat (not fake TDM)
- **Soft retreat** — back to the title shell without a full reload; Deploy starts a new run with assets warm
- **Leaderboard path** — Convex board + popup X login so the game never unloads
- **Team kit** — cool blue-grey friendlies vs warm sand/mud OPFOR, hover nameplates, team-aware ballistics

### Feel
- **Death** — death flow was effectively dead; camera, killer-tracking overhead, ragdoll corpse, clear kill frame
- **Safe spawns** — score against enemy LOS, facing, and proximity; re-aim into open space / threats (not walls or iron sights)
- **Health regen** — path existed but never recovered you in a live run; wired and tuned
- **Ragdolls that settle** — joint welds, mass/damping, despawn after 30s (no rubber-hose yard sale)
- **Shootable world** — flimsy props break and clear cover; fuel/metal cook off and can chain
- **Optic / tracers / audio** — tight red-dot pin, world-space tracer ribbons, dry gun crack (less gym reverb), blast-limited tinnitus, voice budgets that don’t melt Web Audio

### AI / VO
- **VO bank live** — full spot / flank / grenade / reload / copy bank was already in-tree; nothing fired it. Lines now play; alert hunts last-known
- **Hostiles advance** — no cover no longer means permanent turret; re-pick after camping; freeze when time is scaled out on the menu
- **Prewarm cleanup** — staged compile hostiles despawn before Deploy (no mannequin on your forehead)
- **Event / fire fixes** — nested damage no longer kills the bus; AI shots don’t kick the player reticle; live fire after prewarm actually runs

### Boot · menu · music
- Instant **Operator Briefing** shell — paints before any game module loads. One layout from first frame: blurb, progress, graphics (or weapons after Load), controls, settings, leaderboard, CTA. No black void, no “phase swap” jank.
- **Load → prewarm → Deploy** — pick a quality tier with plain-English cards, then build the AO while you fiddle sens / FOV / invert / volume. Esc reopens the **same shell** as pause / Resume; Retreat returns here without a full reload.
- **Procedural menu music** (`src/audio/menu.js`) — no sample packs. Sparse ~68 BPM A-minor “ops room” bed: low drone, soft air noise, a handful of dry motif notes. Intentionally understated so UI clicks have space. Starts on title load so a cold boot **proves the app has sound** (gesture unlock if the browser blocks autoplay).
- **UI beeps** from the same synth — click / select / confirm (short rising triad for Load · Deploy · Resume), open/close swells, soft slider ticks. Master volume is shared with the in-game mixer.

### Perf
- GPU auto-quality with **ultra opt-in only**
- Low-tier hitch work: fixed light ballast (no recompile thrash), prepass restored (no whiteout fog), GC / alloc cuts, prewarm biased to move mid-fight shader compiles into boot
- HMR off by default (`OW_HMR=1` to opt in)

### Identity
- Grok Ops branding + title blurb as a human–AI iteration demo
- Bun as the package manager

Engine ownership rules and subsystem map live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Lineage

Upstream built ~55k lines across 11 subsystems with no external art assets.
Their README is worth reading for the architecture and the honest self-score.
Credit for the scaffold stays with [mshumer/Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty).

## License

Same as upstream (ISC) unless noted.
