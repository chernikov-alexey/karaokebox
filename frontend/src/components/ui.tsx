// Базовые элементы интерфейса.
import { X } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { create } from 'zustand';

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');
export { cx };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-gradient-accent text-white shadow-lg shadow-fuchsia-500/20 hover:brightness-110',
  secondary: 'bg-white/8 text-white hover:bg-white/14 border border-white/10',
  ghost: 'text-white/75 hover:text-white hover:bg-white/8',
  danger: 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 border border-rose-500/20',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, className, children, ...rest }: ButtonProps) {
  const sizes = { sm: 'h-8 px-3 text-xs gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-base gap-2.5' };
  return (
    <button
      type="button"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-xl font-semibold transition select-none',
        'disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent',
        VARIANTS[variant], sizes[size], className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: 'sm' | 'md';
}

export function IconButton({ label, active, size = 'md', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-xl transition',
        'disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' ? 'size-8' : 'size-10',
        active ? 'bg-accent/20 text-accent' : 'text-white/70 hover:bg-white/10 hover:text-white',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

interface SliderProps {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}

export function Slider({ label, value, min, max, step, format, onChange, hint }: SliderProps) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="block" title={hint}>
      <span className="flex items-center justify-between text-sm text-white/70">
        <span>{label}</span>
        <span className="tabular-nums text-white">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        className="mt-1 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="text-sm text-white/90">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-white/45">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-white/15')}
      >
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', checked ? 'left-5.5' : 'left-0.5')} />
      </button>
    </label>
  );
}

export function Select<T extends string | number>({ label, value, options, onChange }: {
  label?: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-sm text-white/70">{label}</span>}
      <select
        className="h-10 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white outline-none focus:border-accent"
        value={String(value)}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked) onChange(picked.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} className="bg-panel">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export const inputClass =
  'h-10 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-accent';

export function Modal({ open, onClose, title, children, width = 'max-w-lg' }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className={cx('w-full rounded-3xl border border-white/10 bg-panel p-6 shadow-2xl', width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <IconButton label="Закрыть" size="sm" onClick={onClose}><X size={18} /></IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

// modal=false — панель поверх игры: без затемнения, остальной экран остаётся живым.
export function Drawer({ open, onClose, title, children, modal = true }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; modal?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  return (
    <div className={cx('fixed inset-0 z-40 transition', open && modal ? 'pointer-events-auto' : 'pointer-events-none')}>
      {modal && <div className={cx('absolute inset-0 bg-black/50 transition-opacity', open ? 'opacity-100' : 'opacity-0')} onClick={onClose} />}
      <aside
        className={cx(
          'absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-white/10 shadow-2xl backdrop-blur-xl transition-transform duration-300',
          modal ? 'bg-panel/95' : 'pointer-events-auto max-w-sm bg-panel/85',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <IconButton label="Закрыть" size="sm" onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </aside>
    </div>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-white/10', className)}>
      <div className="h-full rounded-full bg-gradient-accent transition-all duration-500" style={{ width: `${Math.max(2, value)}%` }}>
        <div className="shimmer h-full w-full" />
      </div>
    </div>
  );
}

// ---------- уведомления ----------

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

const useToasts = create<{ items: Toast[] }>(() => ({ items: [] }));
let toastId = 0;

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = ++toastId;
  useToasts.setState((s) => ({ items: [...s.items, { id, text, tone }] }));
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), tone === 'error' ? 7000 : 4000);
}

export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error');

export function Toasts() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            'pointer-events-auto max-w-lg rounded-2xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-xl',
            t.tone === 'error' && 'border-rose-500/30 bg-rose-950/80 text-rose-100',
            t.tone === 'success' && 'border-emerald-500/30 bg-emerald-950/80 text-emerald-100',
            t.tone === 'info' && 'border-white/10 bg-panel-2/90 text-white',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- подтверждение ----------

interface ConfirmState {
  text: ReactNode;
  action: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ current: ConfirmState | null }>(() => ({ current: null }));

export function confirmDialog(text: ReactNode, action = 'Да', danger = false) {
  return new Promise<boolean>((resolve) => useConfirm.setState({ current: { text, action, danger, resolve } }));
}

export function ConfirmHost() {
  const current = useConfirm((s) => s.current);
  const close = (ok: boolean) => {
    current?.resolve(ok);
    useConfirm.setState({ current: null });
  };
  return (
    <Modal open={!!current} onClose={() => close(false)} title="Подтверждение" width="max-w-md">
      <div className="text-sm text-white/80">{current?.text}</div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(false)}>Отмена</Button>
        <Button variant={current?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>{current?.action}</Button>
      </div>
    </Modal>
  );
}
