/* ---------- recorder: the canvas itself + optional shared audio / microphone ---------- */
class Recorder {
  constructor(canvas) { this.canvas = canvas; this.mr = null; this.cleanup = []; this.t0 = 0; this.onstate = null; this.chunks = []; }
  get active() { return !!this.mr && this.mr.state !== 'inactive'; }
  static mime(withAudio) {
    const list = withAudio
      ? ['video/mp4;codecs=avc1.64002a,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc1.64002a,opus', 'video/mp4;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/mp4;codecs=avc1.64002a', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d002a', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }
  /* must be called straight from a click: getDisplayMedia needs the user gesture */
  async start({ audio = 'none', fps = 60, bitrate = 12e6, preferTab = false } = {}) {
    if (this.active) return;
    if (!window.MediaRecorder || !this.canvas.captureStream) throw Object.assign(new Error('UNSUPPORTED'), { code: 'UNSUPPORTED' });
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
        ds.getVideoTracks().forEach(t => t.addEventListener('ended', () => this.stop()));
        streams.push(new MediaStream(at));
      }
      if (audio === 'mic' || audio === 'both') {
        const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
        this.cleanup.push(() => ms.getTracks().forEach(t => t.stop()));
        streams.push(ms);
      }
    } catch (e) { this.release(); throw e; }

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
    const mime = Recorder.mime(audioTracks.length > 0);
    const opts = { videoBitsPerSecond: bitrate };
    if (mime) opts.mimeType = mime;
    if (audioTracks.length) opts.audioBitsPerSecond = 192000;
    let mr;
    try { mr = new MediaRecorder(mix, opts); } catch (e) { this.release(); throw e; }
    this.mime = mr.mimeType || mime || 'video/webm';
    this.chunks = [];
    this.mr = mr;
    mr.ondataavailable = ev => { if (ev.data && ev.data.size) this.chunks.push(ev.data); };
    mr.onstop = () => this.finish();
    mr.onerror = ev => { console.error(ev); toast('錄影出錯：' + ((ev.error && ev.error.message) || '未知錯誤'), 6000); };
    mr.start(1000);
    this.t0 = performance.now();
    this.hasAudio = audioTracks.length > 0;
    if (this.onstate) this.onstate(true);
  }
  stop() { if (this.mr && this.mr.state !== 'inactive') this.mr.stop(); }
  release() { for (const f of this.cleanup.splice(0)) { try { f(); } catch (e) { /* ignore */ } } }
  finish() {
    const type = String(this.mime).split(';')[0] || 'video/webm';
    const blob = new Blob(this.chunks, { type });
    this.chunks = []; this.mr = null;
    this.release();
    if (this.onstate) this.onstate(false, blob, type);
  }
  elapsed() { return this.active ? (performance.now() - this.t0) / 1000 : 0; }
}
