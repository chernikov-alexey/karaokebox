// Экран песни: подготовка (тональность, микрофоны), игра поверх клипа и результаты.
import {
  ChevronLeft, LoaderCircle, Maximize, Mic, Minus, Pause, Play as PlayIcon, Plus, RotateCcw, RotateCw, SlidersHorizontal, Square,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, songLabel, stemUrl, videoUrl, type Song } from '../api';
import { engine, loadBuffer, useDevices } from '../audio/engine';
import { MicToggle, toggleMics } from '../components/MicToggle';
import { MicMeter, SettingsPanel } from '../components/SettingsPanel';
import { Button, IconButton, cx, toastError } from '../components/ui';
import { Game, PLAYER_COLORS, type PlayerResult } from '../game/game';
import { clock, semitones } from '../lib/format';
import { navigate } from '../router';
import { useSettings } from '../settings';

type Phase = 'loading' | 'lobby' | 'playing' | 'results';

interface Buffers {
  key: number;
  minus: AudioBuffer;
  vocals: AudioBuffer;
}

const toggleFullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
};

export function Play({ id }: { id: string }) {
  const [song, setSong] = useState<Song | null>(null);
  const [buffers, setBuffers] = useState<Buffers | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [paused, setPaused] = useState(false);
  const [results, setResults] = useState<PlayerResult[] | null>(null);
  const [settings, setSettings] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [clockText, setClockText] = useState('0:00');
  const [position, setPosition] = useState(0);
  const [osd, setOsd] = useState<{ text: string; id: number } | null>(null);
  const key = useSettings((s) => s.keys[id] ?? 0);
  const setKey = useSettings((s) => s.setKey);
  const devices = useDevices();

  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const game = useRef<Game | null>(null);

  useEffect(() => {
    api.song(id).then((s) => {
      if (s.status !== 'ready') throw new Error('Песня ещё не готова');
      setSong(s);
    }).catch((e) => {
      toastError(e);
      navigate('/');
    });
  }, [id]);

  // минусовка и голос в выбранной тональности
  useEffect(() => {
    if (!song) return;
    const abort = new AbortController();
    setPhase((p) => (p === 'lobby' ? 'loading' : p));
    Promise.all([loadBuffer(stemUrl(id, 'minus', key), abort.signal), loadBuffer(stemUrl(id, 'vocals', key), abort.signal)])
      .then(([minus, vocals]) => {
        setBuffers({ key, minus, vocals });
        setPhase((p) => (p === 'loading' ? 'lobby' : p));
        // тональность сменили прямо во время песни
        if (game.current && game.current.key !== key) game.current.setTrack(minus, vocals, key);
      })
      .catch((e) => {
        if (!abort.signal.aborted) toastError(e);
      });
    return () => abort.abort();
  }, [song, id, key]);

  const finish = useCallback((r: PlayerResult[]) => {
    game.current = null;
    setPaused(false);
    setResults(r);
    setPhase('results');
    video.current?.pause();
  }, []);

  const start = useCallback(async () => {
    if (!song || !buffers) return;
    engine.wake();
    await engine.ensureMics();
    game.current?.stop();
    const mics = engine.mics.flatMap((mic, slot) => (mic ? [{ mic, slot }] : []));
    game.current = new Game(song, buffers.minus, buffers.vocals, mics, buffers.key, finish);
    setPaused(false);
    setResults(null);
    setPhase('playing');
  }, [song, buffers, finish]);

  const togglePause = useCallback(() => {
    const g = game.current;
    if (!g) return;
    g.togglePause();
    setPaused(g.paused);
  }, []);

  const seekTo = useCallback((t: number, label?: string) => {
    const g = game.current;
    if (!g) return;
    g.seek(t);
    setPosition(Math.max(0, Math.floor(t)));
    if (label) setOsd({ text: label, id: Math.random() });
  }, []);

  const seekBy = useCallback((dt: number) => {
    const g = game.current;
    if (!g) return;
    const t = Math.max(0, Math.min(g.duration - 0.5, g.time + dt));
    seekTo(t, `${dt < 0 ? '⏪' : '⏩'} ${clock(t)}`);
  }, [seekTo]);

  useEffect(() => {
    if (!osd) return;
    const timer = setTimeout(() => setOsd(null), 900);
    return () => clearTimeout(timer);
  }, [osd]);

  useEffect(() => () => game.current?.stop(), []);

  // микрофон включили или выключили посреди песни — игра подхватывает сразу
  useEffect(() => {
    game.current?.setMics(engine.mics);
  }, [devices.active]);

  // кадр игры и синхронизация клипа со звуком
  useEffect(() => {
    if (phase !== 'playing') return;
    let frame = 0;
    let lastClock = '';
    const loop = () => {
      const g = game.current;
      const c = canvas.current;
      if (g && c) {
        const dpr = Math.min(2, devicePixelRatio || 1);
        const w = Math.round(c.clientWidth * dpr);
        const h = Math.round(c.clientHeight * dpr);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const t = g.draw(c.getContext('2d')!, w, h);
        const text = `${clock(t)} / ${clock(g.duration)}`;
        if (text !== lastClock) {
          setClockText((lastClock = text));
          setPosition(Math.max(0, Math.floor(t)));
        }
        syncVideo(video.current, t + (song?.videoOffset ?? 0), g.paused || g.finished);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [phase, song]);

  // панель управления прячется, пока мышь не двигается
  useEffect(() => {
    if (phase !== 'playing') return;
    let timer = window.setTimeout(() => setChrome(false), 2500);
    const move = () => {
      setChrome(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setChrome(false), 2500);
    };
    addEventListener('mousemove', move);
    return () => {
      clearTimeout(timer);
      removeEventListener('mousemove', move);
      setChrome(true);
    };
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // ползунки не перехватывают стрелки и пробел: в караоке они мотают песню и ставят паузу
      if (target.matches('input:not([type=range]), select, textarea')) return;
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && phase === 'playing') {
        e.preventDefault();
        seekBy((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 15 : 5));
        return;
      }
      if (target.matches('input') && e.code !== 'Space') return;
      if (e.code === 'KeyF') toggleFullscreen();
      else if (e.code === 'KeyM') void toggleMics();
      else if (e.code === 'Space') {
        e.preventDefault();
        if (phase === 'playing') togglePause();
        else if (phase === 'lobby') void start();
      } else if (e.code === 'Escape' && phase === 'playing') togglePause();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [phase, start, togglePause, seekBy]);

  const clip = song && videoUrl(song);

  return (
    <div className={cx('fixed inset-0 overflow-hidden bg-black', phase === 'playing' && !chrome && !paused && !settings && 'cursor-none')}>
      {clip ? (
        <video ref={video} src={clip} muted playsInline preload="auto" className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="absolute inset-0 overflow-hidden bg-[#0b0718]">
          <div className="absolute -left-1/4 -top-1/4 size-[80vmax] rounded-full bg-violet-600/35 blur-[140px] [animation:aurora_30s_linear_infinite]" />
          <div className="absolute -bottom-1/3 -right-1/4 size-[70vmax] rounded-full bg-fuchsia-600/25 blur-[140px] [animation:aurora_42s_linear_infinite_reverse]" />
          <div className="absolute left-1/3 top-1/2 size-[40vmax] rounded-full bg-cyan-500/15 blur-[120px] [animation:aurora_36s_linear_infinite]" />
        </div>
      )}
      {/* с открытой панелью сцена ужимается, чтобы текст и ноты не прятались под ней */}
      <canvas
        ref={canvas}
        className={cx('absolute inset-y-0 left-0 h-full', phase !== 'playing' && 'hidden')}
        style={{ width: settings ? 'calc(100% - min(24rem, 100%))' : '100%' }}
      />

      {/* верхняя панель */}
      <div className={cx(
        'absolute left-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-5 pb-10 pt-4 transition-opacity duration-300',
        phase === 'playing' && !chrome && !paused && !settings ? 'opacity-0' : 'opacity-100',
      )} style={{ right: settings ? 'min(24rem, 100%)' : 0 }}>
        <IconButton label="В каталог" onClick={() => navigate('/')}><ChevronLeft /></IconButton>
        <div className="min-w-0">
          <p className="truncate font-bold">{song?.title}</p>
          <p className="truncate text-xs text-white/55">{song?.artist}</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {phase === 'playing' && (
            <>
              <span className="mr-2 text-sm tabular-nums text-white/60">{clockText}</span>
              {key !== 0 && <span className="mr-2 rounded-full bg-white/10 px-2 py-1 text-xs">Тон {semitones(key)}</span>}
              <IconButton label="Назад 5 с (←)" onClick={() => seekBy(-5)}><RotateCcw size={17} /></IconButton>
              <IconButton label={paused ? 'Продолжить' : 'Пауза (пробел)'} onClick={togglePause}>
                {paused ? <PlayIcon size={18} /> : <Pause size={18} />}
              </IconButton>
              <IconButton label="Вперёд 5 с (→)" onClick={() => seekBy(5)}><RotateCw size={17} /></IconButton>
              <IconButton label="Закончить песню" onClick={() => game.current?.finish()}><Square size={16} /></IconButton>
            </>
          )}
          <div className="mr-1"><MicToggle compact /></div>
          <IconButton label="Звук и микрофон" active={settings} onClick={() => setSettings(!settings)}><SlidersHorizontal size={18} /></IconButton>
          <IconButton label="Во весь экран (F)" onClick={toggleFullscreen}><Maximize size={18} /></IconButton>
        </div>
      </div>

      {(phase === 'loading' || phase === 'lobby') && song && (
        <Lobby
          song={song}
          loading={phase === 'loading'}
          keyShift={key}
          onKey={(k) => setKey(id, k)}
          micActive={devices.active}
          micError={devices.error}
          onStart={() => void start()}
        />
      )}
      {!song && <Centered><LoaderCircle className="animate-spin text-white/60" size={32} /></Centered>}

      {osd && (
        <div key={osd.id} className="pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2 rounded-2xl bg-black/60 px-5 py-2.5 text-lg font-bold tabular-nums backdrop-blur">
          {osd.text}
        </div>
      )}

      {/* пауза не закрывает экран: музыка стоит, а микрофон работает — можно примериться к нотам */}
      {phase === 'playing' && paused && (
        <div className="pointer-events-none absolute bottom-8 left-0 z-20 flex justify-center px-4" style={{ right: settings ? 'min(24rem, 100%)' : 0 }}>
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-panel/85 p-2 pl-4 shadow-2xl backdrop-blur-xl">
            <div className="mr-2">
              <p className="flex items-center gap-2 text-sm font-bold"><Pause size={14} />Пауза</p>
              <p className="text-xs text-white/50">Пойте — видно, какую ноту берёте. ← → — выбрать место</p>
            </div>
            <Button variant="primary" icon={<PlayIcon size={16} />} onClick={togglePause}>Продолжить</Button>
            {!settings && <Button icon={<SlidersHorizontal size={16} />} onClick={() => setSettings(true)}>Микрофон и звук</Button>}
            <IconButton label="Сначала" onClick={() => { game.current?.stop(); void start(); }}><RotateCcw size={17} /></IconButton>
            <IconButton label="Закончить и узнать оценку" onClick={() => game.current?.finish()}><Square size={15} /></IconButton>
          </div>
        </div>
      )}

      {phase === 'results' && song && results && (
        <Results song={song} results={results} onAgain={() => void start()} onLobby={() => setPhase('lobby')} />
      )}

      <SettingsPanel
        open={settings}
        onClose={() => setSettings(false)}
        playback={phase === 'playing' && game.current ? (
          <>
            <div>
              <input
                type="range"
                className="w-full"
                min={0}
                max={Math.floor(game.current.duration)}
                step={1}
                value={position}
                style={{ '--fill': `${(position / game.current.duration) * 100}%` } as CSSProperties}
                onChange={(e) => seekTo(Number(e.target.value))}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs tabular-nums text-white/50">{clockText}</span>
                <div className="flex items-center gap-1">
                  <IconButton label="Назад 5 с (←)" size="sm" onClick={() => seekBy(-5)}><RotateCcw size={15} /></IconButton>
                  <IconButton label={paused ? 'Продолжить' : 'Пауза'} size="sm" onClick={togglePause}>
                    {paused ? <PlayIcon size={15} /> : <Pause size={15} />}
                  </IconButton>
                  <IconButton label="Вперёд 5 с (→)" size="sm" onClick={() => seekBy(5)}><RotateCw size={15} /></IconButton>
                </div>
              </div>
            </div>
            <KeyStepper value={key} loading={buffers?.key !== key} onChange={(k) => setKey(id, k)} />
            <p className="text-xs text-white/40">← → — перемотка на 5 с, с Shift — на 15 с · пробел — пауза</p>
          </>
        ) : undefined}
      />
    </div>
  );
}

function syncVideo(v: HTMLVideoElement | null, target: number, stopped: boolean) {
  if (!v || v.readyState < 1) return;
  const outside = target < 0 || (Number.isFinite(v.duration) && target > v.duration);
  if (stopped || outside) {
    if (!v.paused) v.pause();
    if (target < 0 && v.currentTime > 0.05 && !v.seeking) v.currentTime = 0;
    return;
  }
  if (v.paused) void v.play().catch(() => {});
  if (Math.abs(v.currentTime - target) > 0.25 && !v.seeking) v.currentTime = target;
}

function Centered({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <div className={cx('absolute inset-0 z-20 flex items-center justify-center p-6', dim && 'bg-black/50 backdrop-blur-sm')}>
      {children}
    </div>
  );
}

function Lobby({ song, loading, keyShift, onKey, micActive, micError, onStart }: {
  song: Song;
  loading: boolean;
  keyShift: number;
  onKey: (k: number) => void;
  micActive: [boolean, boolean];
  micError: string | null;
  onStart: () => void;
}) {
  return (
    <Centered dim>
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-panel/85 p-8 shadow-2xl backdrop-blur-xl">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Готовы петь?</p>
        <h2 className="mt-2 text-3xl font-extrabold leading-tight">{song.title}</h2>
        {song.artist && <p className="mt-1 text-white/60">{song.artist}</p>}
        <p className="mt-2 text-xs text-white/40">{clock(song.duration ?? 0)} · {song.lyrics.length} строк</p>

        <div className="mt-6"><KeyStepper value={keyShift} loading={loading} onChange={onKey} /></div>

        <div className="mt-3 space-y-3 rounded-2xl bg-white/5 p-3">
          <p className="flex items-center gap-2 text-sm font-semibold"><Mic size={14} />Микрофоны</p>
          {micActive.some(Boolean) ? (
            [0, 1].filter((i) => micActive[i]).map((slot) => (
              <div key={slot} className="flex items-center gap-3">
                <span className="w-16 text-xs font-semibold" style={{ color: PLAYER_COLORS[slot] }}>Игрок {slot + 1}</span>
                <div className="flex-1"><MicMeter slot={slot} /></div>
              </div>
            ))
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-white/50">{micError || 'Без микрофона песня пройдёт без оценки'}</p>
              <Button size="sm" onClick={() => void engine.connectMics()}>Подключить</Button>
            </div>
          )}
        </div>

        <Button variant="primary" size="lg" className="mt-6 w-full" disabled={loading} onClick={onStart}
          icon={loading ? <LoaderCircle size={18} className="animate-spin" /> : <PlayIcon size={18} fill="currentColor" />}>
          {loading ? (keyShift ? 'Меняем тональность…' : 'Загрузка…') : 'Начать'}
        </Button>
        <p className="mt-3 text-center text-xs text-white/35">Пробел — пауза · F — на весь экран</p>
      </div>
    </Centered>
  );
}

function KeyStepper({ value, loading, onChange }: { value: number; loading: boolean; onChange: (k: number) => void }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-white/5 p-3">
      <div>
        <p className="text-sm font-semibold">Тональность</p>
        <p className="flex items-center gap-1.5 text-xs text-white/45">
          {loading && <LoaderCircle size={11} className="animate-spin" />}
          {loading ? 'Пересчитываем…' : value === 0 ? 'Как в оригинале' : `${semitones(value)} полутона`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <IconButton label="Ниже" size="sm" disabled={loading || value <= -6} onClick={() => onChange(value - 1)}><Minus size={16} /></IconButton>
        <span className="w-8 text-center font-bold tabular-nums">{semitones(value)}</span>
        <IconButton label="Выше" size="sm" disabled={loading || value >= 6} onClick={() => onChange(value + 1)}><Plus size={16} /></IconButton>
      </div>
    </div>
  );
}

function verdict(score: number) {
  if (score >= 90) return 'Звезда эстрады!';
  if (score >= 75) return 'Отлично! Большая сцена ждёт';
  if (score >= 50) return 'Хорошо поёте!';
  if (score >= 25) return 'Неплохо, но нужно тренироваться';
  return 'Главное — петь с душой!';
}

function beep(freq: number, at: number, length = 0.12, volume = 0.06) {
  const ctx = engine.ctx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime + at);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + length);
  osc.connect(gain).connect(engine.master);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + length);
}

function Results({ song, results, onAgain, onLobby }: { song: Song; results: PlayerResult[]; onAgain: () => void; onLobby: () => void }) {
  const [k, setK] = useState(0);
  useEffect(() => {
    if (!results.length) return;
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      const v = Math.min(1, (performance.now() - started) / 1800);
      setK(v);
      if (v < 1) frame = requestAnimationFrame(tick);
      else [523, 659, 784, 1047].forEach((f, i) => beep(f, i * 0.12, i === 3 ? 0.6 : 0.12));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [results]);
  const best = Math.max(0, ...results.map((r) => r.score));
  const eased = 1 - (1 - k) ** 3;

  return (
    <Centered dim>
      <div className="w-full max-w-3xl text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Результат</p>
        <h2 className="mt-2 text-3xl font-extrabold">{songLabel(song)}</h2>
        <div className="mt-8 flex flex-wrap justify-center gap-5">
          {results.length ? results.map((r) => (
            <div
              key={r.name}
              className={cx(
                'w-72 rounded-3xl border bg-panel/85 p-6 backdrop-blur-xl transition',
                k === 1 && results.length > 1 && r.score === best && best > 0 ? 'scale-105 border-amber-300/60 shadow-2xl shadow-amber-500/20' : 'border-white/10',
              )}
            >
              <p className="font-bold" style={{ color: r.color }}>{r.name}</p>
              <p className="mt-2 text-7xl font-black tabular-nums">{Math.round(r.score * eased)}</p>
              <p className={cx('mt-2 h-6 font-semibold transition-opacity', k === 1 ? 'opacity-100' : 'opacity-0')}>{verdict(r.score)}</p>
              <div className="mt-4 space-y-1 text-sm text-white/55">
                <p>В ноты: {r.accuracy}% времени</p>
                <p>Спето нот: {r.hitNotes} из {r.totalNotes}</p>
              </div>
            </div>
          )) : (
            <div className="w-80 rounded-3xl border border-white/10 bg-panel/85 p-6 backdrop-blur-xl">
              <p className="text-xl font-bold">Без оценки</p>
              <p className="mt-2 text-sm text-white/55">Микрофон не был подключён</p>
            </div>
          )}
        </div>
        <div className="mt-8 flex justify-center gap-3">
          <Button variant="primary" size="lg" icon={<RotateCcw size={18} />} onClick={onAgain}>Ещё раз</Button>
          <Button size="lg" onClick={onLobby}>Тональность и микрофоны</Button>
          <Button size="lg" variant="ghost" onClick={() => navigate('/')}>В каталог</Button>
        </div>
      </div>
    </Centered>
  );
}
