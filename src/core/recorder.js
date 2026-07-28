/**
 * Local run recorder — canvas video + game audio, fixed for scrubbing on download.
 *
 * MediaRecorder WebM from Chrome cannot scrub (missing duration / cues). On
 * download we rewrite EBML headers with webm-duration-fix (no re-encode) and
 * report progress so the death card / menu can show a remux bar.
 */

import fixWebmDurationImport from 'webm-duration-fix';
// CJS/ESM interop: some bundlers nest `.default`.
const fixWebmDuration =
  typeof fixWebmDurationImport === 'function'
    ? fixWebmDurationImport
    : fixWebmDurationImport?.default;

function pickMime(wantAudio) {
  if (typeof MediaRecorder === 'undefined') return '';
  const withAudio = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const videoOnly = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  const types = wantAudio ? withAudio : videoOnly;
  for (const t of types) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function extFor(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  return 'webm';
}

function stampName(mime) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `grok-ops-run-${stamp}.${extFor(mime)}`;
}

export class RunRecorder {
  constructor() {
    this.canvas = null;
    /** @type {(() => MediaStream | null) | null} */
    this._audioStreamFn = null;
    this._rec = null;
    this._chunks = [];
    this._mime = '';
    this._startedAt = 0;
    this._mixedStream = null;
    /** Raw capture blob (may not scrub). */
    this._rawBlob = null;
    /** Seekable remux result, built on first download. */
    this._fixedBlob = null;
    this._fixing = false;
    /**
     * @type {{
     *   url: string,
     *   name: string,
     *   bytes: number,
     *   duration: number,
     *   mime: string,
     *   hasAudio: boolean,
     *   seekable: boolean,
     * } | null}
     */
    this.last = null;
    this.recording = false;
    this.supported =
      typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  /** @param {HTMLCanvasElement | null} canvas */
  setCanvas(canvas) {
    this.canvas = canvas;
  }

  /**
   * Lazy audio tap — usually mixer master → MediaStreamDestination.
   * @param {(() => MediaStream | null) | null} fn
   */
  setAudioStreamSource(fn) {
    this._audioStreamFn = fn;
  }

  /**
   * Begin capturing the canvas (+ game audio when available).
   * @param {{ fps?: number, bits?: number, audioBits?: number }} [opts]
   * @returns {boolean}
   */
  start(opts = {}) {
    if (!this.supported || !this.canvas || this.recording) return false;

    let videoStream;
    try {
      videoStream = this.canvas.captureStream(opts.fps ?? 30);
    } catch (err) {
      console.warn('[recorder] captureStream failed', err);
      return false;
    }
    const vTracks = videoStream.getVideoTracks?.() ?? [];
    if (!vTracks.length) return false;

    let audioStream = null;
    try {
      audioStream = this._audioStreamFn?.() ?? null;
    } catch (err) {
      console.warn('[recorder] audio tap failed', err);
    }
    const aTracks = audioStream?.getAudioTracks?.() ?? [];
    const hasAudio = aTracks.length > 0;

    const mixed = new MediaStream();
    for (const t of vTracks) mixed.addTrack(t);
    for (const t of aTracks) mixed.addTrack(t);
    this._mixedStream = mixed;

    const mime = pickMime(hasAudio);
    this._chunks = [];
    this._mime = mime || 'video/webm';
    this._rawBlob = null;
    this._fixedBlob = null;

    try {
      const init = {
        videoBitsPerSecond: opts.bits ?? 8_000_000,
        audioBitsPerSecond: opts.audioBits ?? 128_000,
      };
      if (mime) init.mimeType = mime;
      this._rec = new MediaRecorder(mixed, init);
      if (this._rec.mimeType) this._mime = this._rec.mimeType;
    } catch (err) {
      try {
        this._rec = new MediaRecorder(mixed, {
          videoBitsPerSecond: opts.bits ?? 8_000_000,
        });
        if (this._rec.mimeType) this._mime = this._rec.mimeType;
      } catch (err2) {
        console.warn('[recorder] MediaRecorder failed', err2);
        vTracks.forEach((t) => t.stop());
        this._mixedStream = null;
        return false;
      }
    }

    this._rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    this._rec.onerror = (e) => {
      console.warn('[recorder] error', e?.error ?? e);
    };

    try {
      this._rec.start(1000);
    } catch (err) {
      console.warn('[recorder] start failed', err);
      vTracks.forEach((t) => t.stop());
      this._rec = null;
      this._mixedStream = null;
      return false;
    }

    this.recording = true;
    this._startedAt = performance.now();
    this._hasAudio = hasAudio;
    console.info(
      `[recorder] started (${this._mime}${hasAudio ? ' +audio' : ' silent'})`
    );
    return true;
  }

  /**
   * Stop capture and keep a raw blob ready for remux-on-download.
   * @returns {Promise<object|null>}
   */
  async stop() {
    if (!this.recording || !this._rec) {
      this.recording = false;
      return this.last;
    }
    const rec = this._rec;
    const mime = this._mime || rec.mimeType || 'video/webm';
    const startedAt = this._startedAt;
    const hasAudio = !!this._hasAudio;
    this.recording = false;
    this._rec = null;

    const blob = await new Promise((resolve) => {
      const finish = () => {
        const parts = this._chunks.slice();
        this._chunks = [];
        // Only stop canvas capture tracks — audio belongs to the shared mixer tap.
        try {
          rec.stream?.getVideoTracks?.().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        this._mixedStream = null;
        if (!parts.length) {
          resolve(null);
          return;
        }
        resolve(new Blob(parts, { type: mime }));
      };
      rec.onstop = finish;
      try {
        if (rec.state === 'recording' || rec.state === 'paused') rec.stop();
        else finish();
      } catch {
        finish();
      }
    });

    if (!blob || blob.size < 64) {
      console.warn('[recorder] empty capture');
      return this.last;
    }

    this._revokeLastUrl();
    this._rawBlob = blob;
    this._fixedBlob = null;
    const duration = Math.max(0, (performance.now() - startedAt) / 1000);
    const url = URL.createObjectURL(blob);
    this.last = {
      url,
      name: stampName(mime),
      bytes: blob.size,
      duration,
      mime,
      hasAudio,
      seekable: false,
    };
    console.info(
      `[recorder] raw ${this.last.name} · ${(blob.size / 1e6).toFixed(1)} MB · ` +
        `${duration.toFixed(1)}s · ${hasAudio ? 'audio' : 'silent'} · remux on download`
    );
    return this.last;
  }

  /**
   * Remux WebM so players can scrub (EBML duration + cues). No re-encode.
   * @param {(p: number, label?: string) => void} [onProgress] 0..1
   * @returns {Promise<Blob>}
   */
  async prepareSeekable(onProgress) {
    if (this._fixedBlob) {
      onProgress?.(1, 'Ready');
      return this._fixedBlob;
    }
    const raw = this._rawBlob;
    if (!raw) throw new Error('No recording to prepare');

    // Fake smooth progress while the EBML rewrite runs (no real hooks in the lib).
    let p = 0.08;
    onProgress?.(p, 'Remuxing…');
    const tick = setInterval(() => {
      p = Math.min(0.9, p + 0.035 + Math.random() * 0.04);
      onProgress?.(p, 'Remuxing…');
    }, 120);

    try {
      let fixed;
      if (raw.type.includes('webm') || this.last?.mime?.includes('webm')) {
        fixed = await fixWebmDuration(raw);
      } else {
        // mp4 path — no EBML fix available; pass through.
        fixed = raw;
      }
      clearInterval(tick);
      onProgress?.(0.97, 'Finishing…');
      this._fixedBlob = fixed;
      if (this.last) {
        this.last.bytes = fixed.size;
        this.last.seekable = true;
        this.last.mime = fixed.type || this.last.mime;
        // Swap preview URL to seekable blob so in-page players scrub too.
        this._revokeLastUrl();
        this.last.url = URL.createObjectURL(fixed);
      }
      onProgress?.(1, 'Ready');
      console.info(
        `[recorder] remuxed ${(fixed.size / 1e6).toFixed(1)} MB (seekable)`
      );
      return fixed;
    } catch (err) {
      clearInterval(tick);
      console.warn('[recorder] remux failed, offering raw', err);
      onProgress?.(1, 'Raw (no scrub)');
      this._fixedBlob = raw;
      return raw;
    }
  }

  /**
   * Remux then trigger a browser download.
   * @param {(p: number, label?: string) => void} [onProgress]
   */
  async download(onProgress) {
    if (this._fixing) return;
    if (!this._rawBlob && !this._fixedBlob) throw new Error('Nothing to download');
    this._fixing = true;
    try {
      const blob = await this.prepareSeekable(onProgress);
      const name = this.last?.name || stampName(blob.type || 'video/webm');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }, 60_000);
    } finally {
      this._fixing = false;
    }
  }

  _revokeLastUrl() {
    if (this.last?.url) {
      try {
        URL.revokeObjectURL(this.last.url);
      } catch {
        /* ignore */
      }
      this.last.url = '';
    }
  }

  _revokeLast() {
    this._revokeLastUrl();
    this.last = null;
    this._rawBlob = null;
    this._fixedBlob = null;
  }

  dispose() {
    if (this.recording && this._rec) {
      try {
        this._rec.stop();
      } catch {
        /* ignore */
      }
    }
    this.recording = false;
    this._rec = null;
    this._chunks = [];
    this._revokeLast();
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n | 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
