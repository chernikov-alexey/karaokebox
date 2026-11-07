export const clock = (s: number) => {
  const t = Math.max(0, s);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};

export const stamp = (s: number) => {
  const t = Math.max(0, s);
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};

export const percent = (v: number) => `${Math.round(v * 100)}%`;

export const semitones = (k: number) => (k > 0 ? `+${k}` : String(k));

// Стабильный цвет обложки по названию песни.
export function hue(text: string) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
