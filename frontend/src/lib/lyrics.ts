// Раскладка слов по времени.
import type { Line, Note, Word } from '../api';

const round = (t: number) => Math.round(t * 100) / 100;

export const splitWords = (text: string) => text.trim().split(/\s+/).filter(Boolean);

export const lineText = (line: Line) => line.words.map((w) => w.text).join(' ');

// Отрезки, где звучит голос (по нотам); короткие паузы склеиваются.
function voicedSpans(notes: Note[], start: number, end: number): [number, number][] {
  const spans: [number, number][] = [];
  for (const n of notes) {
    if (n.end <= start || n.start >= end) continue;
    const a = Math.max(start, n.start);
    const b = Math.min(end, n.end);
    const last = spans[spans.length - 1];
    if (last && a - last[1] < 0.2) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  }
  return spans;
}

// Раскладывает слова по отрезку [start, end]: пропорционально длине слов, но только по тем
// местам, где голос действительно звучит, — так слова попадают на ноты, а не на паузы.
export function distributeWords(texts: string[], start: number, end: number, notes: Note[]): Word[] {
  if (!texts.length) return [];
  let spans = voicedSpans(notes, start, end);
  const voiced = spans.reduce((sum, [a, b]) => sum + b - a, 0);
  if (voiced < (end - start) * 0.3) spans = [[start, end]];
  const total = spans.reduce((sum, [a, b]) => sum + b - a, 0);

  // переводит долю «звучащего» времени в абсолютное время
  const at = (fraction: number) => {
    let rest = fraction * total;
    for (const [a, b] of spans) {
      if (rest <= b - a) return a + rest;
      rest -= b - a;
    }
    return spans[spans.length - 1][1];
  };

  const chars = texts.reduce((sum, t) => sum + t.length + 1, 0);
  let pos = 0;
  return texts.map((text) => {
    const t0 = at(pos / chars);
    pos += text.length + 1;
    const t1 = at((pos - 1) / chars);
    return { t0: round(t0), t1: round(Math.max(t0 + 0.05, t1)), text };
  });
}

// Слова строки после правки текста: время сохраняется, если число слов не изменилось.
export function rewordLine<T extends Line>(line: T, text: string, notes: Note[]): T {
  const texts = splitWords(text);
  if (texts.length === line.words.length) {
    return { ...line, words: line.words.map((w, i) => ({ ...w, text: texts[i] })) };
  }
  return { ...line, words: distributeWords(texts, line.start, line.end, notes) };
}

// Растягивает/сдвигает строку в новые границы, слова — пропорционально.
export function retimeLine<T extends Line>(line: T, start: number, end: number): T {
  const k = line.end > line.start ? (end - start) / (line.end - line.start) : 1;
  const map = (t: number) => round(start + (t - line.start) * k);
  return { ...line, start: round(start), end: round(end), words: line.words.map((w) => ({ ...w, t0: map(w.t0), t1: map(w.t1) })) };
}

// Границы строки по её словам.
export function fitLine<T extends Line>(line: T): T {
  if (!line.words.length) return line;
  return { ...line, start: line.words[0].t0, end: line.words[line.words.length - 1].t1 };
}

// Строки из текста (одна строка текста — одна строка песни) в отрезке [start, end].
// Если число слов совпадает с распознанными, берём их время; иначе раскладываем сами.
export function linesFromText(text: string, start: number, end: number, notes: Note[], recognized?: Word[]): Line[] {
  const rows = text.split('\n').map(splitWords).filter((r) => r.length);
  if (!rows.length) return [];
  const count = rows.reduce((sum, r) => sum + r.length, 0);
  let words: Word[];
  if (recognized && recognized.length === count) {
    let k = 0;
    words = rows.flat().map((t) => ({ ...recognized[k++], text: t }));
  } else {
    words = distributeWords(rows.flat(), start, end, notes);
  }
  let k = 0;
  return rows.map((r) => {
    const ws = words.slice(k, k + r.length);
    k += r.length;
    return { start: ws[0].t0, end: ws[ws.length - 1].t1, words: ws };
  });
}
