// Редактор текста песни: таймлайн с голосом, разметка строк и слов, распознавание и клип.
import {
  ChevronLeft, ClipboardPaste, Crosshair, Expand, Headphones, LoaderCircle, Music2, Pause, Play, Redo2, Repeat, Save, Undo2,
  WandSparkles, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, stemUrl, videoUrl, type Note, type Song, type SongMeta, type Word } from '../api';
import { loadBuffer } from '../audio/engine';
import { RetranscribeDialog, loadRecognizeOptions, saveRecognizeOptions } from '../components/RetranscribeDialog';
import { Button, IconButton, Modal, ProgressBar, confirmDialog, cx, inputClass, toast, toastError } from '../components/ui';
import { LinePanel, LinesList, RegionPanel, VideoPanel, WordPanel } from '../editor/Inspector';
import {
  docFromLines, insertText, linesInRegion, mergeLines, sortLines, splitLine, toLines, useHistory,
  type Doc, type ELine, type Region, type Selection,
} from '../editor/model';
import { EditorPlayer, computePeaks } from '../editor/player';
import { Overview, Timeline, clampView, type View } from '../editor/Timeline';
import { stamp } from '../lib/format';
import { fitLine, lineText, retimeLine, rewordLine } from '../lib/lyrics';
import { navigate } from '../router';

interface Loaded {
  player: EditorPlayer;
  peaks: Float32Array;
}

const EMPTY: Doc = { lines: [], pending: [] };

async function waitFor(id: string, done: (s: SongMeta) => boolean, onTick?: (s: SongMeta) => void) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const songs = await api.songs();
    const s = songs.find((x) => x.id === id);
    if (!s) throw new Error('Песня удалена');
    onTick?.(s);
    if (done(s)) return s;
  }
}

export function Editor({ id }: { id: string }) {
  const [song, setSong] = useState<Song | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const history = useHistory<Doc>(EMPTY);
  const { doc, commit, replace, record, undo, redo, reset } = history;
  const saved = useRef<Doc>(EMPTY);
  const [meta, setMeta] = useState({ title: '', artist: '', videoOffset: 0 });
  const savedMeta = useRef(meta);

  const [selection, setSelection] = useState<Selection>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [view, setView] = useState<View>({ start: 0, pps: 120 });
  const [follow, setFollow] = useState(true);
  const [mix, setMix] = useState({ voice: 1, minus: 0.35 });
  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const [regionText, setRegionText] = useState('');
  const [recognized, setRecognized] = useState<Word[] | undefined>();
  const [recognizing, setRecognizing] = useState(false);
  const [recognizeOptions, setRecognizeOptions] = useState(loadRecognizeOptions);
  const [focusKey, setFocusKey] = useState(0);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const [transcribing, setTranscribing] = useState<SongMeta | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [timelineWidth, setTimelineWidth] = useState(800);
  const timelineBox = useRef<HTMLDivElement>(null);
  const dragBefore = useRef<Doc | null>(null);

  const dirty = doc !== saved.current || meta.title !== savedMeta.current.title || meta.artist !== savedMeta.current.artist
    || meta.videoOffset !== savedMeta.current.videoOffset;

  // ---------- загрузка ----------

  useEffect(() => {
    let player: EditorPlayer | null = null;
    let cancelled = false;
    (async () => {
      const s = await api.song(id);
      if (s.status !== 'ready') throw new Error('Песня ещё обрабатывается');
      if (cancelled) return;
      setSong(s);
      const initial = docFromLines(s.lyrics);
      reset(initial);
      saved.current = initial;
      const m = { title: s.title, artist: s.artist ?? '', videoOffset: s.videoOffset ?? 0 };
      setMeta(m);
      savedMeta.current = m;
      const [vocals, minus] = await Promise.all([loadBuffer(stemUrl(id, 'vocals')), loadBuffer(stemUrl(id, 'minus'))]);
      if (cancelled) return;
      player = new EditorPlayer(vocals, minus);
      player.onStateChange = () => {
        setPlaying(player!.playing);
        setLooping(!!player!.looping);
      };
      setLoaded({ player, peaks: computePeaks(vocals) });
      const first = s.lyrics[0]?.start ?? 0;
      setView((v) => ({ ...v, start: Math.max(0, first - 1) }));
    })().catch((e) => {
      toastError(e);
      navigate('/');
    });
    return () => {
      cancelled = true;
      player?.dispose();
    };
  }, [id, reset]);

  const player = loaded?.player ?? null;
  const notes = song?.noteList ?? [];
  const duration = player?.duration ?? song?.duration ?? 1;

  useEffect(() => player?.setMix(mix.voice, mix.minus), [player, mix]);

  useEffect(() => {
    const el = timelineBox.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTimelineWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---------- выделение ----------

  const selectedLine = selection ? doc.lines.find((l) => l.id === selection.id) ?? null : null;
  const replacedCount = region ? linesInRegion(doc.lines, region).length : 0;

  const changeRegion = useCallback((r: Region | null) => {
    setRegion((prev) => {
      // новое выделение — подставляем следующую неразмеченную строку
      if (r && !prev) {
        setRegionText(doc.pending[0] ?? '');
        setRecognized(undefined);
      }
      return r;
    });
    if (r) setSelection(null);
  }, [doc.pending]);

  const select = useCallback((s: Selection) => {
    setSelection(s);
    if (s) setRegion(null);
  }, []);

  // ---------- правки ----------

  const updateLine = useCallback((id: number, change: (l: ELine) => ELine) => {
    commit((d) => ({ ...d, lines: sortLines(d.lines.map((l) => (l.id === id ? change(l) : l))) }));
  }, [commit]);

  const deleteSelection = useCallback(() => {
    if (!selection) return;
    if (selection.kind === 'line') {
      commit((d) => ({ ...d, lines: d.lines.filter((l) => l.id !== selection.id) }));
      setSelection(null);
    } else {
      const line = doc.lines.find((l) => l.id === selection.id);
      if (!line) return;
      if (line.words.length <= 1) {
        commit((d) => ({ ...d, lines: d.lines.filter((l) => l.id !== selection.id) }));
        setSelection(null);
      } else {
        updateLine(line.id, (l) => fitLine({ ...l, words: l.words.filter((_, i) => i !== selection.index) }));
        setSelection({ kind: 'line', id: line.id });
      }
    }
  }, [selection, doc.lines, commit, updateLine]);

  const insertRegion = useCallback(() => {
    if (!region || !regionText.trim()) return;
    const result = insertText(doc, region, regionText, notes, recognized);
    if (!result) return;
    commit(result.doc);
    if (result.replaced) toast(`Заменено строк: ${result.replaced}`);
    setRegion(null);
    setRegionText('');
    setRecognized(undefined);
    setSelection({ kind: 'line', id: result.created[0].id });
    if (player?.looping) player.pause();
  }, [region, regionText, doc, notes, recognized, commit, player]);

  const recognizeRange = useCallback(async (start: number, end: number) => {
    setRecognizing(true);
    try {
      const { lines } = await api.recognize(id, start, end, {
        model: recognizeOptions.model,
        // без подсказки: на коротком фрагменте Whisper склонен переписывать её вместо того, что слышит
        language: recognizeOptions.language || song?.language || null,
      });
      if (!lines.length) toast('В этом месте нейросеть не услышала слов', 'error');
      return lines;
    } catch (e) {
      toastError(e);
      return null;
    } finally {
      setRecognizing(false);
    }
  }, [id, recognizeOptions, song?.language]);

  const recognizeRegion = async () => {
    if (!region) return;
    const lines = await recognizeRange(region.start, region.end);
    if (!lines?.length) return;
    setRegionText(lines.map(lineText).join('\n'));
    setRecognized(lines.flatMap((l) => l.words));
  };

  const recognizeLine = async (line: ELine) => {
    const lines = await recognizeRange(Math.max(0, line.start - 0.3), Math.min(duration, line.end + 0.3));
    if (!lines?.length) return;
    const words = lines.flatMap((l) => l.words);
    const before = lineText(line);
    updateLine(line.id, (l) => fitLine({ ...l, words }));
    const after = words.map((w) => w.text).join(' ');
    toast(before === after ? 'Нейросеть услышала то же самое' : `Было: «${before}» → стало: «${after}»`, 'success');
  };

  const splitSelected = useCallback(() => {
    if (!selectedLine || !player) return;
    const parts = splitLine(selectedLine, player.time);
    if (!parts) {
      toast('Поставьте курсор между словами строки');
      return;
    }
    commit((d) => ({ ...d, lines: sortLines([...d.lines.filter((l) => l.id !== selectedLine.id), ...parts]) }));
  }, [selectedLine, player, commit]);

  const nextLine = selectedLine ? doc.lines[doc.lines.findIndex((l) => l.id === selectedLine.id) + 1] : undefined;

  const mergeSelected = useCallback(() => {
    if (!selectedLine || !nextLine) return;
    commit((d) => ({ ...d, lines: sortLines([...d.lines.filter((l) => l.id !== selectedLine.id && l.id !== nextLine.id), mergeLines(selectedLine, nextLine)]) }));
  }, [selectedLine, nextLine, commit]);

  const nudge = useCallback((dt: number) => {
    if (!selection) return;
    updateLine(selection.id, (l) => {
      if (selection.kind === 'line') {
        const start = Math.max(0, Math.min(duration - (l.end - l.start), l.start + dt));
        return { ...retimeLine(l, start, start + l.end - l.start), id: l.id };
      }
      const i = selection.index;
      const w = l.words[i];
      const min = i > 0 ? l.words[i - 1].t1 : 0;
      const max = i < l.words.length - 1 ? l.words[i + 1].t0 : duration;
      const t0 = Math.max(min, Math.min(max - (w.t1 - w.t0), w.t0 + dt));
      const words = l.words.map((x, k) => (k === i ? { ...x, t0: Math.round(t0 * 100) / 100, t1: Math.round((t0 + w.t1 - w.t0) * 100) / 100 } : x));
      return fitLine({ ...l, words });
    });
  }, [selection, updateLine, duration]);

  const onDrag = useCallback((phase: 'start' | 'move' | 'end', lines?: ELine[]) => {
    if (phase === 'start') dragBefore.current = doc;
    else if (phase === 'move' && lines) replace({ ...doc, lines });
    else if (phase === 'end') {
      replace({ ...doc, lines: sortLines(doc.lines) });
      if (dragBefore.current) record(dragBefore.current);
      dragBefore.current = null;
    }
  }, [doc, replace, record]);

  // ---------- воспроизведение ----------

  const playRange = useCallback((r: Region, loop: boolean) => {
    if (!player) return;
    if (loop && player.looping) player.pause(r.start);
    else player.play(r.start, loop ? r : null);
    if (!loop) {
      // остановиться в конце фрагмента
      const stopAt = r.end;
      const check = () => {
        if (!player.playing || player.looping) return;
        if (player.time >= stopAt) player.pause(stopAt);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }
  }, [player]);

  const zoom = useCallback((factor: number) => {
    if (!player) return;
    setView((v) => {
      const center = player.playing || (player.time >= v.start && player.time <= v.start + timelineWidth / v.pps)
        ? player.time : v.start + timelineWidth / v.pps / 2;
      const pps = v.pps * factor;
      return clampView({ pps, start: center - (center - v.start) * (v.pps / pps) }, duration, timelineWidth);
    });
  }, [player, timelineWidth, duration]);

  // ---------- сохранение ----------

  const save = useCallback(async () => {
    if (!song || saving) return;
    if (doc.pending.length && !(await confirmDialog(`${doc.pending.length} строк без разметки не попадут в песню. Сохранить без них?`, 'Сохранить'))) return;
    setSaving(true);
    try {
      const current = doc;
      await api.saveLyrics(song.id, { title: meta.title, artist: meta.artist, lines: toLines(current.lines) });
      if (meta.videoOffset !== savedMeta.current.videoOffset) await api.update(song.id, { videoOffset: meta.videoOffset });
      saved.current = current;
      savedMeta.current = meta;
      toast('Сохранено', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  }, [song, saving, doc, meta]);

  const leave = async () => {
    if (dirty && !(await confirmDialog('Есть несохранённые изменения. Выйти без сохранения?', 'Выйти', true))) return;
    navigate('/');
  };

  // ---------- клавиатура ----------

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing = target.matches('input, textarea, select, [contenteditable]');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyS') {
      e.preventDefault();
      void save();
      return;
    }
    if (typing || pasteOpen || retranscribeOpen) return;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.code === 'KeyY') {
      e.preventDefault();
      redo();
    } else if (e.code === 'Space') {
      e.preventDefault();
      player?.toggle();
    } else if (e.code === 'Escape') {
      if (region) setRegion(null);
      else setSelection(null);
      if (player?.looping) player.pause();
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (e.code === 'Enter') {
      e.preventDefault();
      if (region) insertRegion();
      else if (selectedLine) setFocusKey((k) => k + 1);
    } else if (e.code === 'KeyL') {
      const r = region ?? (selectedLine && { start: selectedLine.start, end: selectedLine.end });
      if (r) playRange(r, true);
    } else if (e.code === 'KeyS' && !mod) {
      splitSelected();
    } else if (e.code === 'KeyM' && !mod) {
      mergeSelected();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const dir = e.code === 'ArrowLeft' ? -1 : 1;
      if (selection) nudge(dir * (e.shiftKey ? 0.5 : 0.05));
      else player?.seek(player.time + dir * (e.shiftKey ? 10 : 2));
    } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      zoom(1.5);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      zoom(1 / 1.5);
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keys.current(e);
    addEventListener('keydown', handler);
    return () => removeEventListener('keydown', handler);
  }, []);

  // ---------- распознавание всего текста ----------

  const retranscribe = async (options: Parameters<typeof api.transcribe>[1]) => {
    if (!song) return;
    setRetranscribeOpen(false);
    try {
      setTranscribing(await api.transcribe(song.id, options));
      const done = await waitFor(song.id, (s) => s.status === 'ready' || s.status === 'error', setTranscribing);
      if (done.warning?.startsWith('Не удалось')) throw new Error(done.warning);
      const fresh = await api.song(song.id);
      const next = docFromLines(fresh.lyrics);
      commit(next);
      saved.current = next;
      setSong(fresh);
      setSelection(null);
      toast(`Текст распознан заново: ${fresh.lyrics.length} строк. Отменить — ⌘Z`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setTranscribing(null);
    }
  };

  // ---------- клип ----------

  const uploadClip = async (file: File) => {
    if (!song) return;
    setUploading(0);
    try {
      setSong({ ...song, ...(await api.uploadVideo(song.id, file, setUploading)) });
      setUploading(null);
      const done = await waitFor(song.id, (s) => s.videoStatus !== 'processing');
      setSong((s) => (s ? { ...s, ...done, noteList: s.noteList, lyrics: s.lyrics } : s));
      if (done.videoError) toast(`Клип: ${done.videoError}`, 'error');
      else toast('Клип добавлен', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(null);
    }
  };

  const removeClip = async () => {
    if (!song || !(await confirmDialog('Убрать клип из песни?', 'Убрать', true))) return;
    try {
      const m = await api.deleteVideo(song.id);
      setSong({ ...song, ...m });
      setMeta((x) => ({ ...x, videoOffset: 0 }));
      savedMeta.current = { ...savedMeta.current, videoOffset: 0 };
    } catch (e) {
      toastError(e);
    }
  };

  // ---------- разметка ----------

  if (!song || !loaded || !player) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-white/60">
        <LoaderCircle className="animate-spin" size={32} />
        <p className="text-sm">Загружаем голос и минусовку…</p>
      </div>
    );
  }

  const selectedWord = selection?.kind === 'word' && selectedLine ? selection.index : null;

  return (
    <div className="flex h-full flex-col">
      {/* верхняя панель */}
      <header className="flex items-center gap-3 border-b border-white/8 bg-panel/70 px-4 py-3 backdrop-blur-xl">
        <IconButton label="В каталог" onClick={() => void leave()}><ChevronLeft /></IconButton>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input className={cx(inputClass, 'max-w-xs font-semibold')} value={meta.title} placeholder="Название"
            onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
          <input className={cx(inputClass, 'max-w-xs')} value={meta.artist} placeholder="Исполнитель"
            onChange={(e) => setMeta({ ...meta, artist: e.target.value })} />
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Отменить (⌘Z)" disabled={!history.canUndo} onClick={undo}><Undo2 size={18} /></IconButton>
          <IconButton label="Повторить (⇧⌘Z)" disabled={!history.canRedo} onClick={redo}><Redo2 size={18} /></IconButton>
          <div className="mx-2 h-6 w-px bg-white/10" />
          <Button variant="ghost" icon={<ClipboardPaste size={16} />} onClick={() => setPasteOpen(true)}>Вставить текст</Button>
          <Button variant="ghost" icon={<WandSparkles size={16} />} onClick={() => setRetranscribeOpen(true)}>Распознать заново</Button>
          <Button variant="secondary" icon={<Play size={16} />} onClick={async () => {
            if (dirty && !(await confirmDialog('Сохранить изменения перед игрой?', 'Сохранить'))) return;
            if (dirty) await save();
            navigate(`/play/${song.id}`);
          }}>Спеть</Button>
          <Button variant="primary" icon={saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />} disabled={!dirty || saving} onClick={() => void save()}>
            {dirty ? 'Сохранить' : 'Сохранено'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <Preview song={song} player={player} lines={doc.lines} offset={meta.videoOffset} />

          {/* транспорт */}
          <div className="flex flex-wrap items-center gap-3 border-t border-white/8 bg-panel/50 px-4 py-2">
            <button
              type="button"
              className="flex size-10 items-center justify-center rounded-full bg-white text-black transition hover:scale-105"
              title="Пауза / воспроизведение (пробел)"
              onClick={() => player.toggle()}
            >
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
            </button>
            <Clock player={player} duration={duration} />
            {looping && <span className="flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-1 text-xs text-amber-200"><Repeat size={12} />по кругу</span>}
            <div className="mx-1 h-6 w-px bg-white/10" />
            <MixSlider icon={<Headphones size={14} />} label="Голос" value={mix.voice} onChange={(voice) => setMix({ ...mix, voice })} />
            <MixSlider icon={<Music2 size={14} />} label="Минус" value={mix.minus} onChange={(minus) => setMix({ ...mix, minus })} />
            <div className="ml-auto flex items-center gap-1">
              <IconButton label="Следовать за курсором" active={follow} size="sm" onClick={() => setFollow(!follow)}><Crosshair size={16} /></IconButton>
              <IconButton label="Уменьшить (−)" size="sm" onClick={() => zoom(1 / 1.5)}><ZoomOut size={16} /></IconButton>
              <IconButton label="Увеличить (+)" size="sm" onClick={() => zoom(1.5)}><ZoomIn size={16} /></IconButton>
              <IconButton label="Вся песня" size="sm" onClick={() => setView(clampView({ start: 0, pps: 0 }, duration, timelineWidth))}><Expand size={16} /></IconButton>
            </div>
          </div>

          <div ref={timelineBox} className="border-t border-white/8">
            <Timeline
              duration={duration}
              peaks={loaded.peaks}
              notes={notes}
              lines={doc.lines}
              selection={selection}
              region={region}
              view={view}
              player={player}
              follow={follow}
              onView={setView}
              onSeek={(t) => player.seek(t)}
              onRegion={changeRegion}
              onSelect={select}
              onDrag={onDrag}
              onOpen={(lineId) => {
                setSelection({ kind: 'line', id: lineId });
                setFocusKey((k) => k + 1);
              }}
            />
          </div>
          <div className="bg-[#0e0c18] px-4 pb-3 pt-1">
            <Overview duration={duration} peaks={loaded.peaks} lines={doc.lines} view={view} width={timelineWidth} onView={setView} />
            <p className="mt-2 truncate text-[11px] text-white/35">
              Протяните по волне — выделить фрагмент · Enter — вставить строку · L — по кругу · S — разрезать · M — склеить · ← → — сдвиг · Delete — удалить · ⌘/Ctrl + колесо — масштаб
            </p>
          </div>
        </main>

        {/* инспектор */}
        <aside className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-l border-white/8 bg-panel/60">
          {region ? (
            <RegionPanel
              region={region}
              text={regionText}
              onText={(t) => {
                setRegionText(t);
                if (!t.trim()) setRecognized(undefined);
              }}
              recognizing={recognizing}
              onRecognize={() => void recognizeRegion()}
              onInsert={insertRegion}
              onPlay={() => playRange(region, false)}
              onLoop={() => playRange(region, true)}
              looping={looping}
              replaced={replacedCount}
              pending={doc.pending.length}
              options={recognizeOptions}
              onOptions={(o) => {
                setRecognizeOptions(o);
                saveRecognizeOptions(o);
              }}
            />
          ) : selectedLine && selectedWord !== null && selectedLine.words[selectedWord] ? (
            <WordPanel
              line={selectedLine}
              index={selectedWord}
              onBack={() => setSelection({ kind: 'line', id: selectedLine.id })}
              onDelete={deleteSelection}
              onChange={(word) => updateLine(selectedLine.id, (l) => fitLine({ ...l, words: l.words.map((w, i) => (i === selectedWord ? word : w)) }))}
            />
          ) : selectedLine ? (
            <LinePanel
              line={selectedLine}
              focusKey={focusKey}
              onText={(text) => updateLine(selectedLine.id, (l) => ({ ...rewordLine(l, text, notes), id: l.id }))}
              onTimes={(start, end) => updateLine(selectedLine.id, (l) => ({ ...retimeLine(l, start, end), id: l.id }))}
              onPlay={() => playRange(selectedLine, false)}
              onLoop={() => playRange(selectedLine, true)}
              looping={looping}
              onRecognize={() => void recognizeLine(selectedLine)}
              recognizing={recognizing}
              onSplit={splitSelected}
              onMerge={mergeSelected}
              canMerge={!!nextLine}
              onDelete={deleteSelection}
              onWord={(index) => {
                setSelection({ kind: 'word', id: selectedLine.id, index });
                player.seek(selectedLine.words[index].t0);
              }}
            />
          ) : (
            <section className="border-b border-white/8 p-5 text-sm text-white/55">
              <p className="font-semibold text-white/80">Как размечать</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Протяните мышью по волне голоса там, где поют, — справа появится поле для слов.</li>
                <li>Впишите слова или нажмите «Распознать», затем Enter.</li>
                <li>Строки и слова можно тянуть мышью и растягивать за края.</li>
                <li>Серые участки волны — голос, для которого ещё нет текста.</li>
              </ul>
            </section>
          )}

          <CurrentLine player={player} lines={doc.lines}>
            {(currentId) => (
              <LinesList
                lines={doc.lines}
                pending={doc.pending}
                selectedId={selection?.id ?? null}
                currentId={currentId}
                onPick={(l) => {
                  select({ kind: 'line', id: l.id });
                  player.seek(l.start);
                  setView((v) => (l.start < v.start || l.start > v.start + timelineWidth / v.pps
                    ? clampView({ ...v, start: l.start - 1 }, duration, timelineWidth) : v));
                }}
                onRemovePending={(i) => commit((d) => ({ ...d, pending: d.pending.filter((_, k) => k !== i) }))}
                onClearPending={() => commit((d) => ({ ...d, pending: [] }))}
              />
            )}
          </CurrentLine>

          <VideoPanel
            song={song}
            offset={meta.videoOffset}
            onOffset={(videoOffset) => setMeta({ ...meta, videoOffset })}
            onUpload={(file) => void uploadClip(file)}
            onRemove={() => void removeClip()}
            uploading={uploading}
          />
        </aside>
      </div>

      <PasteDialog
        open={pasteOpen}
        doc={doc}
        notes={notes}
        onClose={() => setPasteOpen(false)}
        onApply={(next) => {
          commit(next);
          setPasteOpen(false);
          setSelection(null);
        }}
      />
      <RetranscribeDialog
        open={retranscribeOpen}
        onClose={() => setRetranscribeOpen(false)}
        onSubmit={(o) => void retranscribe(o)}
        initialLanguage={song.language}
      />
      {transcribing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-96 rounded-3xl border border-white/10 bg-panel p-6">
            <p className="flex items-center gap-2 font-bold"><WandSparkles size={18} className="text-accent" />Распознаём текст</p>
            <p className="mt-1 text-sm text-white/55">{transcribing.stage ?? 'В очереди'} · {transcribing.progress ?? 0}%</p>
            <ProgressBar className="mt-4" value={transcribing.progress ?? 0} />
          </div>
        </div>
      )}
    </div>
  );
}

function MixSlider({ icon, label, value, onChange }: { icon: ReactNode; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-white/60" title={`Громкость: ${label.toLowerCase()}`}>
      {icon}
      <span className="hidden lg:inline">{label}</span>
      <input
        type="range"
        className="w-20"
        min={0}
        max={1.5}
        step={0.01}
        value={value}
        style={{ '--fill': `${(value / 1.5) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

// Часы перерисовываются сами, не трогая остальной редактор.
function Clock({ player, duration }: { player: EditorPlayer; duration: number }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (el.current) el.current.textContent = stamp(player.time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [player]);
  return (
    <span className="text-sm tabular-nums">
      <span ref={el} className="font-semibold" />
      <span className="text-white/40"> / {stamp(duration)}</span>
    </span>
  );
}

// Сообщает текущую строку только когда она меняется.
function CurrentLine({ player, lines, children }: { player: EditorPlayer; lines: ELine[]; children: (id: number | null) => ReactNode }) {
  const [current, setCurrent] = useState<number | null>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const t = player.time;
      const line = lines.find((l) => t >= l.start && t < l.end);
      setCurrent(line?.id ?? null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [player, lines]);
  return <>{children(current)}</>;
}

// Предпросмотр: клип (со сдвигом) и текущая строка с подсветкой спетых слов.
function Preview({ song, player, lines, offset }: { song: Song; player: EditorPlayer; lines: ELine[]; offset: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<{ id: number | null; sung: number; next: number | null }>({ id: null, sung: -1, next: null });
  const url = videoUrl(song);
  const live = useRef({ lines, offset });
  live.current = { lines, offset };

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const t = player.time;
      const { lines: ls, offset: off } = live.current;
      const index = ls.findIndex((l) => l.end + 0.3 > t);
      const line = index >= 0 && ls[index].start - t < 3 ? ls[index] : null;
      const sung = line ? line.words.filter((w) => w.t0 <= t).length - 1 : -1;
      const next = line ? ls[index + 1]?.id ?? null : index >= 0 ? ls[index].id : null;
      setState((s) => (s.id === (line?.id ?? null) && s.sung === sung && s.next === next ? s : { id: line?.id ?? null, sung, next }));

      const v = video.current;
      if (v && v.readyState >= 1) {
        const target = t + off;
        if (!player.playing || target < 0 || target > v.duration) {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - Math.max(0, target)) > 0.05 && !v.seeking) v.currentTime = Math.max(0, Math.min(v.duration || 0, target));
        } else {
          if (v.paused) void v.play().catch(() => {});
          if (Math.abs(v.currentTime - target) > 0.25 && !v.seeking) v.currentTime = target;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [player]);

  const line = lines.find((l) => l.id === state.id);
  const next = lines.find((l) => l.id === state.next);

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-4">
      <div className="relative aspect-video h-full max-h-full max-w-full overflow-hidden rounded-2xl bg-[#120d24] shadow-2xl">
        {url ? (
          <video ref={video} src={url} muted playsInline preload="auto" className="absolute inset-0 size-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet-900/60 via-[#120d24] to-fuchsia-900/40" />
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-6 pb-5 pt-16 text-center">
          {line ? (
            <p className="text-xl font-extrabold leading-snug drop-shadow-lg sm:text-2xl">
              {line.words.map((w, i) => (
                <span key={i} className={i <= state.sung ? 'text-amber-300' : 'text-white'}>{w.text} </span>
              ))}
            </p>
          ) : (
            <p className="text-sm text-white/40">♪</p>
          )}
          {next && <p className="mt-1 truncate text-sm font-semibold text-white/45">{lineText(next)}</p>}
        </div>
      </div>
    </div>
  );
}

// Вставка всего текста песни: сохранить разметку (если строк столько же) или разметить заново.
function PasteDialog({ open, doc, notes, onClose, onApply }: { open: boolean; doc: Doc; notes: Note[]; onClose: () => void; onApply: (d: Doc) => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText([...doc.lines.map(lineText), ...doc.pending].join('\n'));
  }, [open, doc]);
  const rows = useMemo(() => text.split('\n').map((s) => s.trim()).filter(Boolean), [text]);
  const sameCount = rows.length === doc.lines.length && doc.lines.length > 0;
  return (
    <Modal open={open} onClose={onClose} title="Текст песни целиком" width="max-w-2xl">
      <textarea
        className="h-80 w-full resize-none rounded-xl border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-white outline-none focus:border-accent"
        placeholder="Одна строка песни — одна строка текста"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-2 text-xs text-white/45">
        Строк: {rows.length}, размечено сейчас: {doc.lines.length}.{' '}
        {sameCount ? 'Число совпадает — можно исправить слова и сохранить время.' : 'Чтобы сохранить время, число строк должно совпадать.'}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button
          disabled={!rows.length}
          onClick={() => onApply({ lines: [], pending: rows })}
          title="Строки появятся в очереди: выделяйте их место на волне по порядку"
        >
          Разметить заново
        </Button>
        <Button
          variant="primary"
          disabled={!sameCount}
          onClick={() => onApply({ lines: doc.lines.map((l, i) => ({ ...rewordLine(l, rows[i], notes), id: l.id })), pending: [] })}
        >
          Заменить слова, сохранив время
        </Button>
      </div>
    </Modal>
  );
}

