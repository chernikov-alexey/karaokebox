// Игровой экран: минусовка, дорожка высоты голоса, текст и подсчёт попаданий.
import type { Line, Note, Song } from '../api';
import { engine } from '../audio/engine';
import { noteName, pitchClassDiff, type MicPitch } from '../audio/pitch';
import { getSettings } from '../settings';

export const PLAYER_COLORS = ['#22d3ee', '#f472b6'];
// Логическая высота сцены; ширина подстраивается под экран, но не меньше BASE_W.
const BASE_W = 1280;
const BASE_H = 720;
// Доля времени в ноте, которая даёт 100 баллов: согласные и вдохи не поются.
const FULL_SCORE_RATIO = 0.75;
const PREROLL = 2.5;
const FONT = '"Manrope Variable", "Manrope", system-ui, sans-serif';

const LANE = { top: 120, bottom: 390, nowX: 330, pxPerSec: 230 };
// Индикатор голоса: сглаживание высоты, удержание при коротких провалах и угасание после пения.
const PITCH_SMOOTH = 0.07; // постоянная времени сглаживания, с
const PITCH_HOLD = 0.18; // провал короче этого не рвёт линию
const PITCH_FADE = 0.45; // за это время кружок гаснет, когда голос пропал
const LYRIC_Y = [560, 640];

// Непрерывные участки следа (без пауз и резких скачков).
function runs<T extends { midi: number | null }>(trail: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const point of trail) {
    const prev = cur[cur.length - 1];
    if (point.midi === null || (prev && Math.abs(point.midi - prev.midi!) > 4)) {
      if (cur.length > 1) out.push(cur);
      cur = point.midi === null ? [] : [point];
    } else {
      cur.push(point);
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function scoreOf(hit: number, total: number) {
  return total > 0 ? Math.round(100 * Math.min(1, hit / total / FULL_SCORE_RATIO)) : 0;
}

export interface PlayerResult {
  name: string;
  color: string;
  score: number;
  accuracy: number;
  hitNotes: number;
  totalNotes: number;
}

interface Player {
  // null — микрофон выключен посреди песни: игрок остаётся в счёте, но не поёт
  mic: MicPitch | null;
  slot: number;
  color: string;
  name: string;
  hit: number;
  // время нот, пропетое при включённом микрофоне, — знаменатель оценки
  total: number;
  midi: number | null; // сглаженная высота для показа
  voicedAt: number; // когда последний раз был голос (время песни)
  glow: number; // видимость кружка 0..1
  // на паузе: какую ноту поёт игрок и насколько она далека от нужной (в полутонах, + — выше)
  hint: { name: string; diff: number } | null;
  trail: { t: number; midi: number | null; ok: boolean }[];
  bars: { note: number; t0: number; t1: number }[];
  noteHit: Float32Array;
}

interface Measure {
  text: string;
  full: number;
  spans: [number, number][];
}

export class Game {
  notes: Note[];
  readonly lines: Line[];
  duration: number;
  key: number;
  paused = false;
  finished = false;
  private players: Player[];
  private low: number;
  private high: number;
  private cursor = 0;
  private lastTime: number | null = null;
  private pausedAt: number | null = null;
  private lastFrame = 0;
  private wall = 0; // часы для сглаживания голоса на паузе, когда время песни стоит
  private sungUntil = 0;
  private sources: AudioBufferSourceNode[] = [];
  private startAt = 0;
  private measures = new Map<string, Measure>();
  private W = BASE_W;

  constructor(
    readonly song: Song,
    private minus: AudioBuffer,
    private vocals: AudioBuffer,
    mics: { mic: MicPitch; slot: number }[],
    key: number,
    private onFinish: (results: PlayerResult[]) => void,
  ) {
    this.lines = song.lyrics;
    this.duration = minus.duration;
    this.key = key;
    this.notes = [];
    this.low = 0;
    this.high = 0;
    this.applyKey(key);

    this.players = [];
    mics.forEach(({ mic, slot }) => this.addPlayer(mic, slot));

    this.play(-PREROLL);
  }

  private applyKey(key: number) {
    this.key = key;
    this.notes = this.song.noteList.map((n) => ({ ...n, midi: n.midi + key }));
    const sorted = this.notes.map((n) => n.midi).sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.02)] ?? 55;
    const hi = sorted[Math.floor(sorted.length * 0.98)] ?? 67;
    const pad = Math.max(3, (14 - (hi - lo)) / 2);
    this.low = Math.floor(lo - pad);
    this.high = Math.ceil(hi + pad);
  }

  // Запускает минусовку и голос с момента песни `from` (отрицательный — отсчёт до начала).
  private play(from: number) {
    this.stopSources();
    const ctx = engine.ctx;
    this.startAt = ctx.currentTime + 0.03 - from;
    this.sources = ([[this.minus, engine.music], [this.vocals, engine.guide]] as const).map(([buffer, bus]) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(bus);
      source.start(Math.max(ctx.currentTime, this.startAt), Math.max(0, from));
      return source;
    });
    this.lastTime = null;
    this.players.forEach((p) => {
      p.trail = [];
      p.bars = [];
    });
  }

  private stopSources() {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch { /* ещё не запущен */ }
      s.disconnect();
    });
    this.sources = [];
  }

  // Перемотка. Пропущенные места просто не идут в оценку.
  seek(t: number) {
    if (this.finished) return;
    const target = Math.max(-1, Math.min(this.duration - 0.5, t));
    if (this.paused) {
      // на паузе только переставляем позицию — музыка заиграет с неё после паузы
      this.pausedAt = target;
      this.players.forEach((p) => {
        p.trail = [];
        p.bars = [];
      });
      return;
    }
    this.play(target + (engine.ctx.outputLatency || 0));
  }

  // Другая тональность посреди песни: подменяем дорожки и продолжаем с того же места.
  setTrack(minus: AudioBuffer, vocals: AudioBuffer, key: number) {
    if (this.finished) return;
    const t = this.time;
    this.minus = minus;
    this.vocals = vocals;
    this.duration = minus.duration;
    this.applyKey(key);
    this.seek(t);
  }

  private addPlayer(mic: MicPitch, slot: number) {
    this.players.push({
      mic, slot, color: PLAYER_COLORS[slot], name: `Игрок ${slot + 1}`, hit: 0, total: 0, midi: null,
      voicedAt: -Infinity, glow: 0, hint: null, trail: [], bars: [], noteHit: new Float32Array(this.notes.length),
    });
    this.players.sort((a, b) => a.slot - b.slot);
  }

  // Микрофоны включили или выключили во время песни.
  setMics(mics: (MicPitch | null)[]) {
    mics.forEach((mic, slot) => {
      const player = this.players.find((p) => p.slot === slot);
      if (player) {
        player.mic = mic;
        if (!mic) {
          player.midi = null;
          player.glow = 0;
          player.trail = [];
        }
      } else if (mic) {
        this.addPlayer(mic, slot);
      }
    });
  }

  get playerCount() {
    return this.players.length;
  }

  // Время песни, которое сейчас слышит певец.
  get time() {
    if (this.pausedAt !== null) return this.pausedAt;
    const ctx = engine.ctx;
    return ctx.currentTime - this.startAt - (ctx.outputLatency || 0);
  }

  // Пауза останавливает только музыку: микрофон продолжает работать, чтобы на паузе можно было
  // проверить, какие ноты берёшь, и настроить микрофон и эффекты.
  togglePause() {
    if (this.finished) return;
    if (!this.paused) {
      this.pausedAt = this.time;
      this.stopSources();
      this.paused = true;
      this.lastFrame = 0;
      this.resetPitch();
    } else {
      const at = this.pausedAt ?? 0;
      this.paused = false;
      this.pausedAt = null;
      this.resetPitch();
      this.play(at + (engine.ctx.outputLatency || 0));
    }
  }

  private resetPitch() {
    this.players.forEach((p) => {
      p.midi = null;
      p.glow = 0;
      p.voicedAt = -Infinity;
      p.hint = null;
    });
  }

  stop() {
    if (this.finished) return;
    this.finished = true;
    this.stopSources();
  }

  finish() {
    if (this.finished) return;
    this.stop();
    this.onFinish(this.players.filter((p) => p.total > 0 || p.mic).map((p) => {
      let hitNotes = 0;
      let totalNotes = 0;
      this.notes.forEach((n, i) => {
        if (n.end > this.sungUntil) return;
        totalNotes++;
        if (p.noteHit[i] >= (n.end - n.start) * 0.5) hitNotes++;
      });
      return {
        name: p.name, color: p.color, score: scoreOf(p.hit, p.total),
        accuracy: p.total > 0 ? Math.round((100 * p.hit) / p.total) : 0,
        hitNotes, totalNotes,
      };
    }));
  }

  private noteAt(t: number) {
    const notes = this.notes;
    while (this.cursor < notes.length && notes[this.cursor].end < t) this.cursor++;
    while (this.cursor > 0 && notes[this.cursor - 1].end >= t) this.cursor--;
    const note = notes[this.cursor];
    return note && note.start <= t ? this.cursor : -1;
  }

  // Ближайшая по времени нота — к её октаве приводим голос для отображения.
  private referenceMidi(t: number) {
    const here = this.noteAt(t);
    if (here >= 0) return this.notes[here].midi;
    const next = this.notes[this.cursor];
    const prev = this.notes[this.cursor - 1];
    const dNext = next ? next.start - t : Infinity;
    const dPrev = prev ? t - prev.end : Infinity;
    if (Math.min(dNext, dPrev) > 3) return (this.low + this.high) / 2;
    return dNext < dPrev ? next.midi : prev.midi;
  }

  // Нота, к которой примеряется голос на паузе: та, что под курсором, или ближайшая следующая.
  private practiceTarget(t: number) {
    const here = this.noteAt(t);
    if (here >= 0) return here;
    const next = this.notes[this.cursor];
    return next && next.start > t ? this.cursor : -1;
  }

  // На паузе: голос слушаем и показываем, но в оценку он не идёт.
  private practice(t: number) {
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.25, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.wall += dt;
    const target = this.practiceTarget(t);
    const ref = target >= 0 ? this.notes[target].midi : (this.low + this.high) / 2;
    this.players.forEach((p) => {
      if (!p.mic) return;
      const midi = p.mic.read();
      const shown = midi === null ? null : midi + 12 * Math.round((ref - midi) / 12);
      this.smoothPitch(p, shown, this.wall, dt);
      if (midi !== null) {
        p.hint = { name: noteName(midi), diff: target >= 0 ? pitchClassDiff(this.notes[target].midi, midi) : NaN };
      } else if (p.glow < 0.05) {
        p.hint = null;
      }
    });
  }

  private update() {
    const t = this.time;
    if (this.finished) return t;
    if (this.paused) {
      this.practice(t);
      return t;
    }
    const dt = this.lastTime === null ? 0 : Math.min(0.25, Math.max(0, t - this.lastTime));
    this.lastTime = t;
    const { tolerance, micDelay } = getSettings();

    const sungUntil = t - micDelay;
    const inNote = dt > 0 && this.noteAt(sungUntil) >= 0;
    this.players.forEach((p) => {
      if (!p.mic) return;
      if (inNote) p.total += dt;
      const sung = t - micDelay - p.mic.windowDelay;
      const midi = p.mic.read();
      const index = this.noteAt(sung);
      let shown: number | null = null;
      let ok = false;
      if (midi !== null) {
        const ref = this.referenceMidi(sung);
        shown = midi + 12 * Math.round((ref - midi) / 12);
        ok = index >= 0 && Math.abs(pitchClassDiff(midi, this.notes[index].midi)) <= tolerance;
      }
      this.smoothPitch(p, shown, sung, dt);
      const held = p.midi !== null && sung - p.voicedAt <= PITCH_HOLD;
      p.trail.push({ t: sung, midi: held ? p.midi : null, ok });
      while (p.trail.length && p.trail[0].t < t - 2) p.trail.shift();
      if (ok && dt > 0) {
        p.hit += dt;
        p.noteHit[index] += dt;
        const last = p.bars[p.bars.length - 1];
        if (last && last.note === index && sung - dt - last.t1 < 0.05) last.t1 = sung;
        else p.bars.push({ note: index, t0: sung - dt, t1: sung });
      }
      while (p.bars.length && p.bars[0].t1 < t - 2) p.bars.shift();
    });

    this.sungUntil = sungUntil;

    if (t > this.duration + 0.8) this.finish();
    return t;
  }

  // Плавный индикатор: высота догоняет голос, короткие провалы удерживаются, кружок угасает.
  private smoothPitch(p: Player, shown: number | null, sung: number, dt: number) {
    if (shown !== null) {
      // после паузы или при скачке больше октавы — сразу на место, иначе догоняем
      if (p.midi === null || sung - p.voicedAt > PITCH_FADE || Math.abs(shown - p.midi) > 12) p.midi = shown;
      else p.midi += (shown - p.midi) * (1 - Math.exp(-dt / PITCH_SMOOTH));
      p.voicedAt = sung;
    }
    const silence = sung - p.voicedAt - PITCH_HOLD;
    const target = silence <= 0 ? 1 : Math.max(0, 1 - silence / PITCH_FADE);
    p.glow += (target - p.glow) * (1 - Math.exp(-dt / 0.06));
    if (p.glow < 0.01 && silence > 0) p.midi = null;
  }

  // Рисует кадр на холсте размером width×height (в физических пикселях).
  draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const t = this.update();
    const scale = width / height >= BASE_W / BASE_H ? height / BASE_H : width / BASE_W;
    this.W = width / scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, 0, (height - BASE_H * scale) / 2);

    // затемнение снизу и сверху, чтобы текст читался на любом видео
    const shade = ctx.createLinearGradient(0, 0, 0, BASE_H);
    shade.addColorStop(0, 'rgba(5,3,15,0.55)');
    shade.addColorStop(0.3, 'rgba(5,3,15,0)');
    shade.addColorStop(0.62, 'rgba(5,3,15,0)');
    shade.addColorStop(1, 'rgba(5,3,15,0.8)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, -BASE_H, this.W, BASE_H * 3);

    this.drawLane(ctx, t);
    this.drawLyrics(ctx, t);
    this.drawHud(ctx, t);
    // заставка с названием — только если текст появится позже неё (строки видны за 6 с до начала)
    if (t < 3.5 && (!this.lines.length || this.lines[0].start > 9.5)) this.drawTitle(ctx, t);
    return t;
  }

  private y(midi: number) {
    const clamped = Math.max(this.low, Math.min(this.high, midi));
    return LANE.bottom - ((clamped - this.low) / (this.high - this.low)) * (LANE.bottom - LANE.top);
  }

  private x(time: number, now: number) {
    return LANE.nowX + (time - now) * LANE.pxPerSec;
  }

  private drawLane(ctx: CanvasRenderingContext2D, t: number) {
    if (!this.notes.length) return;
    const W = this.W;
    const rowH = (LANE.bottom - LANE.top) / (this.high - this.low);
    const barH = Math.max(10, Math.min(18, rowH * 1.05));

    ctx.fillStyle = 'rgba(12, 8, 30, 0.5)';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(24, LANE.top - 26, W - 48, LANE.bottom - LANE.top + 52, 24);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let m = this.low; m <= this.high; m++) {
      if (((m % 12) + 12) % 12 === 0) ctx.fillRect(40, this.y(m) - 0.5, W - 80, 1);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(24, LANE.top - 26, W - 48, LANE.bottom - LANE.top + 52);
    ctx.clip();

    const from = t - LANE.nowX / LANE.pxPerSec - 0.2;
    const to = t + (W - LANE.nowX) / LANE.pxPerSec + 0.2;
    const split = this.players.length > 1;
    const current = this.paused ? this.practiceTarget(t) : this.noteAt(t);
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.end < from) continue;
      if (n.start > to) break;
      const x0 = this.x(n.start, t);
      const w = Math.max(6, (n.end - n.start) * LANE.pxPerSec);
      const y = this.y(Math.round(n.midi)) - barH / 2;
      ctx.fillStyle = n.end < t ? 'rgba(255,255,255,0.16)' : i === current ? '#ffffff' : 'rgba(226,220,255,0.78)';
      if (i === current) {
        ctx.shadowColor = 'rgba(255,255,255,0.8)';
        ctx.shadowBlur = 16;
      }
      ctx.beginPath();
      ctx.roundRect(x0, y, w, barH, barH / 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      this.players.forEach((p, k) => {
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 14;
        for (const bar of p.bars) {
          if (bar.note !== i) continue;
          const bx = Math.max(x0, this.x(bar.t0, t));
          const bw = Math.min(x0 + w, this.x(bar.t1, t)) - bx;
          if (bw <= 0) continue;
          ctx.beginPath();
          if (split) ctx.roundRect(bx, y + (k * barH) / 2, bw, barH / 2, barH / 4);
          else ctx.roundRect(bx, y, bw, barH, barH / 2);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      });
    }

    const nowGrad = ctx.createLinearGradient(0, LANE.top - 26, 0, LANE.bottom + 26);
    nowGrad.addColorStop(0, 'rgba(250,204,21,0)');
    nowGrad.addColorStop(0.5, 'rgba(250,204,21,0.95)');
    nowGrad.addColorStop(1, 'rgba(250,204,21,0)');
    ctx.fillStyle = nowGrad;
    ctx.fillRect(LANE.nowX - 1, LANE.top - 26, 2, LANE.bottom - LANE.top + 52);

    this.players.forEach((p) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 12;
      // след уходит влево и растворяется
      const fade = ctx.createLinearGradient(this.x(t - 1.8, t), 0, LANE.nowX, 0);
      fade.addColorStop(0, withAlpha(p.color, 0));
      fade.addColorStop(1, withAlpha(p.color, 1));
      ctx.strokeStyle = fade;
      for (const run of runs(p.trail)) {
        ctx.lineWidth = 5;
        ctx.globalAlpha = 0.45;
        this.strokeRun(ctx, run, t);
        // поверх — места, где голос попал в ноту
        ctx.lineWidth = 6;
        ctx.globalAlpha = 1;
        let from = -1;
        for (let i = 0; i <= run.length; i++) {
          const ok = i < run.length && run[i].ok;
          if (ok && from < 0) from = i;
          if (!ok && from >= 0) {
            if (i - from > 1) this.strokeRun(ctx, run.slice(from, i), t);
            from = -1;
          }
        }
      }
      ctx.globalAlpha = 1;
      if (p.midi !== null && p.glow > 0.01) {
        const y = this.y(p.midi);
        ctx.globalAlpha = p.glow;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(LANE.nowX, y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(LANE.nowX, y, 6, 0, Math.PI * 2);
        ctx.fill();
        if (this.paused && p.hint) this.drawHint(ctx, p.hint, y);
        ctx.globalAlpha = 1;
      }
      ctx.shadowBlur = 0;
    });
    ctx.restore();

    if (current >= 0) {
      const label = noteName(this.notes[current].midi);
      ctx.font = `700 16px ${FONT}`;
      const w = ctx.measureText(label).width + 20;
      ctx.fillStyle = 'rgba(250,204,21,0.95)';
      ctx.beginPath();
      ctx.roundRect(LANE.nowX - w / 2, LANE.top - 40, w, 26, 13);
      ctx.fill();
      ctx.fillStyle = '#1a1300';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, LANE.nowX, LANE.top - 27);
      ctx.textBaseline = 'alphabetic';
    }
  }

  // Подсказка на паузе рядом с кружком: какая нота звучит и куда тянуть голос.
  private drawHint(ctx: CanvasRenderingContext2D, hint: { name: string; diff: number }, y: number) {
    const { tolerance } = getSettings();
    const known = Number.isFinite(hint.diff);
    const ok = known && Math.abs(hint.diff) <= tolerance;
    const steps = Math.round(Math.abs(hint.diff));
    const label = !known ? hint.name : ok ? `${hint.name}  ✓` : `${hint.name}  ${hint.diff > 0 ? '↑' : '↓'} ${steps}`;
    ctx.shadowBlur = 0;
    ctx.font = `700 16px ${FONT}`;
    const w = ctx.measureText(label).width + 20;
    ctx.fillStyle = ok ? 'rgba(52,211,153,0.95)' : 'rgba(12,8,30,0.85)';
    ctx.beginPath();
    ctx.roundRect(LANE.nowX + 18, y - 14, w, 28, 14);
    ctx.fill();
    ctx.fillStyle = ok ? '#052e1c' : '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, LANE.nowX + 28, y + 1);
    ctx.textBaseline = 'alphabetic';
  }

  // Сглаженная линия через точки следа: кривые через середины соседних отрезков.
  private strokeRun(ctx: CanvasRenderingContext2D, run: { t: number; midi: number | null }[], t: number) {
    const pts = run.map((r) => [this.x(r.t, t), this.y(r.midi!)] as const);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }

  private measure(ctx: CanvasRenderingContext2D, line: Line, font: string) {
    const key = `${font}|${line.start}`;
    let m = this.measures.get(key);
    if (!m) {
      ctx.font = font;
      const text = line.words.map((w) => w.text).join(' ');
      let prefix = '';
      const spans = line.words.map((w): [number, number] => {
        const x0 = ctx.measureText(prefix).width;
        prefix += w.text;
        const x1 = ctx.measureText(prefix).width;
        prefix += ' ';
        return [x0, x1];
      });
      m = { text, full: ctx.measureText(text).width, spans };
      this.measures.set(key, m);
    }
    return m;
  }

  private drawLyrics(ctx: CanvasRenderingContext2D, t: number) {
    const lines = this.lines;
    const W = this.W;
    const c = lines.findIndex((l) => l.end + 0.4 > t);
    if (c < 0) return;
    const wait = lines[c].start - t;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (wait > 6) {
      if (t < 3.5) return; // в это время на экране заставка с названием
      ctx.font = `600 26px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText(`♪  проигрыш · ${Math.ceil(wait)} с`, W / 2, LYRIC_Y[0]);
      return;
    }
    [c, c + 1].forEach((i, row) => {
      const line = lines[i];
      if (!line || (row > 0 && line.start - t > 9)) return;
      const size = row === 0 ? 56 : 40;
      const font = `800 ${size}px ${FONT}`;
      const m = this.measure(ctx, line, font);
      const scale = Math.min(1, (W - 120) / m.full);
      const x = (W - m.full * scale) / 2;
      const y = LYRIC_Y[row];

      let filled = 0;
      line.words.forEach((w, k) => {
        if (t >= w.t1) filled = m.spans[k][1];
        else if (t > w.t0) filled = m.spans[k][0] + ((t - w.t0) / (w.t1 - w.t0)) * (m.spans[k][1] - m.spans[k][0]);
      });

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, 1);
      ctx.font = font;
      ctx.globalAlpha = row === 0 ? 1 : 0.6;
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 18;
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(10,6,25,0.55)';
      ctx.strokeText(m.text, 0, 0);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(m.text, 0, 0);
      if (filled > 0) {
        ctx.beginPath();
        ctx.rect(-10, -size * 1.2, filled + 10, size * 1.7);
        ctx.clip();
        const grad = ctx.createLinearGradient(0, 0, m.full, 0);
        grad.addColorStop(0, '#facc15');
        grad.addColorStop(1, '#f472b6');
        ctx.fillStyle = grad;
        ctx.fillText(m.text, 0, 0);
      }
      ctx.restore();

      // отсчёт перед вступлением после проигрыша
      const gap = i === 0 ? line.start : line.start - lines[i - 1].end;
      if (row === 0 && wait > 0 && wait < 3.2 && gap > 4) {
        const dots = Math.ceil(wait);
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = k < dots ? '#facc15' : 'rgba(255,255,255,0.18)';
          ctx.beginPath();
          ctx.arc(W / 2 - 30 + k * 30, y - size - 18, 8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }

  private drawHud(ctx: CanvasRenderingContext2D, t: number) {
    const W = this.W;
    ctx.textBaseline = 'middle';
    this.players.forEach((p) => {
      const right = p.slot === 1;
      ctx.globalAlpha = p.mic ? 1 : 0.4; // микрофон выключен — счёт заморожен
      const score = String(scoreOf(p.hit, p.total));
      ctx.font = `800 30px ${FONT}`;
      const scoreW = ctx.measureText(score).width;
      ctx.font = `600 16px ${FONT}`;
      const nameW = ctx.measureText(p.name).width;
      const w = 56 + nameW + scoreW;
      const x = right ? W - 32 - w : 32;
      ctx.fillStyle = 'rgba(12,8,30,0.6)';
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.roundRect(x, 28, w, 52, 26);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x + 24, 54, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(p.name, x + 38, 55);
      ctx.font = `800 30px ${FONT}`;
      ctx.fillStyle = '#fff';
      ctx.fillText(score, x + 46 + nameW, 55);
      ctx.globalAlpha = 1;
    });
    ctx.textBaseline = 'alphabetic';

    const progress = Math.max(0, Math.min(1, t / this.duration));
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(32, BASE_H - 24, W - 64, 4, 2);
    ctx.fill();
    const grad = ctx.createLinearGradient(32, 0, W - 32, 0);
    grad.addColorStop(0, '#a78bfa');
    grad.addColorStop(1, '#f472b6');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(32, BASE_H - 24, Math.max(4, (W - 64) * progress), 4, 2);
    ctx.fill();
  }

  private drawTitle(ctx: CanvasRenderingContext2D, t: number) {
    const W = this.W;
    ctx.globalAlpha = Math.max(0, Math.min(1, 3.5 - t));
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 24;
    ctx.font = `800 64px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(this.song.title, W / 2, 540, W - 120);
    if (this.song.artist) {
      ctx.font = `600 32px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(this.song.artist, W / 2, 596, W - 120);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
}
