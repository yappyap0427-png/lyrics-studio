/* ---------- karaoke microphone: your voice with echo and reverb ----------
   mic (no browser voice processing) → volume → dry + echo + reverb → limiter → headphones (only if asked) and the recorder
   The reverb's impulse response is generated here, so nothing has to be downloaded. */
class KaraokeMic {
  constructor() {
    this.ctx = null; this.on = false; this.monitor = false;
    this.vol = 1; this.echo = 0.3; this.reverb = 0.35;
    this.level = 0; this.loud = 0;
    this.onlevel = null; this.onfeedback = null; this.onchange = null;
  }
  async enable() {
    if (this.on) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('UNSUPPORTED'), { code: 'UNSUPPORTED' });
    // singing: echo cancellation, noise suppression and auto gain all make a voice sound worse and add delay
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 } });
    let ctx;
    try { ctx = new AudioContext({ latencyHint: 'interactive' }); } catch (e) { ctx = new AudioContext(); }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* resumes on the next click */ } }
    const src = ctx.createMediaStreamSource(stream);
    const input = ctx.createGain(); input.gain.value = this.vol;
    const delay = ctx.createDelay(1); delay.delayTime.value = 0.14;
    const fb = ctx.createGain(); fb.gain.value = 0.34;
    const echoTone = ctx.createBiquadFilter(); echoTone.type = 'lowpass'; echoTone.frequency.value = 3800; // each repeat a little darker, like a KTV echo
    const echoWet = ctx.createGain(); echoWet.gain.value = this.echo * 0.7;
    const conv = ctx.createConvolver(); conv.buffer = KaraokeMic.impulse(ctx, 2.4, 3.4);
    const revWet = ctx.createGain(); revWet.gain.value = this.reverb * 0.9;
    const sum = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.15;
    const monitorGain = ctx.createGain(); monitorGain.gain.value = 0; // silent until you say you have headphones on
    const recDest = ctx.createMediaStreamDestination();
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    src.connect(input); input.connect(analyser);
    input.connect(sum);
    input.connect(delay); delay.connect(echoTone); echoTone.connect(fb); fb.connect(delay); echoTone.connect(echoWet); echoWet.connect(sum);
    input.connect(conv); conv.connect(revWet); revWet.connect(sum);
    sum.connect(limiter);
    limiter.connect(monitorGain); monitorGain.connect(ctx.destination);
    limiter.connect(recDest);
    Object.assign(this, { ctx, stream, input, echoWet, revWet, monitorGain, recDest, analyser, on: true, monitor: false, loud: 0 });
    stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => this.disable()));
    const buf = new Float32Array(analyser.fftSize);
    this.meterTimer = setInterval(() => this.meter(buf), 100);
    if (this.onchange) this.onchange();
  }
  /* a decaying burst of noise is a convincing room */
  static impulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate, n = Math.max(1, Math.floor(rate * seconds)), pre = Math.floor(rate * 0.018);
    const buf = ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const k = (i - pre) / (n - pre);
        lp += ((Math.random() * 2 - 1) - lp) * (0.55 - 0.4 * k); // the tail loses its highs as it fades
        d[i] = lp * Math.pow(1 - k, decay);
      }
    }
    return buf;
  }
  /* level for the meter, and a guard against feedback: with speakers the voice comes back into the mic and swells */
  meter(buf) {
    if (!this.on) return;
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
    const rms = Math.sqrt(sum / buf.length);
    this.level = rms;
    if (this.monitor && rms > KaraokeMic.FEEDBACK_RMS) {
      this.loud += 0.1;
      if (this.loud >= 1) { this.setMonitor(false); if (this.onfeedback) this.onfeedback(); }
    } else this.loud = Math.max(0, this.loud - 0.05);
    if (this.onlevel) this.onlevel(rms, peak);
  }
  setMonitor(on) {
    this.monitor = !!on && this.on; this.loud = 0;
    if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(this.monitor ? 1 : 0, this.ctx.currentTime, 0.02);
    if (this.onchange) this.onchange();
  }
  set(name, v) {
    v = clamp(+v || 0, 0, name === 'vol' ? 2 : 1);
    this[name] = v;
    if (!this.on) return;
    const t = this.ctx.currentTime;
    if (name === 'vol') this.input.gain.setTargetAtTime(v, t, 0.02);
    if (name === 'echo') this.echoWet.gain.setTargetAtTime(v * 0.7, t, 0.03);
    if (name === 'reverb') this.revWet.gain.setTargetAtTime(v * 0.9, t, 0.03);
  }
  /* the processed voice, for the recorder */
  get track() { return this.on ? this.recDest.stream.getAudioTracks()[0] : null; }
  disable() {
    if (!this.on) return;
    clearInterval(this.meterTimer);
    try { this.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    try { this.ctx.close(); } catch (e) { /* ignore */ }
    this.on = false; this.monitor = false; this.level = 0; this.ctx = null;
    if (this.onlevel) this.onlevel(0, 0);
    if (this.onchange) this.onchange();
  }
}
KaraokeMic.FEEDBACK_RMS = 0.45; // about −7 dBFS held for a second: louder than singing into a mic, typical of a howl
