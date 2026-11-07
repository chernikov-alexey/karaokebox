// Документ редактора: размеченные строки и очередь строк без времени.
import { useCallback, useState } from 'react';
import type { Line, Note, Word } from '../api';
import { fitLine, linesFromText } from '../lib/lyrics';

export interface ELine extends Line {
  id: number;
}

export interface Doc {
  lines: ELine[];
  // строки текста, которые ещё предстоит разметить на дорожке
  pending: string[];
}

export interface Region {
  start: number;
  end: number;
}

export type Selection = { kind: 'line'; id: number } | { kind: 'word'; id: number; index: number } | null;

let nextId = 1;
export const withId = (line: Line): ELine => ({ ...line, id: nextId++ });

export const sortLines = (lines: ELine[]) => [...lines].sort((a, b) => a.start - b.start);

export const toLines = (lines: ELine[]): Line[] =>
  sortLines(lines)
    .filter((l) => l.words.length)
    .map((l) => {
      const fitted = fitLine(l);
      return { start: fitted.start, end: fitted.end, words: fitted.words.map(({ t0, t1, text }) => ({ t0, t1, text })) };
    });

export const docFromLines = (lines: Line[]): Doc => ({ lines: sortLines(lines.map(withId)), pending: [] });

// Сколько каждая строка перекрыта отрезком (доля её длины).
const overlap = (line: Line, r: Region) => {
  const len = Math.max(0.01, line.end - line.start);
  return Math.max(0, Math.min(line.end, r.end) - Math.max(line.start, r.start)) / len;
};

export function linesInRegion(lines: ELine[], region: Region) {
  return lines.filter((l) => overlap(l, region) > 0.5);
}

// Вставляет строки из текста в отрезок, заменяя строки, которые в нём лежат.
export function insertText(doc: Doc, region: Region, text: string, notes: Note[], recognized?: Word[]) {
  const created = linesFromText(text, region.start, region.end, notes, recognized).map(withId);
  if (!created.length) return null;
  const replaced = linesInRegion(doc.lines, region);
  const kept = doc.lines.filter((l) => !replaced.includes(l));
  // если вставили первые строки из очереди — убираем их оттуда
  const rows = text.split('\n').map((r) => r.trim()).filter(Boolean);
  let used = 0;
  while (used < rows.length && used < doc.pending.length && doc.pending[used].trim() === rows[used]) used++;
  return {
    doc: { lines: sortLines([...kept, ...created]), pending: doc.pending.slice(used) },
    created,
    replaced: replaced.length,
  };
}

export function splitLine(line: ELine, at: number): [ELine, ELine] | null {
  const first = line.words.filter((w) => (w.t0 + w.t1) / 2 < at);
  const second = line.words.slice(first.length);
  if (!first.length || !second.length) return null;
  return [
    { ...fitLine({ ...line, words: first }), id: line.id },
    withId(fitLine({ ...line, words: second })),
  ];
}

export function mergeLines(a: ELine, b: ELine): ELine {
  return { ...fitLine({ ...a, words: [...a.words, ...b.words].sort((x, y) => x.t0 - y.t0) }), id: a.id };
}

// ---------- история правок ----------

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 200;

export function useHistory<T>(initial: T) {
  const [h, setH] = useState<History<T>>({ past: [], present: initial, future: [] });

  // новое состояние с записью в историю
  const commit = useCallback((next: T | ((prev: T) => T)) => {
    setH((s) => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(s.present) : next;
      if (value === s.present) return s;
      return { past: [...s.past, s.present].slice(-LIMIT), present: value, future: [] };
    });
  }, []);

  // промежуточное состояние (во время перетаскивания), без записи
  const replace = useCallback((value: T) => setH((s) => ({ ...s, present: value })), []);

  // конец перетаскивания: в историю попадает состояние до его начала
  const record = useCallback((before: T) => {
    setH((s) => (s.present === before ? s : { past: [...s.past, before].slice(-LIMIT), present: s.present, future: [] }));
  }, []);

  const undo = useCallback(() => {
    setH((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s));
  }, []);

  const redo = useCallback(() => {
    setH((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s));
  }, []);

  const reset = useCallback((value: T) => setH({ past: [], present: value, future: [] }), []);

  return {
    doc: h.present,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    commit, replace, record, undo, redo, reset,
  };
}
