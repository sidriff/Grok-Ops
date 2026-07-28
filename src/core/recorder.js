/**
 * Local run recorder — MediaRecorder on the game canvas.
 *
 * Opt-in from the title shell. Chunks stay in memory; on stop we build a Blob
 * and object URL for a same-page download link. Nothing leaves the machine.
 */

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
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
    this._rec = null;
    this._chunks = [];
    this._mime = '';
    this._startedAt = 0;
    /** @type {{ url: string, name: string, bytes: number, duration: number, mime: string } | null} */
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
   * Begin capturing the canvas. No-op if unsupported, already recording, or no canvas.
   * @param {{ fps?: number }} [opts]
   * @returns {boolean} true if recording started
   */
  start(opts = {}) {
    if (!this.supported || !this.canvas || this.recording) return false;
    const mime = pickMime();
    let stream;
    try {
      stream = this.canvas.captureStream(opts.fps ?? 30);
    } catch (err) {
      console.warn('[recorder] captureStream failed', err);
      return false;
    }
    if (!stream?.getTracks?.().length) return false;

    this._chunks = [];
    this._mime = mime || 'video/webm';
    try {
      const init = { videoBitsPerSecond: opts.bits ?? 8_000_000 };
      if (mime) init.mimeType = mime;
      this._rec = new MediaRecorder(stream, init);
      if (this._rec.mimeType) this._mime = this._rec.mimeType;
    } catch (err) {
      // Retry without an explicit mime — some builds reject the codec string.
      try {
        this._rec = new MediaRecorder(stream, { videoBitsPerSecond: opts.bits ?? 8_000_000 });
        if (this._rec.mimeType) this._mime = this._rec.mimeType;
      } catch (err2) {
        console.warn('[recorder] MediaRecorder failed', err2);
        stream.getTracks().forEach((t) => t.stop());
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
      // Timeslice so a crash mid-run still has partial chunks if we ever flush.
      this._rec.start(1000);
    } catch (err) {
      console.warn('[recorder] start failed', err);
      stream.getTracks().forEach((t) => t.stop());
      this._rec = null;
      return false;
    }

    this.recording = true;
    this._startedAt = performance.now();
    console.info(`[recorder] started (${this._mime})`);
    return true;
  }

  /**
   * Stop and promote the capture to `last` (downloadable blob URL).
   * Safe to call when not recording.
   * @returns {Promise<object|null>} last run meta or null
   */
  async stop() {
    if (!this.recording || !this._rec) {
      this.recording = false;
      return this.last;
    }
    const rec = this._rec;
    const mime = this._mime || rec.mimeType || 'video/webm';
    const startedAt = this._startedAt;
    this.recording = false;
    this._rec = null;

    const blob = await new Promise((resolve) => {
      const finish = () => {
        const parts = this._chunks.slice();
        this._chunks = [];
        // Stop capture tracks so the canvas isn't pinned.
        try {
          rec.stream?.getTracks?.().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
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

    this._revokeLast();
    const url = URL.createObjectURL(blob);
    const duration = Math.max(0, (performance.now() - startedAt) / 1000);
    this.last = {
      url,
      name: stampName(mime),
      bytes: blob.size,
      duration,
      mime,
    };
    console.info(
      `[recorder] saved ${this.last.name} · ${(blob.size / 1e6).toFixed(1)} MB · ${duration.toFixed(1)}s`
    );
    return this.last;
  }

  _revokeLast() {
    if (this.last?.url) {
      try {
        URL.revokeObjectURL(this.last.url);
      } catch {
        /* ignore */
      }
    }
    this.last = null;
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
  if (n < 1024) return `${n|0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
