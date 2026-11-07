// Таймлайн редактора: линейка, строки, слова и волна вырезанного голоса с нотами.
// Мышью: протянуть по волне — выделить фрагмент; тянуть строку или слово — сдвинуть;
// края блоков — изменить длину; колесо — прокрутка, Ctrl/⌘ + колесо или щипок — масштаб.
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Note } from '../api';
import { fitLine, lineText, retimeLine } from '../lib/lyrics';
import type { ELine, Region, Selection } from './model';
import { PEAKS_PER_SEC, type EditorPlayer } from './player';

export interface View {
  start: number;
  pps: number; // пикселей в секунду
}

export const MAX_PPS = 900;
export const TIMELINE_H = 300;
const RULER_H = 24;
const LINES = { y: 24, h: 40 };
const WORDS = { y: 66, h: 34 };
const WAVE = { y: 102, h: TIMELINE_H - 102 };
const EDGE = 6;
const FONT = '"Manrope Variable", system-ui, sans-serif';

type Drag =
  | { kind: 'region'; anchor: number; x0: number; moved: boolean }
  | { kind: 'region-edge'; other: number }
  | { kind: 'line-move' | 'line-start' | 'line-end'; orig: ELine; t0: number; x0: number; moved: boolean }
  | { kind: 'word-move' | 'word-start' | 'word-end'; orig: ELine; index: number; t0: number; x0: number; moved: boolean };

export interface TimelineProps {
  duration: number;
  peaks: Float32Array;
  notes: Note[];
  lines: ELine[];
  selection: Selection;
  region: Region | null;
  view: View;
  player: EditorPlayer;
  follow: boolean;
  onView: (v: View) => void;
  onSeek: (t: number) => void;
  onRegion: (r: Region | null) => void;
  onSelect: (s: Selection) => void;
  onDrag: (phase: 'start' | 'move' | 'end', lines?: ELine[]) => void;
  onOpen: (id: number) => void;
}

export function clampView(v: View, duration: number, width: number): View {
  const minPps = width / Math.max(1, duration);
  const pps = Math.max(minPps, Math.min(MAX_PPS, v.pps));
  const start = Math.max(0, Math.min(v.start, duration - width / pps));
  return { start, pps };
}

function tickStep(pps: number) {
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60]) if (s * pps >= 70) return s;
  return 120;
}

const label = (t: number, fine: boolean) => {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${fine ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0')}`;
};

export function Timeline(props: TimelineProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  live.current = props;
  const width = useRef(800);
  const drag = useRef<Drag | null>(null);

  // размер холста следует за контейнером
  useEffect(() => {
    const c = canvas.current!;
    const observer = new ResizeObserver(() => {
      width.current = c.clientWidth;
      const { view, duration, onView } = live.current;
      const next = clampView(view, duration, width.current);
      if (next.start !== view.start || next.pps !== view.pps) onView(next);
    });
    observer.observe(c);
    return () => observer.disconnect();
  }, []);

  // отрисовка каждый кадр: проще, чем следить за всеми изменениями, а кадр дешёвый
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  // колесо: прокрутка и масштаб
  useEffect(() => {
    const c = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, duration, onView } = live.current;
      if (e.ctrlKey || e.metaKey) {
        const x = e.offsetX;
        const t = view.start + x / view.pps;
        const pps = view.pps * Math.exp(-e.deltaY * 0.01);
        onView(clampView({ pps, start: t - x / pps }, duration, width.current));
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        onView(clampView({ ...view, start: view.start + delta / view.pps }, duration, width.current));
      }
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, []);

  function draw() {
    const c = canvas.current;
    if (!c) return;
    const p = live.current;
    const W = c.clientWidth;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(TIMELINE_H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(TIMELINE_H * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { view, duration, player } = p;

    // следовать за курсором воспроизведения
    const now = player.time;
    if (p.follow && player.playing && !drag.current) {
      const x = (now - view.start) * view.pps;
      if (x > W * 0.92 || x < 0) p.onView(clampView({ ...view, start: now - (W * 0.08) / view.pps }, duration, W));
    }
    const X = (t: number) => (t - view.start) * view.pps;
    const tEnd = view.start + W / view.pps;

    g.fillStyle = '#0e0c18';
    g.fillRect(0, 0, W, TIMELINE_H);
    g.fillStyle = 'rgba(255,255,255,0.025)';
    g.fillRect(0, LINES.y, W, LINES.h);
    g.fillRect(0, WAVE.y, W, WAVE.h);

    // линейка
    const step = tickStep(view.pps);
    g.font = `600 10px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let t = Math.floor(view.start / step) * step; t <= tEnd; t += step) {
      const x = Math.round(X(t)) + 0.5;
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x, 0, 1, RULER_H);
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(x, RULER_H, 1, TIMELINE_H - RULER_H);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText(label(t, step < 1), x + 4, RULER_H / 2);
      for (let k = 1; k < 5; k++) {
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(Math.round(X(t + (step * k) / 5)), RULER_H - 6, 1, 6);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, RULER_H - 1, W, 1);

    // волна голоса: фиолетовая там, где есть текст, серая — где голос без текста
    const lines = p.lines;
    const mid = WAVE.y + WAVE.h / 2;
    let li = 0;
    for (let x = 0; x < W; x++) {
      const t0 = view.start + x / view.pps;
      const t1 = t0 + 1 / view.pps;
      if (t0 > duration) break;
      const i0 = Math.floor(t0 * PEAKS_PER_SEC);
      const i1 = Math.max(i0 + 1, Math.floor(t1 * PEAKS_PER_SEC));
      let peak = 0;
      for (let i = i0; i < i1 && i < p.peaks.length; i++) if (p.peaks[i] > peak) peak = p.peaks[i];
      while (li < lines.length && lines[li].end < t0) li++;
      const covered = li < lines.length && lines[li].start <= t0;
      const h = Math.max(0.5, peak ** 0.75 * (WAVE.h / 2 - 6));
      g.fillStyle = covered ? 'rgba(167,139,250,0.75)' : 'rgba(255,255,255,0.28)';
      g.fillRect(x, mid - h, 1, h * 2);
    }

    // ноты поверх волны
    if (p.notes.length) {
      const sorted = p.notes.map((n) => n.midi).sort((a, b) => a - b);
      const lo = (sorted[Math.floor(sorted.length * 0.02)] ?? 50) - 2;
      const hi = (sorted[Math.floor(sorted.length * 0.98)] ?? 70) + 2;
      g.fillStyle = 'rgba(244,114,182,0.75)';
      for (const n of p.notes) {
        if (n.end < view.start || n.start > tEnd) continue;
        const y = WAVE.y + 6 + (1 - (n.midi - lo) / (hi - lo)) * (WAVE.h - 12);
        g.beginPath();
        g.roundRect(X(n.start), y - 1.5, Math.max(2, (n.end - n.start) * view.pps), 3, 1.5);
        g.fill();
      }
    }

    // строки и слова
    g.font = `600 12px ${FONT}`;
    const sel = p.selection;
    for (const line of lines) {
      if (line.end < view.start || line.start > tEnd) continue;
      const x0 = X(line.start);
      const w = Math.max(3, (line.end - line.start) * view.pps);
      const active = now >= line.start && now < line.end;
      const selected = sel?.id === line.id;
      block(g, x0, LINES.y + 4, w, LINES.h - 8, selected && sel?.kind === 'line' ? '#8b5cf6' : active ? 'rgba(139,92,246,0.55)' : 'rgba(139,92,246,0.32)',
        selected ? '#ffffff' : 'rgba(167,139,250,0.5)', lineText(line), '#fff');

      line.words.forEach((word, i) => {
        if (word.t1 < view.start || word.t0 > tEnd) return;
        const wx = X(word.t0);
        const ww = Math.max(3, (word.t1 - word.t0) * view.pps);
        const on = sel?.kind === 'word' && sel.id === line.id && sel.index === i;
        const sung = now >= word.t0 && now < word.t1;
        block(g, wx, WORDS.y + 3, ww, WORDS.h - 6, on ? '#06b6d4' : sung ? 'rgba(34,211,238,0.5)' : selected ? 'rgba(34,211,238,0.3)' : 'rgba(34,211,238,0.18)',
          on ? '#ffffff' : 'rgba(34,211,238,0.45)', word.text, '#e0fbff');
      });
    }

    // подписи дорожек
    g.font = `700 9px ${FONT}`;
    g.textBaseline = 'top';
    for (const [text, y] of [['СТРОКИ', LINES.y], ['СЛОВА', WORDS.y], ['ГОЛОС И НОТЫ', WAVE.y]] as const) {
      const w = g.measureText(text).width + 10;
      g.fillStyle = 'rgba(14,12,24,0.85)';
      g.fillRect(0, y, w + 2, 15);
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.fillText(text, 6, y + 3);
    }

    // выделенный фрагмент
    const r = p.region;
    if (r) {
      const rx = X(r.start);
      const rw = (r.end - r.start) * view.pps;
      g.fillStyle = 'rgba(250,204,21,0.1)';
      g.fillRect(rx, RULER_H, rw, TIMELINE_H - RULER_H);
      g.fillStyle = 'rgba(250,204,21,0.9)';
      g.fillRect(rx - 1, RULER_H, 2, TIMELINE_H - RULER_H);
      g.fillRect(rx + rw - 1, RULER_H, 2, TIMELINE_H - RULER_H);
      g.fillStyle = 'rgba(250,204,21,0.35)';
      g.fillRect(rx, 0, rw, RULER_H);
    }

    // курсор воспроизведения
    const px = X(now);
    if (px >= -10 && px <= W + 10) {
      g.fillStyle = '#facc15';
      g.fillRect(Math.round(px) - 1, 0, 2, TIMELINE_H);
      g.beginPath();
      g.moveTo(px - 6, 0);
      g.lineTo(px + 6, 0);
      g.lineTo(px, 8);
      g.fill();
    }
  }

  function block(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke: string, text: string, color: string) {
    g.fillStyle = fill;
    g.strokeStyle = stroke;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(x, y, w, h, Math.min(6, w / 2));
    g.fill();
    g.stroke();
    if (w > 18) {
      g.save();
      g.beginPath();
      g.rect(x + 5, y, w - 10, h);
      g.clip();
      g.fillStyle = color;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText(text, x + 6, y + h / 2 + 0.5);
      g.restore();
    }
  }

  // ---------- мышь ----------

  type Hit =
    | { kind: 'line'; line: ELine; part: 'move' | 'start' | 'end' }
    | { kind: 'word'; line: ELine; index: number; part: 'move' | 'start' | 'end' }
    | { kind: 'region-edge'; other: number }
    | { kind: 'empty' };

  function hitTest(x: number, y: number): Hit {
    const { view, lines, region } = live.current;
    const X = (t: number) => (t - view.start) * view.pps;
    const part = (x0: number, x1: number): 'move' | 'start' | 'end' => {
      if (x1 - x0 < EDGE * 3) return 'move';
      if (x - x0 < EDGE) return 'start';
      if (x1 - x < EDGE) return 'end';
      return 'move';
    };
    if (region && y >= RULER_H) {
      if (Math.abs(x - X(region.start)) < EDGE) return { kind: 'region-edge', other: region.end };
      if (Math.abs(x - X(region.end)) < EDGE) return { kind: 'region-edge', other: region.start };
    }
    if (y >= LINES.y && y < LINES.y + LINES.h) {
      for (const line of lines) {
        const x0 = X(line.start);
        const x1 = Math.max(x0 + 3, X(line.end));
        if (x >= x0 - 2 && x <= x1 + 2) return { kind: 'line', line, part: part(x0, x1) };
      }
    }
    if (y >= WORDS.y && y < WORDS.y + WORDS.h) {
      for (const line of lines) {
        if (X(line.end) < x - 4 || X(line.start) > x + 4) continue;
        for (let i = 0; i < line.words.length; i++) {
          const w = line.words[i];
          const x0 = X(w.t0);
          const x1 = Math.max(x0 + 3, X(w.t1));
          if (x >= x0 - 2 && x <= x1 + 2) return { kind: 'word', line, index: i, part: part(x0, x1) };
        }
      }
    }
    return { kind: 'empty' };
  }

  const cursorFor = (hit: Hit) => {
    if (hit.kind === 'region-edge') return 'ew-resize';
    if (hit.kind === 'line' || hit.kind === 'word') return hit.part === 'move' ? 'grab' : 'ew-resize';
    return 'text';
  };

  const timeAt = (x: number) => {
    const { view, duration } = live.current;
    return Math.max(0, Math.min(duration, view.start + x / view.pps));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const p = live.current;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const t = timeAt(x);
    const hit = hitTest(x, y);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit.kind === 'region-edge') {
      drag.current = { kind: 'region-edge', other: hit.other };
    } else if (hit.kind === 'line') {
      p.onSelect({ kind: 'line', id: hit.line.id });
      drag.current = { kind: `line-${hit.part}`, orig: hit.line, t0: t, x0: x, moved: false };
    } else if (hit.kind === 'word') {
      p.onSelect({ kind: 'word', id: hit.line.id, index: hit.index });
      drag.current = { kind: `word-${hit.part}`, orig: hit.line, index: hit.index, t0: t, x0: x, moved: false };
    } else {
      drag.current = { kind: 'region', anchor: t, x0: x, moved: false };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = e.nativeEvent.offsetX;
    const d = drag.current;
    if (!d) {
      e.currentTarget.style.cursor = cursorFor(hitTest(x, e.nativeEvent.offsetY));
      return;
    }
    const p = live.current;
    const t = timeAt(x);
    if (d.kind === 'region') {
      if (!d.moved && Math.abs(x - d.x0) < 4) return;
      d.moved = true;
      p.onRegion({ start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) });
      return;
    }
    if (d.kind === 'region-edge') {
      p.onRegion({ start: Math.min(d.other, t), end: Math.max(d.other, t) });
      return;
    }
    if (!d.moved) {
      if (Math.abs(x - d.x0) < 3) return;
      d.moved = true;
      p.onDrag('start');
    }
    const changed = moveBlock(d, t, p.duration);
    p.onDrag('move', p.lines.map((l) => (l.id === changed.id ? changed : l)));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const p = live.current;
    const t = timeAt(e.nativeEvent.offsetX);
    if (d.kind === 'region') {
      if (!d.moved) {
        p.onSeek(t);
        const r = p.region;
        if (!r || t < r.start || t > r.end) p.onRegion(null);
        if (e.nativeEvent.offsetY >= WAVE.y || e.nativeEvent.offsetY < RULER_H) p.onSelect(null);
      } else {
        const r = p.region;
        if (r && r.end - r.start < 0.05) p.onRegion(null);
      }
    } else if (d.kind !== 'region-edge') {
      if (d.moved) p.onDrag('end');
      else p.onSeek('index' in d ? d.orig.words[d.index].t0 : d.orig.start);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const hit = hitTest(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (hit.kind === 'line' || hit.kind === 'word') live.current.onOpen(hit.line.id);
  };

  return (
    <canvas
      ref={canvas}
      className="block w-full touch-none select-none"
      style={{ height: TIMELINE_H }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={onDoubleClick}
    />
  );
}

// Новое положение строки или слова при перетаскивании.
function moveBlock(d: Exclude<Drag, { kind: 'region' | 'region-edge' }>, t: number, duration: number): ELine {
  const dt = t - d.t0;
  const line = d.orig;
  if (d.kind === 'line-move') {
    const len = line.end - line.start;
    const start = Math.max(0, Math.min(duration - len, line.start + dt));
    return { ...retimeLine(line, start, start + len), id: line.id };
  }
  if (d.kind === 'line-start') return { ...retimeLine(line, Math.max(0, Math.min(line.end - 0.2, t)), line.end), id: line.id };
  if (d.kind === 'line-end' || !('index' in d)) {
    return { ...retimeLine(line, line.start, Math.min(duration, Math.max(line.start + 0.2, t))), id: line.id };
  }

  const i = d.index;
  const w = line.words[i];
  const min = i > 0 ? line.words[i - 1].t1 : 0;
  const max = i < line.words.length - 1 ? line.words[i + 1].t0 : duration;
  const r = (v: number) => Math.round(v * 100) / 100;
  let word = w;
  if (d.kind === 'word-move') {
    const len = w.t1 - w.t0;
    const t0 = Math.max(min, Math.min(max - len, w.t0 + dt));
    word = { ...w, t0: r(t0), t1: r(t0 + len) };
  } else if (d.kind === 'word-start') {
    word = { ...w, t0: r(Math.max(min, Math.min(w.t1 - 0.03, t))) };
  } else {
    word = { ...w, t1: r(Math.min(max, Math.max(w.t0 + 0.03, t))) };
  }
  const words = line.words.map((x, k) => (k === i ? word : x));
  return { ...fitLine({ ...line, words }), id: line.id };
}

// Обзор всей песни: где мы и какие места уже размечены. Клик или протяжка — перейти.
export function Overview({ duration, peaks, lines, view, width, onView }: {
  duration: number;
  peaks: Float32Array;
  lines: ELine[];
  view: View;
  width: number;
  onView: (v: View) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const H = 36;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const W = c.clientWidth;
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.round(W * dpr);
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0e0c18';
    g.fillRect(0, 0, W, H);
    const per = peaks.length / W;
    for (let x = 0; x < W; x++) {
      let peak = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) if (peaks[i] > peak) peak = peaks[i];
      const h = Math.max(0.5, peak ** 0.75 * (H / 2 - 4));
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(x, H / 2 - h, 1, h * 2);
    }
    g.fillStyle = 'rgba(139,92,246,0.7)';
    for (const l of lines) g.fillRect((l.start / duration) * W, H - 4, Math.max(1, ((l.end - l.start) / duration) * W), 3);
    const vx = (view.start / duration) * W;
    const vw = Math.max(4, (width / view.pps / duration) * W);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(vx, 0, vw, H);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.strokeRect(vx + 0.5, 0.5, vw - 1, H - 1);
  }, [duration, peaks, lines, view, width]);

  const go = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const W = e.currentTarget.clientWidth;
    const t = (e.nativeEvent.offsetX / W) * duration;
    onView(clampView({ ...view, start: t - width / view.pps / 2 }, duration, width));
  };

  return (
    <canvas
      ref={canvas}
      className="block w-full cursor-pointer touch-none rounded-lg"
      style={{ height: H }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        go(e);
      }}
      onPointerMove={(e) => e.buttons && go(e)}
    />
  );
}
