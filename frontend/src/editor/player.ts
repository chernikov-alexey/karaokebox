// Проигрыватель редактора: голос и минусовка вместе, с перемоткой и повтором фрагмента.
import { engine } from '../audio/engine';
import type { Region } from './model';

export class EditorPlayer {
  private voiceGain: GainNode;
  private minusGain: GainNode;
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0;
  private offset = 0;
  private loop: Region | null = null;
  playing = false;
  onStateChange: (() => void) | null = null;

  constructor(private vocals: AudioBuffer, private minus: AudioBuffer) {
    const ctx = engine.ctx;
    this.voiceGain = ctx.createGain();
    this.minusGain = ctx.createGain();
    this.voiceGain.connect(engine.master);
    this.minusGain.connect(engine.master);
  }

  get duration() {
    return this.vocals.duration;
  }

  get looping() {
    return this.loop;
  }

  get time() {
    if (!this.playing) return this.offset;
    const t = this.offset + engine.ctx.currentTime - this.startedAt;
    const loop = this.loop;
    if (loop && t >= loop.end) return loop.start + ((t - loop.end) % (loop.end - loop.start));
    if (t >= this.duration) {
      this.pause(this.duration);
      return this.duration;
    }
    return t;
  }

  setMix(voice: number, minus: number) {
    const now = engine.ctx.currentTime;
    this.voiceGain.gain.setTargetAtTime(voice, now, 0.02);
    this.minusGain.gain.setTargetAtTime(minus, now, 0.02);
  }

  play(from = this.time, loop: Region | null = null) {
    this.stopSources();
    const ctx = engine.wake();
    const start = loop && (from < loop.start || from >= loop.end) ? loop.start : Math.max(0, Math.min(from, this.duration - 0.01));
    this.loop = loop;
    this.offset = start;
    this.startedAt = ctx.currentTime + 0.02;
    this.sources = [[this.vocals, this.voiceGain], [this.minus, this.minusGain]].map(([buffer, gain]) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer as AudioBuffer;
      if (loop) {
        s.loop = true;
        s.loopStart = loop.start;
        s.loopEnd = loop.end;
      }
      s.connect(gain as GainNode);
      s.start(this.startedAt, start);
      return s;
    });
    this.playing = true;
    this.onStateChange?.();
  }

  pause(at?: number) {
    const t = at ?? this.time;
    this.stopSources();
    this.playing = false;
    this.loop = null;
    this.offset = t;
    this.onStateChange?.();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const clamped = Math.max(0, Math.min(this.duration, t));
    if (this.playing) this.play(clamped, this.loop && clamped >= this.loop.start && clamped < this.loop.end ? this.loop : null);
    else {
      this.offset = clamped;
      this.onStateChange?.();
    }
  }

  private stopSources() {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch { /* не запускался */ }
      s.disconnect();
    });
    this.sources = [];
  }

  dispose() {
    this.stopSources();
    this.playing = false;
    this.voiceGain.disconnect();
    this.minusGain.disconnect();
  }
}

// Пики громкости голоса с шагом 10 мс — для рисования волны.
export const PEAKS_PER_SEC = 100;

export function computePeaks(buffer: AudioBuffer) {
  const block = Math.floor(buffer.sampleRate / PEAKS_PER_SEC);
  const count = Math.ceil(buffer.length / block);
  const peaks = new Float32Array(count);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < count; i++) {
      let max = peaks[i];
      const end = Math.min(data.length, (i + 1) * block);
      for (let j = i * block; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
  }
  let top = 0;
  for (const p of peaks) if (p > top) top = p;
  if (top > 0) for (let i = 0; i < count; i++) peaks[i] /= top;
  return peaks;
}
