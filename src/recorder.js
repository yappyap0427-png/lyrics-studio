/* ---------- recorder: the canvas itself + optional shared audio / microphone ----------
   states: idle → ready (permissions granted, countdown running) → recording ⇄ paused → idle
   WebM arrives in 1 s chunks while recording. Chrome's MP4 writer hands everything over only at the end,
   so for MP4 the size is estimated from the bitrate, and an empty file can only be caught after stopping.
   A recording is made of segments: split() closes the current file and starts the next one on the same
   picture and sound, so a playlist can become one file per song without asking for permissions again. */
class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.seg = null; this.cleanup = []; this.bytes = 0; this.segCount = 0;
    this.state = 'idle';
    this.onstate = null; this.onwarn = null; this.onsegment = null;
    this.maxBytes = 1.5 * 1024 * 1024 * 1024; // the recording lives in memory until saved
    this.activeMs = 0; this.resumedAt = 0; this.warnedSize = false; this.bps = 0; this.streaming = false;
  }
  get active() { return this.state === 'recording' || this.state === 'paused'; }
  get busy() { return this.state !== 'idle'; }
  get mr() { return this.seg ? this.seg.mr : null; }
  static mime(withAudio, format = 'auto') {
    const mp4 = withAudio
      ? ['video/mp4;codecs=avc1.64002a,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.64002a,opus', 'video/mp4;codecs=avc1,opus']
      : ['video/mp4;codecs=avc1.64002a', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d002a', 'video/mp4;codecs=avc1', 'video/mp4'];
    const webm = withAudio ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const list = format === 'webm' ? webm : mp4.concat(webm);
    return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  /* step 1 — must be called straight from a click: getDisplayMedia needs the user gesture */
  async prepare({ audio = 'none', fps = 60, bitrate = 12e6, preferTab = false, format = 'auto', micTrack = null } = {}) {
    if (this.busy) throw Object.assign(new Error('BUSY'), { code: 'BUSY' });
    if (!window.MediaRecorder || !this.canvas.captureStream) throw Object.assign(new Error('UNSUPPORTED'), { code: 'UNSUPPORTED' });
    this.state = 'ready';
    const streams = [];
    this.cleanup = [];
    try {
      if (audio === 'system' || audio === 'both') {
        const ds = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 5 },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
          systemAudio: 'include', selfBrowserSurface: 'include', surfaceSwitching: 'exclude', preferCurrentTab: preferTab,
        });
        this.cleanup.push(() => ds.getTracks().forEach(t => t.stop()));
        const at = ds.getAudioTracks();
        if (!at.length) throw Object.assign(new Error('NO_SHARED_AUDIO'), { code: 'NO_SHARED_AUDIO' });
        ds.getVideoTracks().forEach(t => t.addEventListener('ended', () => this.stop('ended')));
        streams.push(new MediaStream(at));
      }
      if (audio === 'mic' || audio === 'both') {
        if (micTrack && micTrack.readyState === 'live') streams.push(new MediaStream([micTrack])); // the karaoke mic, with its echo; it stays on after recording
        else {
          const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
          this.cleanup.push(() => ms.getTracks().forEach(t => t.stop()));
          streams.push(ms);
        }
      }
      const v = this.canvas.captureStream(fps);
      this.cleanup.push(() => v.getTracks().forEach(t => t.stop()));
      let audioTracks = [];
      if (streams.length === 1) audioTracks = streams[0].getAudioTracks();
      else if (streams.length > 1) {
        const ac = new AudioContext();
        const dest = ac.createMediaStreamDestination();
        for (const s of streams) ac.createMediaStreamSource(s).connect(dest);
        this.cleanup.push(() => ac.close());
        audioTracks = dest.stream.getAudioTracks();
      }
      const mix = new MediaStream([...v.getVideoTracks(), ...audioTracks]);
      const mime = Recorder.mime(audioTracks.length > 0, format);
      const opts = { videoBitsPerSecond: bitrate };
      if (mime) opts.mimeType = mime;
      if (audioTracks.length) opts.audioBitsPerSecond = 192000;
      this.mix = mix; this.mrOpts = opts;
      this.seg = this.makeSeg();
      this.bps = bitrate + (audioTracks.length ? 192000 : 0);
      this.mime = this.seg.mr.mimeType || mime || 'video/webm';
      this.streaming = /webm/i.test(this.mime);
      this.hasAudio = audioTracks.length > 0;
    } catch (e) {
      this.seg = null; this.release(); this.state = 'idle';
      throw e;
    }
  }
  makeSeg(meta = null) {
    const mr = new MediaRecorder(this.mix, this.mrOpts);
    const seg = { mr, chunks: [], bytes: 0, meta, elapsed: 0, split: false };
    mr.ondataavailable = ev => this.onData(ev, seg);
    mr.onstop = () => this.onSegStop(seg);
    mr.onerror = ev => { console.error(ev); toast('錄影出錯：' + ((ev.error && ev.error.message) || '未知錯誤'), 0); };
    return seg;
  }
  /* step 2 — after the countdown; meta travels with the file (which song it was) */
  begin(meta = null) {
    if (this.state !== 'ready' || !this.seg) return;
    this.seg.meta = meta;
    this.bytes = 0; this.warnedSize = false; this.discard = false; this.stopReason = null; this.segCount = 1;
    this.activeMs = 0; this.resumedAt = performance.now();
    this.seg.mr.start(1000);
    this.state = 'recording';
    clearTimeout(this.healthTimer); clearInterval(this.sizeTimer);
    if (this.streaming) this.healthTimer = setTimeout(() => this.checkHealth(), 4200);
    this.sizeTimer = setInterval(() => this.checkSize(), 1000);
    if (this.onstate) this.onstate('recording');
  }
  async start(opts, meta) { await this.prepare(opts); this.begin(meta); } // no countdown
  /* close this file and go straight on into a new one */
  split(meta = null) {
    if (!this.active || !this.seg) return false;
    const old = this.seg;
    let seg;
    try { seg = this.makeSeg(meta); seg.mr.start(1000); if (this.state === 'paused') seg.mr.pause(); } catch (e) { return false; }
    old.split = true; old.elapsed = this.elapsed();
    this.seg = seg; this.segCount++;
    this.bytes = 0; this.warnedSize = false;
    this.activeMs = 0; this.resumedAt = performance.now();
    try { old.mr.stop(); } catch (e) { /* already stopped */ }
    return true;
  }
  cancel() {
    if (this.state !== 'ready') return;
    this.seg = null; this.release(); this.state = 'idle';
    clearTimeout(this.healthTimer); clearInterval(this.sizeTimer);
    if (this.onstate) this.onstate('idle');
  }
  pause() {
    if (this.state !== 'recording') return;
    this.seg.mr.pause();
    this.activeMs += performance.now() - this.resumedAt;
    this.state = 'paused';
    if (this.onstate) this.onstate('paused');
  }
  resume() {
    if (this.state !== 'paused') return;
    this.seg.mr.resume();
    this.resumedAt = performance.now();
    this.state = 'recording';
    if (this.onstate) this.onstate('recording');
  }
  stop(reason = 'user') {
    if (this.state === 'ready') { this.cancel(); return; }
    if (!this.active || !this.seg || this.seg.mr.state === 'inactive') return;
    this.stopReason = this.stopReason || reason;
    clearTimeout(this.healthTimer); clearInterval(this.sizeTimer);
    this.seg.elapsed = this.stoppedAt = this.elapsed();
    this.seg.mr.stop();
  }
  elapsed() {
    if (this.state === 'recording') return (this.activeMs + performance.now() - this.resumedAt) / 1000;
    if (this.state === 'paused') return this.activeMs / 1000;
    return 0;
  }
  onData(ev, seg = this.seg) {
    if (!ev.data || !ev.data.size || !seg) return;
    seg.chunks.push(ev.data);
    seg.bytes += ev.data.size;
    if (seg === this.seg) this.bytes = seg.bytes;
  }
  /* bytes held so far: counted for WebM, estimated from the bitrate (an upper bound) for MP4 */
  size() { return this.streaming ? this.bytes : Math.round(this.elapsed() * this.bps / 8); }
  checkSize() {
    if (!this.active) return;
    const n = this.size();
    if (!this.warnedSize && n > this.maxBytes * 0.85) { this.warnedSize = true; if (this.onwarn) this.onwarn('NEAR_LIMIT'); }
    if (n >= this.maxBytes) this.stop('limit');
  }
  /* some encoder/driver combinations claim support but write next to nothing: with WebM this shows within seconds */
  checkHealth() {
    if (this.state === 'paused') { this.healthTimer = setTimeout(() => this.checkHealth(), 2000); return; }
    if (this.state !== 'recording') return;
    if (this.bytes < 16 * 1024) { this.discard = true; this.stop('empty'); if (this.onwarn) this.onwarn('EMPTY'); }
  }
  release() { for (const f of this.cleanup.splice(0)) { try { f(); } catch (e) { /* ignore */ } } }
  onSegStop(seg) {
    const type = String(this.mime).split(';')[0] || 'video/webm';
    if (seg.split) { // one song finished while the recording goes on
      let blob = new Blob(seg.chunks, { type }), reason = 'split';
      seg.chunks = [];
      if (seg.elapsed < 2) { blob = null; reason = 'short'; } // skipped past: not worth a file
      else if (blob.size < 16 * 1024 && seg.elapsed >= 3) { blob = null; reason = 'empty'; if (this.onwarn) this.onwarn('EMPTY'); }
      if (this.onsegment) this.onsegment(blob, type, seg.meta, reason);
      return;
    }
    let blob = this.discard ? null : new Blob(seg.chunks, { type });
    let reason = this.stopReason || 'user';
    // an MP4 that comes back nearly empty after several seconds: same failure, found at the end
    const empty = blob && blob.size < 16 * 1024 && (seg.elapsed || 0) >= 3;
    if (empty) { blob = null; reason = 'empty'; }
    else if (blob && this.segCount > 1 && seg.elapsed < 2) { blob = null; reason = 'short'; } // stopped right after a song change
    seg.chunks = []; this.seg = null; this.discard = false; this.stopReason = null; this.stoppedAt = 0;
    this.state = 'idle';
    clearTimeout(this.healthTimer); clearInterval(this.sizeTimer);
    this.release(); // stops the microphone / screen share so the browser's recording indicator goes away
    if (this.onstate) this.onstate('idle', blob, type, reason, seg.meta);
    if (empty && this.onwarn) this.onwarn('EMPTY');
  }
}
