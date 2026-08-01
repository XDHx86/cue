// AudioCapture — shared renderer-side audio capture pipeline.
//
// Encapsulates the AudioContext + AudioWorklet + resampling flow so mic and system-audio
// capture share one implementation (previously duplicated inline in renderer.js). The
// resampler (src/resample.js, loaded via <script> before this file) is the safety net for
// platforms where AudioContext({sampleRate:16000}) falls back to 44100/48000 Hz.
//
// Renderer-context only (uses AudioContext/AudioWorkletNode/MediaStream). Pure browser
// script exposing a global `AudioCapture`; no module system, no Node require.

class AudioCapture {
  // opts: { targetRate (default 16000), onPcm(buffer) (required), log(msg) }
  constructor({ targetRate = 16000, onPcm, log }) {
    if (typeof onPcm !== 'function') throw new Error('AudioCapture requires onPcm callback');
    this.targetRate = targetRate;
    this.onPcm = onPcm;
    this.log = log || (() => {});
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.proc = null;
    this.sink = null;
    this._warnedResample = false;
  }

  // Start capture. `mediaFactory` returns a Promise<MediaStream> — invoked synchronously on
  // entry so getUserMedia/getDisplayMedia runs in the caller's user gesture (system loopback
  // requires a fresh gesture on some platforms).
  async start(mediaFactory) {
    if (this.stream) return;
    try {
      const stream = await mediaFactory();
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        stream.getTracks().forEach((t) => t.stop());
        this.log('audio-capture: no audio track in stream');
        return;
      }
      this.stream = stream;

      this.ctx = new AudioContext({ sampleRate: this.targetRate });
      const actual = this.ctx.sampleRate;
      if (actual !== this.targetRate && !this._warnedResample) {
        this.log('audio-capture: AudioContext sample rate ' + actual + 'Hz (requested ' + this.targetRate +
          'Hz) — resampling PCM before upload');
        this._warnedResample = true;
      }

      await this.ctx.audioWorklet.addModule('./pcm-processor.js');
      this.source = this.ctx.createMediaStreamSource(new MediaStream(tracks));
      this.proc = new AudioWorkletNode(this.ctx, 'pcm-processor');
      this.proc.port.onmessage = (e) => this._deliver(e.data);
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0; // run processor silently
      this.source.connect(this.proc);
      this.proc.connect(this.sink);
      this.sink.connect(this.ctx.destination);
    } catch (err) {
      this.log('audio-capture error: ' + (err && err.message));
      this.stop();
    }
  }

  // Resample if the context rate differs from the target, then deliver. Warns once per
  // capture instance (not per chunk) so the log isn't spammed at ~60 msg/s.
  _deliver(int16Buffer) {
    const actual = this.ctx && this.ctx.sampleRate;
    if (actual && actual !== this.targetRate) {
      try {
        int16Buffer = window.resampleToInt16(int16Buffer, actual, this.targetRate);
      } catch (e) {
        this.log('audio-capture: resample failed: ' + (e && e.message));
        return; // drop the chunk rather than send wrong-rate audio
      }
    }
    this.onPcm(int16Buffer);
  }

  stop() {
    if (this.proc) { this.proc.port.onmessage = null; try { this.proc.disconnect(); } catch {} this.proc = null; }
    if (this.source) { try { this.source.disconnect(); } catch {} this.source = null; }
    if (this.sink) { try { this.sink.disconnect(); } catch {} this.sink = null; }
    if (this.ctx) { try { this.ctx.close(); } catch {} this.ctx = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }
}

window.AudioCapture = AudioCapture;
