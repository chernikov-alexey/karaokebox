// Настройки звука, микрофонов и игры. Меняются на лету, в том числе во время песни.
import { Disc3, Gamepad2, Mic, MicOff, Speaker, Sparkles } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { engine, useDevices } from '../audio/engine';
import { noteName } from '../audio/pitch';
import { PLAYER_COLORS } from '../game/game';
import { percent } from '../lib/format';
import { FX_PRESETS, useSettings } from '../settings';
import { Button, Drawer, Select, Slider, Toggle, cx } from './ui';

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white/50">
        {icon}
        {title}
      </h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function MicMeter({ slot }: { slot: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const mic = engine.mics[slot];
      const midi = mic?.read() ?? null;
      if (bar.current) bar.current.style.width = `${Math.min(100, (mic?.level ?? 0) * 600)}%`;
      if (label.current) label.current.textContent = !mic ? 'не подключён' : midi === null ? 'тишина' : noteName(midi);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [slot]);
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div ref={bar} className="h-full rounded-full transition-[width] duration-75" style={{ background: PLAYER_COLORS[slot] }} />
      </div>
      <span ref={label} className="w-24 text-right text-xs tabular-nums text-white/60" />
    </div>
  );
}

// playback — блок управления песней сверху (в режиме караоке); тогда панель не закрывает экран.
export function SettingsPanel({ open, onClose, playback }: { open: boolean; onClose: () => void; playback?: ReactNode }) {
  const s = useSettings();
  const devices = useDevices();

  useEffect(() => {
    if (open) void engine.refreshDevices();
  }, [open]);

  const inputOptions = [{ value: '', label: '— нет —' }, ...devices.inputs.map((d) => ({ value: d.deviceId, label: d.label }))];
  const preset = FX_PRESETS.find((p) => Object.entries(p.values).every(([k, v]) => Math.abs(s[k as keyof typeof p.values] - v) < 1e-6));

  return (
    <Drawer open={open} onClose={onClose} title={playback ? 'Звук и микрофон' : 'Настройки'} modal={!playback}>
      {playback && <Section icon={<Disc3 size={14} />} title="Воспроизведение">{playback}</Section>}
      <Section icon={<Speaker size={14} />} title="Звук">
        {devices.canChooseOutput && (
          <Select
            label="Вывод звука"
            value={s.output}
            options={[{ value: '', label: 'Системное устройство' }, ...devices.outputs.map((d) => ({ value: d.deviceId, label: d.label }))]}
            onChange={(output) => s.set({ output })}
          />
        )}
        <Slider label="Общая громкость" value={s.master} min={0} max={1.5} step={0.01} format={percent} onChange={(master) => s.set({ master })} />
        <Slider label="Музыка (минусовка)" value={s.music} min={0} max={1.5} step={0.01} format={percent} onChange={(music) => s.set({ music })} />
        <Slider
          label="Голос исполнителя"
          hint="Подпевка оригинального голоса поверх минусовки"
          value={s.guide}
          min={0}
          max={1}
          step={0.01}
          format={percent}
          onChange={(guide) => s.set({ guide })}
        />
      </Section>

      <Section icon={<Sparkles size={14} />} title="Микрофон в колонках">
        <Toggle
          checked={s.monitor}
          onChange={(monitor) => {
            s.set({ monitor });
            if (monitor) void engine.connectMics();
          }}
          label="Слышать себя"
          hint="Голос с микрофона идёт в колонки с эхом и реверберацией. Если свистит — уменьшите громкость или отодвиньте микрофон от колонок."
        />
        <div className={cx('space-y-4 transition', !s.monitor && 'pointer-events-none opacity-40')}>
          <Slider label="Громкость микрофона" value={s.micVolume} min={0} max={2} step={0.01} format={percent} onChange={(micVolume) => s.set({ micVolume })} />
          <div className="flex flex-wrap gap-2">
            {FX_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => s.set(p.values)}
                className={cx(
                  'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                  preset?.id === p.id ? 'border-accent bg-accent/20 text-white' : 'border-white/10 text-white/60 hover:text-white',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Slider label="Эхо" value={s.echo} min={0} max={0.8} step={0.01} format={percent} onChange={(echo) => s.set({ echo })} />
          <Slider
            label="Задержка эха"
            value={s.echoTime}
            min={0.05}
            max={0.6}
            step={0.01}
            format={(v) => `${Math.round(v * 1000)} мс`}
            onChange={(echoTime) => s.set({ echoTime })}
          />
          <Slider label="Повторы эха" value={s.echoFeedback} min={0} max={0.8} step={0.01} format={percent} onChange={(echoFeedback) => s.set({ echoFeedback })} />
          <Slider label="Реверберация" value={s.reverb} min={0} max={1} step={0.01} format={percent} onChange={(reverb) => s.set({ reverb })} />
          <Slider
            label="Размер зала"
            value={s.reverbSize}
            min={0.4}
            max={5}
            step={0.1}
            format={(v) => `${v.toFixed(1)} с`}
            onChange={(reverbSize) => s.set({ reverbSize })}
          />
        </div>
      </Section>

      <Section icon={<Mic size={14} />} title="Микрофоны">
        {devices.active.some(Boolean) ? (
          <Button variant="secondary" icon={<MicOff size={16} />} onClick={() => void engine.disconnectMics()} className="w-full">
            Выключить микрофоны
          </Button>
        ) : (
          <Button variant="secondary" icon={<Mic size={16} />} onClick={() => void engine.connectMics()} className="w-full">
            Подключить микрофоны
          </Button>
        )}
        {devices.error && <p className="text-xs text-rose-300">{devices.error}</p>}
        {[0, 1].map((slot) => (
          <div key={slot} className="space-y-2">
            <Select
              label={<span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: PLAYER_COLORS[slot] }} />Игрок {slot + 1}</span>}
              value={slot ? s.mic1 : s.mic0}
              options={inputOptions}
              onChange={(id) => s.set(slot ? { mic1: id } : { mic0: id })}
            />
            <MicMeter slot={slot} />
          </div>
        ))}
        <Toggle
          checked={s.aec}
          onChange={(aec) => s.set({ aec })}
          label="Подавлять эхо от колонок"
          hint="Включите, если поёте без наушников и микрофон слышит музыку."
        />
        <Slider
          label="Задержка микрофона"
          hint="Сдвиг, на который голос опаздывает к игре (Bluetooth-наушники — 150–250 мс)"
          value={s.micDelay}
          min={0}
          max={0.4}
          step={0.01}
          format={(v) => `${Math.round(v * 1000)} мс`}
          onChange={(micDelay) => s.set({ micDelay })}
        />
      </Section>

      <Section icon={<Gamepad2 size={14} />} title="Игра">
        <Select
          label="Сложность"
          value={s.octaveStrict ? 0.4 : s.tolerance}
          options={[
            { value: 1.5, label: 'Лёгкая (±1,5 полутона)' },
            { value: 1, label: 'Обычная (±1 полутон)' },
            { value: 0.5, label: 'Сложная (±0,5 полутона)' },
            { value: 0.4, label: 'Точная (±0,5, октава как в оригинале)' },
          ]}
          onChange={(v) => (v === 0.4 ? s.set({ tolerance: 0.5, octaveStrict: true }) : s.set({ tolerance: v, octaveStrict: false }))}
        />
      </Section>
    </Drawer>
  );
}
