// Правая панель редактора: свойства выделенного фрагмента, строки или слова и список строк.
import {
  ArrowLeft, Clapperboard, Combine, LoaderCircle, Play, Plus, Repeat, Scissors, Trash2, Upload, WandSparkles, X,
} from 'lucide-react';
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SongMeta, WhisperModel } from '../api';
import { RecognizeFields } from '../components/RetranscribeDialog';
import { Button, IconButton, cx, inputClass } from '../components/ui';
import { stamp } from '../lib/format';
import { lineText } from '../lib/lyrics';
import type { ELine, Region } from './model';

export function Panel({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border-b border-white/8 p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/50">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

// Поле времени в секундах: применяется по Enter или при уходе фокуса.
export function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value.toFixed(2));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value.toFixed(2));
  }, [value]);
  const commit = () => {
    const v = Number(draft.replace(',', '.'));
    if (Number.isFinite(v) && v >= 0 && Math.abs(v - value) > 1e-6) onCommit(v);
    else setDraft(value.toFixed(2));
  };
  return (
    <label className="block flex-1">
      <span className="mb-1 block text-xs text-white/50">{label}</span>
      <input
        className={cx(inputClass, 'tabular-nums')}
        type="number"
        step="0.05"
        min="0"
        value={draft}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function RegionPanel({ region, text, onText, recognizing, onRecognize, onInsert, onPlay, onLoop, looping, replaced, pending, options, onOptions }: {
  region: Region;
  text: string;
  onText: (t: string) => void;
  recognizing: boolean;
  onRecognize: () => void;
  onInsert: () => void;
  onPlay: () => void;
  onLoop: () => void;
  looping: boolean;
  replaced: number;
  pending: number;
  options: { model: WhisperModel; language: string };
  onOptions: (o: { model: WhisperModel; language: string }) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [showOptions, setShowOptions] = useState(false);
  useEffect(() => {
    area.current?.focus({ preventScroll: true });
  }, [region.start]);

  return (
    <Panel
      title="Выделенный фрагмент"
      actions={<span className="text-xs tabular-nums text-amber-300">{stamp(region.start)} – {stamp(region.end)}</span>}
    >
      <div className="mb-3 flex gap-2">
        <Button size="sm" icon={<Play size={14} />} onClick={onPlay}>Прослушать</Button>
        <Button size="sm" variant={looping ? 'primary' : 'secondary'} icon={<Repeat size={14} />} onClick={onLoop}>По кругу</Button>
      </div>
      <label className="block">
        <span className="mb-1 block text-sm text-white/70">Что здесь поётся</span>
        <textarea
          ref={area}
          className="h-28 w-full resize-none rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-accent"
          placeholder={'Впишите слова или нажмите «Распознать».\nКаждая строка текста — отдельная строка песни.'}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onInsert();
            }
          }}
        />
      </label>
      {pending > 0 && <p className="mt-1 text-xs text-white/45">Подставлена следующая неразмеченная строка (осталось {pending}).</p>}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          icon={recognizing ? <LoaderCircle size={14} className="animate-spin" /> : <WandSparkles size={14} />}
          disabled={recognizing || region.end - region.start > 120}
          onClick={onRecognize}
          title={region.end - region.start > 120 ? 'Фрагмент длиннее двух минут' : 'Нейросеть прослушает голос в этом месте'}
        >
          {recognizing ? 'Слушаем…' : 'Распознать'}
        </Button>
        <Button size="sm" variant="primary" className="flex-1" icon={<Plus size={14} />} disabled={!text.trim()} onClick={onInsert}>
          В песню <kbd className="ml-1 text-[10px] opacity-60">⌘↵</kbd>
        </Button>
      </div>
      {replaced > 0 && <p className="mt-2 text-xs text-amber-300/80">Заменит строк в этом месте: {replaced}</p>}
      <button type="button" className="mt-3 text-xs text-white/45 underline-offset-2 hover:text-white/80 hover:underline" onClick={() => setShowOptions(!showOptions)}>
        Параметры распознавания
      </button>
      {showOptions && <div className="mt-2"><RecognizeFields {...options} onChange={onOptions} /></div>}
    </Panel>
  );
}

export function LinePanel({ line, focusKey, onText, onTimes, onPlay, onLoop, looping, onRecognize, recognizing, onSplit, onMerge, canMerge, onDelete, onWord }: {
  line: ELine;
  focusKey: number;
  onText: (text: string) => void;
  onTimes: (start: number, end: number) => void;
  onPlay: () => void;
  onLoop: () => void;
  looping: boolean;
  onRecognize: () => void;
  recognizing: boolean;
  onSplit: () => void;
  onMerge: () => void;
  canMerge: boolean;
  onDelete: () => void;
  onWord: (index: number) => void;
}) {
  const text = lineText(line);
  const [draft, setDraft] = useState(text);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(text);
  }, [text]);
  useEffect(() => {
    if (focusKey) input.current?.focus();
  }, [focusKey]);
  const apply = () => {
    if (draft.trim() && draft.trim() !== text) onText(draft);
    else setDraft(text);
  };

  return (
    <Panel title="Строка" actions={<IconButton label="Удалить строку (Delete)" size="sm" onClick={onDelete}><Trash2 size={15} /></IconButton>}>
      <input
        ref={input}
        className={cx(inputClass, 'h-11 text-base font-semibold')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(text);
            requestAnimationFrame(() => input.current?.blur());
          }
        }}
      />
      <p className="mt-1 text-xs text-white/40">Если число слов не изменится, их время сохранится.</p>
      <div className="mt-3 flex gap-2">
        <TimeField label="Начало, с" value={line.start} onCommit={(v) => onTimes(v, Math.max(v + 0.2, line.end))} />
        <TimeField label="Конец, с" value={line.end} onCommit={(v) => onTimes(Math.min(line.start, v - 0.2), v)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={<Play size={14} />} onClick={onPlay}>Слушать</Button>
        <Button size="sm" variant={looping ? 'primary' : 'secondary'} icon={<Repeat size={14} />} onClick={onLoop}>По кругу</Button>
        <Button size="sm" icon={recognizing ? <LoaderCircle size={14} className="animate-spin" /> : <WandSparkles size={14} />} disabled={recognizing} onClick={onRecognize}
          title="Распознать слова этой строки заново">
          Перепроверить
        </Button>
        <Button size="sm" icon={<Scissors size={14} />} onClick={onSplit} title="Разрезать по курсору (S)">Разрезать</Button>
        <Button size="sm" icon={<Combine size={14} />} onClick={onMerge} disabled={!canMerge} title="Склеить со следующей (M)">Склеить</Button>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {line.words.map((w, i) => (
          <button
            key={i}
            type="button"
            className="rounded-lg bg-cyan-400/10 px-2 py-1 text-xs text-cyan-100 transition hover:bg-cyan-400/25"
            title={`${stamp(w.t0)} – ${stamp(w.t1)}`}
            onClick={() => onWord(i)}
          >
            {w.text}
          </button>
        ))}
      </div>
    </Panel>
  );
}

export function WordPanel({ line, index, onChange, onDelete, onBack }: {
  line: ELine;
  index: number;
  onChange: (word: { t0: number; t1: number; text: string }) => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const word = line.words[index];
  const [draft, setDraft] = useState(word.text);
  useEffect(() => setDraft(word.text), [word.text, index, line.id]);
  return (
    <Panel
      title="Слово"
      actions={
        <div className="flex gap-1">
          <IconButton label="К строке" size="sm" onClick={onBack}><ArrowLeft size={15} /></IconButton>
          <IconButton label="Удалить слово (Delete)" size="sm" onClick={onDelete}><Trash2 size={15} /></IconButton>
        </div>
      }
    >
      <input
        className={cx(inputClass, 'h-11 text-base font-semibold')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => (draft.trim() && draft.trim() !== word.text ? onChange({ ...word, text: draft.trim().replace(/\s+/g, ' ') }) : setDraft(word.text))}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <div className="mt-3 flex gap-2">
        <TimeField label="Начало, с" value={word.t0} onCommit={(v) => onChange({ ...word, t0: v, t1: Math.max(v + 0.03, word.t1) })} />
        <TimeField label="Конец, с" value={word.t1} onCommit={(v) => onChange({ ...word, t0: Math.min(word.t0, v - 0.03), t1: v })} />
      </div>
      <p className="mt-3 text-xs text-white/40">Края слова удобнее тянуть прямо на дорожке «Слова». Стрелки ← → сдвигают выделенное.</p>
    </Panel>
  );
}

export const LinesList = memo(function LinesList({ lines, pending, selectedId, currentId, onPick, onRemovePending, onClearPending }: {
  lines: ELine[];
  pending: string[];
  selectedId: number | null;
  currentId: number | null;
  onPick: (line: ELine) => void;
  onRemovePending: (index: number) => void;
  onClearPending: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current?.querySelector('[data-current="true"]');
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [currentId]);
  return (
    <>
      <Panel title={`Строки песни · ${lines.length}`}>
        {lines.length ? (
          <ol ref={list} className="-mx-2 space-y-0.5">
            {lines.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  data-current={l.id === currentId}
                  onClick={() => onPick(l)}
                  className={cx(
                    'flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left text-sm transition',
                    l.id === selectedId ? 'bg-accent/20 text-white' : l.id === currentId ? 'bg-white/8 text-white' : 'text-white/70 hover:bg-white/5',
                  )}
                >
                  <span className="w-14 shrink-0 text-xs tabular-nums text-white/40">{stamp(l.start).slice(0, -1)}</span>
                  <span className="min-w-0 flex-1">{lineText(l)}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-white/45">Строк пока нет. Выделите на волне место, где поют, и впишите слова — или распознайте их.</p>
        )}
      </Panel>
      {pending.length > 0 && (
        <Panel
          title={`Без разметки · ${pending.length}`}
          actions={<button type="button" className="text-xs text-white/45 hover:text-white" onClick={onClearPending}>Очистить</button>}
        >
          <p className="mb-2 text-xs text-white/45">Выделяйте на волне место каждой строки по порядку — текст подставится сам.</p>
          <ol className="space-y-1">
            {pending.map((text, i) => (
              <li key={i} className={cx('group flex items-center gap-2 rounded-lg px-2 py-1 text-sm', i === 0 ? 'bg-amber-400/10 text-amber-100' : 'text-white/55')}>
                <span className="min-w-0 flex-1">{text}</span>
                <button type="button" className="opacity-0 transition group-hover:opacity-100" title="Убрать" onClick={() => onRemovePending(i)}><X size={14} /></button>
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </>
  );
});

export function VideoPanel({ song, offset, onOffset, onUpload, onRemove, uploading }: {
  song: SongMeta;
  offset: number;
  onOffset: (v: number) => void;
  onUpload: (file: File) => void;
  onRemove: () => void;
  uploading: number | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const busy = uploading !== null || song.videoStatus === 'processing';
  return (
    <Panel title="Видеоклип">
      {song.video ? (
        <>
          <label className="block">
            <span className="flex justify-between text-sm text-white/70">
              <span>Сдвиг клипа</span>
              <span className="tabular-nums text-white">{offset > 0 ? '+' : ''}{offset.toFixed(2)} с</span>
            </span>
            <input
              type="range"
              className="mt-1 w-full"
              min={-30}
              max={30}
              step={0.05}
              value={offset}
              style={{ '--fill': `${((offset + 30) / 60) * 100}%` } as CSSProperties}
              onChange={(e) => onOffset(Number(e.target.value))}
            />
          </label>
          <p className="mt-1 text-xs text-white/40">Если в клипе есть вступление без музыки, сдвиньте его, чтобы картинка совпала со звуком.</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" icon={<Upload size={14} />} disabled={busy} onClick={() => input.current?.click()}>Заменить</Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} disabled={busy} onClick={onRemove}>Убрать</Button>
            {offset !== 0 && <Button size="sm" variant="ghost" onClick={() => onOffset(0)}>Сбросить</Button>}
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-white/50">Добавьте клип — он станет видеорядом песни во время игры.</p>
          <Button size="sm" icon={<Clapperboard size={14} />} disabled={busy} onClick={() => input.current?.click()}>Добавить клип</Button>
        </>
      )}
      {uploading !== null && <p className="mt-2 text-xs text-white/55">Загрузка {Math.round(uploading * 100)}%</p>}
      {song.videoStatus === 'processing' && (
        <p className="mt-2 flex items-center gap-2 text-xs text-white/55"><LoaderCircle size={12} className="animate-spin" />Готовим клип для показа…</p>
      )}
      {song.videoError && <p className="mt-2 text-xs text-amber-300">{song.videoError}</p>}
      <input
        ref={input}
        type="file"
        hidden
        accept="video/*,.mkv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = '';
        }}
      />
    </Panel>
  );
}
