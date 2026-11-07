// Включение и выключение микрофонов: в каталоге и прямо во время песни.
import { Mic, MicOff } from 'lucide-react';
import { useState } from 'react';
import { engine, useDevices } from '../audio/engine';
import { cx, toast } from './ui';

export async function toggleMics() {
  if (useDevices.getState().active.some(Boolean)) {
    await engine.disconnectMics();
    toast('Микрофон выключен');
  } else if (await engine.connectMics()) {
    toast('Микрофон включён', 'success');
  } else {
    toast(useDevices.getState().error ?? 'Микрофон недоступен', 'error');
  }
}

export function MicToggle({ compact }: { compact?: boolean }) {
  const on = useDevices((s) => s.active.some(Boolean));
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    await toggleMics();
    setBusy(false);
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => void toggle()}
      title={`${on ? 'Выключить' : 'Включить'} микрофон${compact ? ' (M)' : ''}`}
      className={cx(
        'flex h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold transition',
        on ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20' : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white',
      )}
    >
      {on ? <Mic size={16} /> : <MicOff size={16} />}
      <span className={compact ? 'hidden lg:inline' : 'hidden md:inline'}>{on ? 'Микрофон вкл.' : 'Микрофон выкл.'}</span>
      <span className={cx('relative h-4 w-7 rounded-full transition', on ? 'bg-emerald-400' : 'bg-white/20')}>
        <span className={cx('absolute top-0.5 size-3 rounded-full bg-white transition-all', on ? 'left-3.5' : 'left-0.5')} />
      </span>
    </button>
  );
}
