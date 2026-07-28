import { el, setText, setStyle, setClass, clamp, Pool, mmss } from './util.js';

const SPAN_DEG = 120; // degrees visible across the strip
const STRIP_W = 470; // css px at k=1, must match .ow-compass width
const PPD = STRIP_W / SPAN_DEG;
const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
/** Letter objectives + up to 3 squad allies. */
const COMPASS_SLOTS = 8;

/**
 * Heading strip, top centre.
 *
 * Ticks are laid out once across two full revolutions (0-720deg) with left
 * positions written as `calc(Npx * var(--k))`, so a resolution change re-scales
 * the whole strip with zero JS work. Only the strip's translateX is touched
 * per frame — one style write for 144 ticks.
 */
export class Compass {
  constructor(parent) {
    this.root = el('div', 'ow-compass', parent);
    this.strip = el('div', 'ow-compass-strip', this.root);
    el('div', 'ow-compass-base', this.root);
    el('div', 'ow-compass-caret', this.root);

    for (let a = 0; a < 720; a += 5) {
      const t = el('div', 'ow-tick' + (a % 15 === 0 ? ' maj' : ''), this.strip);
      t.style.left = `calc(${(a * PPD).toFixed(2)}px * var(--k))`;
      const c = CARD[a % 360];
      if (c) {
        const l = el('div', 'ow-tick-l' + (c.length > 1 ? ' sub' : ''), this.strip, c);
        l.style.left = `calc(${(a * PPD).toFixed(2)}px * var(--k))`;
      }
    }
    setStyle(this.strip, 'width', `calc(${(720 * PPD).toFixed(0)}px * var(--k))`);

    this.objPool = new Pool(
      COMPASS_SLOTS,
      () => el('div', 'ow-compass-obj'),
      this.root
    );

    this.k = 1;
    this._heading = 0;
  }

  /**
   * @param {number} heading degrees, 0 = north, clockwise
   * @param {Array} objectives [{ bearing:deg, label:'A', color, kind?:'friend' }]
   */
  update(heading, objectives) {
    this.k = this.k || 1;
    const k = this.k;
    const h = ((heading % 360) + 360) % 360;
    this._heading = h;
    const x = STRIP_W * 0.5 * k - (h + 360) * PPD * k;
    setStyle(this.strip, 'transform', `translateX(${x.toFixed(2)}px)`);

    const half = STRIP_W * 0.5 * k;
    const items = this.objPool.items;
    let n = 0;
    if (objectives) {
      for (let i = 0; i < objectives.length && n < items.length; i++) {
        const o = objectives[i];
        let rel = o.bearing - h;
        while (rel > 180) rel -= 360;
        while (rel < -180) rel += 360;
        const it = items[n++];
        if (!it.alive) {
          it.alive = true;
          setStyle(it.node, 'display', '');
        }
        const friend = o.kind === 'friend';
        const edge = friend ? 5 * k : 8 * k;
        const px = clamp(rel * PPD * k, -half + edge, half - edge);
        setClass(it.node, 'friend', friend);
        setText(it.node, friend ? '' : (o.label ?? ''));
        setStyle(it.node, 'left', '50%');
        setStyle(it.node, 'transform', `translateX(calc(-50% + ${px.toFixed(1)}px))`);
        setStyle(
          it.node,
          'background',
          o.color ?? (friend ? 'var(--friend)' : 'var(--cyan)')
        );
        setStyle(it.node, 'opacity', Math.abs(rel) > SPAN_DEG * 0.5 ? '0.45' : '1');
      }
    }
    for (let i = n; i < items.length; i++) {
      if (items[i].alive) {
        items[i].alive = false;
        setStyle(items[i].node, 'display', 'none');
      }
    }
  }

  setScale(k) {
    this.k = k;
  }

  dispose() {
    this.root.remove();
  }
}

/** Tiny SVG person (blue ally) — same language as the boot leaderboard. */
function personSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 16');
  svg.setAttribute('class', 'ow-match-ico ow-match-ico-ally');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(ns, 'circle');
  head.setAttribute('cx', '6');
  head.setAttribute('cy', '3.2');
  head.setAttribute('r', '2.4');
  const body = document.createElementNS(ns, 'path');
  body.setAttribute(
    'd',
    'M2.2 14.8 V9.2 C2.2 7.1 3.9 5.8 6 5.8 S9.8 7.1 9.8 9.2 V14.8'
  );
  svg.append(head, body);
  return svg;
}

/** Tiny SVG tombstone (fallen ally). */
function tombSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 16');
  svg.setAttribute('class', 'ow-match-ico ow-match-ico-tomb');
  svg.setAttribute('aria-hidden', 'true');
  const stone = document.createElementNS(ns, 'path');
  stone.setAttribute(
    'd',
    'M3.2 14.5 V6.2 C3.2 4.1 4.5 2.8 6 2.8 S8.8 4.1 8.8 6.2 V14.5'
  );
  const base = document.createElementNS(ns, 'rect');
  base.setAttribute('x', '2');
  base.setAttribute('y', '13.2');
  base.setAttribute('width', '8');
  base.setAttribute('height', '1.8');
  const crossV = document.createElementNS(ns, 'rect');
  crossV.setAttribute('x', '5.55');
  crossV.setAttribute('y', '5.2');
  crossV.setAttribute('width', '0.9');
  crossV.setAttribute('height', '4.2');
  const crossH = document.createElementNS(ns, 'rect');
  crossH.setAttribute('x', '4.2');
  crossH.setAttribute('y', '6.4');
  crossH.setAttribute('width', '3.6');
  crossH.setAttribute('height', '0.9');
  svg.append(stone, base, crossV, crossH);
  return svg;
}

function fmtScore(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toLocaleString('en-US');
}

/**
 * Slim scoreline under the compass.
 * Survival: squad icons (people / tombs) · running score · countdown.
 */
export class MatchBar {
  constructor(parent) {
    this.root = el('div', 'ow-match', parent);

    this.allies = el('div', 'ow-match-allies', this.root);
    this._allySlots = [];
    for (let i = 0; i < 3; i++) {
      const slot = el('span', 'ow-match-slot', this.allies);
      this._allySlots.push(slot);
    }
    this._allyAlive = -1;

    el('div', 'sep', this.root);
    this.scoreLbl = el('div', 'ow-match-score-lbl', this.root, 'SCORE');
    this.score = el('b', 'ow-match-score', this.root, '0');
    el('div', 'sep', this.root);
    this.clock = el('div', 'clock', this.root, '5:00');

    this._lastScore = -1;
    this._lastClock = '';
  }

  update(s) {
    const alive = Math.max(0, Math.min(3, Math.floor(s.alliesAlive ?? 0)));
    if (alive !== this._allyAlive) {
      this._allyAlive = alive;
      for (let i = 0; i < 3; i++) {
        const slot = this._allySlots[i];
        slot.replaceChildren(i < alive ? personSvg() : tombSvg());
      }
      this.allies.title =
        alive === 0
          ? 'Squad wiped · 1× score mult'
          : `${alive}/3 allies up · ${alive}× score mult`;
    }

    const score = s.score ?? s.scoreUs ?? 0;
    if (score !== this._lastScore) {
      this._lastScore = score;
      setText(this.score, fmtScore(score));
    }

    const clock = mmss(s.timeLeft ?? 0);
    if (clock !== this._lastClock) {
      this._lastClock = clock;
      setText(this.clock, clock);
    }
  }

  dispose() {
    this.root.remove();
  }
}
