// Настройки, которые запоминаются между запусками.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Settings {
  mic0: string;
  mic1: string;
  // микрофоны выключены пользователем: игра идёт без оценки и без голоса в колонках
  micOn: boolean;
  aec: boolean;
  tolerance: number;
  micDelay: number;
  output: string;
  master: number;
  music: number;
  guide: number;
  // свой голос в колонках, как в караоке-баре
  monitor: boolean;
  micVolume: number;
  echo: number;
  echoTime: number;
  echoFeedback: number;
  reverb: number;
  reverbSize: number;
  // тональность для каждой песни отдельно
  keys: Record<string, number>;
}

export const DEFAULTS: Settings = {
  mic0: '',
  mic1: '',
  micOn: true,
  aec: false,
  tolerance: 1,
  micDelay: 0.08,
  output: '',
  master: 0.9,
  music: 1,
  guide: 0.15,
  monitor: false,
  micVolume: 0.8,
  echo: 0.3,
  echoTime: 0.18,
  echoFeedback: 0.38,
  reverb: 0.3,
  reverbSize: 1.8,
  keys: {},
};

export interface FxPreset {
  id: string;
  label: string;
  values: Pick<Settings, 'echo' | 'echoTime' | 'echoFeedback' | 'reverb' | 'reverbSize'>;
}

export const FX_PRESETS: FxPreset[] = [
  { id: 'dry', label: 'Без эффектов', values: { echo: 0, echoTime: 0.18, echoFeedback: 0.3, reverb: 0, reverbSize: 1.2 } },
  { id: 'room', label: 'Комната', values: { echo: 0, echoTime: 0.12, echoFeedback: 0.2, reverb: 0.25, reverbSize: 0.9 } },
  { id: 'bar', label: 'Караоке-бар', values: { echo: 0.3, echoTime: 0.18, echoFeedback: 0.38, reverb: 0.3, reverbSize: 1.8 } },
  { id: 'hall', label: 'Концертный зал', values: { echo: 0.1, echoTime: 0.25, echoFeedback: 0.25, reverb: 0.5, reverbSize: 3.2 } },
  { id: 'stadium', label: 'Стадион', values: { echo: 0.4, echoTime: 0.38, echoFeedback: 0.5, reverb: 0.55, reverbSize: 4.5 } },
];

interface Store extends Settings {
  set: (changes: Partial<Settings>) => void;
  setKey: (songId: string, key: number) => void;
}

export const useSettings = create<Store>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (changes) => set(changes),
      setKey: (songId, key) => set((s) => ({ keys: { ...s.keys, [songId]: key } })),
    }),
    { name: 'karaoke-settings', version: 1 },
  ),
);

export const getSettings = () => useSettings.getState();
