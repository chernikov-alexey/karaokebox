// Определение высоты голоса с микрофона алгоритмом YIN.

const FFT_SIZE = 4096;
const WINDOW = 1024;
const F_MIN = 65;
const F_MAX = 1100;

export function freqToMidi(f: number) {
  return 69 + 12 * Math.log2(f / 440);
}

const NOTE_NAMES = ['До', 'До♯', 'Ре', 'Ре♯', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Соль♯', 'Ля', 'Ля♯', 'Си'];

export function noteName(midi: number) {
  const n = Math.round(midi);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// Расстояние между нотами без учёта октавы, в полутонах (-6..6).
export function pitchClassDiff(a: number, b: number) {
  const d = a - b;
  return d - 12 * Math.round(d / 12);
}

export class MicPitch {
  readonly source: MediaStreamAudioSourceNode;
  private analyser: AnalyserNode;
  private raw = new Float32Array(FFT_SIZE);
  private step: number;
  private rate: number;
  private tauMax: number;
  private tauMin: number;
  private buf: Float32Array;
  private diff: Float32Array;
  private recent: (number | null)[] = [];
  level = 0;
  private last: number | null = null;
  private readAt = -Infinity;

  constructor(ctx: AudioContext, readonly stream: MediaStream) {
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.source.connect(this.analyser);
    this.step = Math.max(1, Math.round(ctx.sampleRate / 24000));
    this.rate = ctx.sampleRate / this.step;
    this.tauMax = Math.floor(this.rate / F_MIN);
    this.tauMin = Math.floor(this.rate / F_MAX);
    this.buf = new Float32Array(WINDOW + this.tauMax);
    this.diff = new Float32Array(this.tauMax + 1);
  }

  // Задержка от пения до результата: половина окна анализа.
  get windowDelay() {
    return this.buf.length / this.rate / 2;
  }

  // Возвращает MIDI-ноту (дробную) или null, если голоса нет.
  // Повторный вызов в том же кадре (игра и индикатор уровня) отдаёт тот же результат.
  read(): number | null {
    const now = performance.now();
    if (now - this.readAt < 8) return this.last;
    this.readAt = now;
    this.last = this.analyse();
    return this.last;
  }

  private analyse(): number | null {
    this.analyser.getFloatTimeDomainData(this.raw);
    const { buf, step, raw } = this;
    const offset = raw.length - buf.length * step;
    let energy = 0;
    for (let i = 0; i < buf.length; i++) {
      let s = 0;
      for (let k = 0; k < step; k++) s += raw[offset + i * step + k];
      buf[i] = s / step;
      energy += buf[i] * buf[i];
    }
    this.level = Math.sqrt(energy / buf.length);
    const freq = this.level < 0.008 ? null : this.yin();
    const midi = freq ? freqToMidi(freq) : null;

    // медиана по трём кадрам убирает одиночные выбросы на октаву
    this.recent.push(midi);
    if (this.recent.length > 3) this.recent.shift();
    const voiced = this.recent.filter((m): m is number => m !== null).sort((a, b) => a - b);
    return midi === null || voiced.length < 2 ? midi : voiced[voiced.length >> 1];
  }

  private yin() {
    const { buf, diff, tauMin, tauMax } = this;
    let running = 0;
    let best = -1;
    let globalMin = Infinity;
    let globalTau = -1;
    diff[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < WINDOW; i++) {
        const d = buf[i] - buf[i + tau];
        sum += d * d;
      }
      running += sum;
      diff[tau] = running > 0 ? (sum * tau) / running : 1;
      if (tau < tauMin) continue;
      if (diff[tau] < globalMin) {
        globalMin = diff[tau];
        globalTau = tau;
      }
      if (best < 0 && diff[tau - 1] < 0.15 && diff[tau] > diff[tau - 1] && tau - 1 >= tauMin) {
        best = tau - 1;
        break;
      }
    }
    if (best < 0) {
      if (globalMin > 0.3) return null;
      best = globalTau;
    }
    let tau = best;
    if (best > 1 && best < tauMax) {
      const a = diff[best - 1], b = diff[best], c = diff[best + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) tau = best + (a - c) / (2 * denom);
    }
    return this.rate / tau;
  }

  stop() {
    this.source.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
  }
}
