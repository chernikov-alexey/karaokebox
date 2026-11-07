// Каталог песен: загрузка аудио и видео, прогресс обработки, запуск и редактирование.
import {
  AlertTriangle, Clapperboard, Download, EllipsisVertical, Film, LoaderCircle, Mic, Music, Play, RotateCcw, Search,
  SlidersHorizontal, SquarePen, Trash2, Upload, WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api, downloadUrl, isMedia, isVideo, songLabel, videoUrl, type SongMeta } from '../api';
import { MicToggle } from '../components/MicToggle';
import { RetranscribeDialog } from '../components/RetranscribeDialog';
import { SettingsPanel } from '../components/SettingsPanel';
import { Button, IconButton, ProgressBar, confirmDialog, cx, toast, toastError } from '../components/ui';
import { clock, hue, semitones } from '../lib/format';
import { useSettings } from '../settings';
import { navigate } from '../router';

const busy = (s: SongMeta) => s.status === 'queued' || s.status === 'processing' || s.videoStatus === 'processing';

export function useSongs() {
  const [songs, setSongs] = useState<SongMeta[] | null>(null);
  const timer = useRef(0);
  const load = useCallback(async () => {
    clearTimeout(timer.current);
    let next: SongMeta[];
    try {
      next = await api.songs();
    } catch {
      timer.current = window.setTimeout(load, 3000);
      return;
    }
    setSongs(next);
    if (next.some(busy)) timer.current = window.setTimeout(load, 1500);
  }, []);
  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);
  return { songs, reload: load };
}

interface Uploading {
  id: number;
  name: string;
  progress: number;
}

export function Library() {
  const { songs, reload } = useSongs();
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [settings, setSettings] = useState(false);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const [retranscribe, setRetranscribe] = useState<SongMeta | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const clipInput = useRef<HTMLInputElement>(null);
  const clipFor = useRef<SongMeta | null>(null);

  const upload = useCallback(async (files: File[]) => {
    const media = files.filter(isMedia);
    if (files.length && !media.length) toast('Нужен аудио- или видеофайл', 'error');
    for (const file of media) {
      const id = Math.random();
      setUploads((u) => [...u, { id, name: file.name, progress: 0 }]);
      try {
        await api.upload(file, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))));
        if (isVideo(file)) toast(`«${file.name}»: клип из видео станет видеорядом песни`, 'success');
      } catch (e) {
        toastError(e);
      } finally {
        setUploads((u) => u.filter((x) => x.id !== id));
        void reload();
      }
    }
  }, [reload]);

  const uploadClip = async (song: SongMeta, file: File) => {
    try {
      await api.uploadVideo(song.id, file, () => {});
      toast('Клип загружен, готовим его для показа', 'success');
    } catch (e) {
      toastError(e);
    }
    void reload();
  };

  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void upload([...(e.dataTransfer?.files ?? [])]);
    };
    addEventListener('dragenter', enter);
    addEventListener('dragleave', leave);
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragenter', enter);
      removeEventListener('dragleave', leave);
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, [upload]);

  const q = query.trim().toLowerCase();
  const shown = (songs ?? []).filter((s) => !q || songLabel(s).toLowerCase().includes(q)).slice().reverse();

  return (
    <div className="relative min-h-full overflow-hidden">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-1/4 -top-1/3 size-[70vmax] rounded-full bg-violet-600/20 blur-[120px] [animation:aurora_40s_linear_infinite]" />
        <div className="absolute -bottom-1/3 -right-1/4 size-[60vmax] rounded-full bg-pink-600/15 blur-[120px] [animation:aurora_55s_linear_infinite_reverse]" />
      </div>

      <header className="sticky top-0 z-30 border-b border-white/5 bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-2xl bg-gradient-accent shadow-lg shadow-fuchsia-500/30">
              <Mic size={20} />
            </div>
            <div>
              <h1 className="text-xl font-extrabold tracking-tight">Караоке</h1>
              <p className="text-xs text-white/45">Любая песня — без голоса, с нотами и текстом</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                className="h-10 w-64 rounded-xl border border-white/10 bg-white/5 pl-9 pr-3 text-sm outline-none placeholder:text-white/35 focus:border-accent"
                placeholder="Поиск песни"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <MicToggle />
            <IconButton label="Настройки звука" onClick={() => setSettings(true)}><SlidersHorizontal size={18} /></IconButton>
            <Button variant="primary" icon={<Upload size={16} />} onClick={() => fileInput.current?.click()}>
              Добавить
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {songs && !songs.length && !uploads.length ? (
          <EmptyState onAdd={() => fileInput.current?.click()} />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {uploads.map((u) => (
              <div key={u.id} className="overflow-hidden rounded-3xl border border-white/10 bg-panel/80">
                <div className="flex aspect-video items-center justify-center bg-white/5">
                  <Upload className="animate-bounce text-white/40" />
                </div>
                <div className="space-y-3 p-4">
                  <p className="truncate font-semibold">{u.name}</p>
                  <p className="text-xs text-white/50">Загрузка {Math.round(u.progress * 100)}%</p>
                  <ProgressBar value={u.progress * 100} />
                </div>
              </div>
            ))}
            {shown.map((song) => (
              <SongCard
                key={song.id}
                song={song}
                onChanged={reload}
                onAddClip={() => {
                  clipFor.current = song;
                  clipInput.current?.click();
                }}
                onRetranscribe={() => setRetranscribe(song)}
              />
            ))}
          </div>
        )}
        <p className="mt-10 text-center text-xs text-white/35">
          Перетащите сюда MP3 или видеоклип. Из клипа берётся звук, а само видео становится видеорядом песни.
        </p>
      </main>

      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept="audio/*,video/*,.mp3,.m4a,.flac,.mkv"
        onChange={(e) => {
          void upload([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <input
        ref={clipInput}
        type="file"
        hidden
        accept="video/*,.mkv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && clipFor.current) void uploadClip(clipFor.current, file);
          e.target.value = '';
        }}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur">
          <div className="rounded-3xl border-2 border-dashed border-accent/70 px-16 py-12 text-center">
            <Upload size={40} className="mx-auto mb-4 text-accent" />
            <p className="text-xl font-bold">Отпустите, чтобы добавить</p>
            <p className="mt-1 text-sm text-white/50">Аудио или видеоклип</p>
          </div>
        </div>
      )}

      <SettingsPanel open={settings} onClose={() => setSettings(false)} />
      <RetranscribeDialog
        open={!!retranscribe}
        onClose={() => setRetranscribe(null)}
        initialLanguage={retranscribe?.language}
        onSubmit={async (options) => {
          const song = retranscribe!;
          setRetranscribe(null);
          try {
            await api.transcribe(song.id, options);
            toast('Текст отправлен на распознавание', 'success');
          } catch (e) {
            toastError(e);
          }
          void reload();
        }}
      />
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-xl rounded-3xl border border-white/10 bg-panel/60 p-10 text-center backdrop-blur">
      <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-3xl bg-gradient-accent">
        <Music size={28} />
      </div>
      <h2 className="text-2xl font-extrabold">Каталог пуст</h2>
      <p className="mt-2 text-white/55">
        Добавьте песню или клип. Нейросеть уберёт голос, разложит мелодию по нотам и распознает текст.
      </p>
      <Button variant="primary" size="lg" className="mt-8" icon={<Upload size={18} />} onClick={onAdd}>
        Выбрать файл
      </Button>
    </div>
  );
}

function Cover({ song, hover }: { song: SongMeta; hover: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const url = videoUrl(song);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (hover) void v.play().catch(() => {});
    else v.pause();
  }, [hover]);
  const h = hue(song.title);
  return (
    <div
      className="relative aspect-video overflow-hidden"
      style={{ background: `linear-gradient(135deg, hsl(${h} 70% 35%), hsl(${(h + 60) % 360} 80% 22%))` }}
    >
      {url ? (
        <video ref={video} src={`${url}#t=20`} muted loop playsInline preload="metadata" className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-6xl font-black text-white/15">{song.title.slice(0, 1).toUpperCase()}</span>
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
    </div>
  );
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warn' }) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold backdrop-blur',
      tone === 'warn' ? 'bg-amber-500/20 text-amber-200' : 'bg-black/40 text-white/80',
    )}>
      {children}
    </span>
  );
}

function SongCard({ song, onChanged, onAddClip, onRetranscribe }: {
  song: SongMeta;
  onChanged: () => void;
  onAddClip: () => void;
  onRetranscribe: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const ready = song.status === 'ready';
  const key = useSettings((s) => s.keys[song.id] ?? 0);

  const download = (url: string) => {
    setMenu(false);
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.click();
    toast(key && url.includes('key=') ? 'Готовим минус в другой тональности…' : 'Скачивание началось');
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('click', close);
    addEventListener('scroll', close, true);
    addEventListener('resize', close);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('click', close);
      removeEventListener('scroll', close, true);
      removeEventListener('resize', close);
      removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const run = (action: () => Promise<unknown>) => async () => {
    setMenu(false);
    try {
      await action();
    } catch (e) {
      toastError(e);
    }
    onChanged();
  };

  const remove = run(async () => {
    if (await confirmDialog(<>Удалить «{songLabel(song)}» вместе с минусовкой и клипом?</>, 'Удалить', true)) await api.remove(song.id);
  });

  return (
    <article
      className={cx(
        'group relative rounded-3xl border border-white/10 bg-panel/80 backdrop-blur transition-[border-color,box-shadow]',
        ready && 'hover:border-white/25 hover:shadow-2xl hover:shadow-violet-900/30',
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button type="button" className="block w-full overflow-hidden rounded-t-3xl text-left" disabled={!ready} onClick={() => navigate(`/play/${song.id}`)}>
        <Cover song={song} hover={hover && ready} />
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {song.video && <Badge><Film size={11} />клип</Badge>}
          {song.videoStatus === 'processing' && <Badge><LoaderCircle size={11} className="animate-spin" />готовим клип</Badge>}
          {ready && (song.warning || !song.lines) && <Badge tone="warn"><AlertTriangle size={11} />без текста</Badge>}
        </div>
        {ready && (
          <div className="absolute left-1/2 top-[28%] flex size-14 -translate-x-1/2 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-2xl transition group-hover:opacity-100">
            <Play size={22} fill="currentColor" className="ml-0.5" />
          </div>
        )}
      </button>

      <div className="p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-bold" title={song.title}>{song.title}</h3>
            <p className="truncate text-sm text-white/50">{song.artist || 'Неизвестный исполнитель'}</p>
          </div>
          {ready && (
            <IconButton label="Редактор текста" size="sm" onClick={() => navigate(`/edit/${song.id}`)}>
              <SquarePen size={16} />
            </IconButton>
          )}
          <div ref={anchor}>
            <IconButton label="Ещё" size="sm" active={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}>
              <EllipsisVertical size={16} />
            </IconButton>
            {menu && (
              <Popover anchor={anchor}>
                {ready && <MenuItem icon={<SquarePen size={15} />} onClick={() => navigate(`/edit/${song.id}`)}>Редактор текста</MenuItem>}
                {ready && <MenuItem icon={<WandSparkles size={15} />} onClick={() => { setMenu(false); onRetranscribe(); }}>Распознать текст заново</MenuItem>}
                <MenuItem icon={<Clapperboard size={15} />} onClick={() => { setMenu(false); onAddClip(); }}>
                  {song.video ? 'Заменить клип' : 'Добавить клип'}
                </MenuItem>
                {song.video && <MenuItem icon={<Film size={15} />} onClick={run(() => api.deleteVideo(song.id))}>Убрать клип</MenuItem>}
                {ready && <MenuItem icon={<Download size={15} />} onClick={() => download(downloadUrl(song.id, 'minus'))}>Скачать минус</MenuItem>}
                {ready && key !== 0 && (
                  <MenuItem icon={<Download size={15} />} onClick={() => download(downloadUrl(song.id, 'minus', key))}>
                    Скачать минус в тоне {semitones(key)}
                  </MenuItem>
                )}
                <MenuItem icon={<Trash2 size={15} />} danger onClick={remove}>Удалить песню</MenuItem>
              </Popover>
            )}
          </div>
        </div>

        {ready && (
          <p className="mt-3 text-xs text-white/40">
            {clock(song.duration ?? 0)} · {song.notes} нот · {song.lines} строк
          </p>
        )}
        {(song.status === 'queued' || song.status === 'processing') && (
          <div className="mt-3 space-y-2">
            <p className="flex justify-between text-xs text-white/55">
              <span>{song.stage}</span>
              <span className="tabular-nums">{song.progress}%</span>
            </p>
            <ProgressBar value={song.progress} />
          </div>
        )}
        {song.status === 'error' && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="truncate text-xs text-rose-300" title={song.error ?? ''}>Ошибка обработки</p>
            <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={run(() => api.retry(song.id))}>Повторить</Button>
          </div>
        )}
        {song.videoError && <p className="mt-2 truncate text-xs text-amber-300" title={song.videoError}>Клип: {song.videoError}</p>}
      </div>
    </article>
  );
}

// Выпадающее меню поверх всей страницы: карточки его не обрезают и не перекрывают.
function Popover({ anchor, children }: { anchor: RefObject<HTMLElement | null>; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const m = box.current?.getBoundingClientRect();
    if (!a || !m) return;
    const below = a.bottom + 6;
    const top = below + m.height > innerHeight - 8 ? Math.max(8, a.top - 6 - m.height) : below;
    const left = Math.min(innerWidth - m.width - 8, Math.max(8, a.right - m.width));
    setPos({ top, left });
  }, [anchor]);
  return createPortal(
    <div
      ref={box}
      className="fixed z-50 w-60 overflow-hidden rounded-2xl border border-white/10 bg-panel-2 py-1 shadow-2xl"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-white/8', danger ? 'text-rose-300' : 'text-white/85')}
    >
      {icon}
      {children}
    </button>
  );
}
