// Типы и запросы к бэкенду.

export interface Word {
  t0: number;
  t1: number;
  text: string;
}

export interface Line {
  start: number;
  end: number;
  words: Word[];
}

export interface Note {
  start: number;
  end: number;
  midi: number;
}

export type SongStatus = 'queued' | 'processing' | 'ready' | 'error';

export interface SongMeta {
  id: string;
  title: string;
  artist: string | null;
  source: string;
  created: number;
  status: SongStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  job?: 'process' | 'transcribe';
  duration?: number;
  notes?: number;
  lines?: number;
  language?: string | null;
  warning?: string | null;
  video?: string | null;
  videoVersion?: number;
  videoOffset?: number;
  videoStatus?: 'processing' | null;
  videoError?: string | null;
}

export interface Song extends SongMeta {
  noteList: Note[];
  lyrics: Line[];
}

export interface RecognizeOptions {
  model?: WhisperModel | null;
  language?: string | null;
  prompt?: string | null;
}

export type WhisperModel = 'small' | 'medium' | 'large-v3-turbo' | 'large-v3';

export const WHISPER_MODELS: { id: WhisperModel; label: string }[] = [
  { id: 'small', label: 'Быстрая (small)' },
  { id: 'medium', label: 'Обычная (medium)' },
  { id: 'large-v3-turbo', label: 'Быстрая точная (large-v3-turbo, скачает ~1.6 ГБ)' },
  { id: 'large-v3', label: 'Точная (large-v3, скачает ~3 ГБ)' },
];

export const LANGUAGES: { id: string; label: string }[] = [
  { id: '', label: 'Определить автоматически' },
  { id: 'ru', label: 'Русский' },
  { id: 'en', label: 'Английский' },
  { id: 'uk', label: 'Украинский' },
  { id: 'be', label: 'Белорусский' },
  { id: 'kk', label: 'Казахский' },
  { id: 'de', label: 'Немецкий' },
  { id: 'fr', label: 'Французский' },
  { id: 'es', label: 'Испанский' },
  { id: 'it', label: 'Итальянский' },
  { id: 'ja', label: 'Японский' },
  { id: 'ko', label: 'Корейский' },
];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = typeof body.detail === 'string' ? body.detail : `Ошибка ${response.status}`;
    throw new Error(detail);
  }
  return response.json();
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function upload<T>(url: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  // fetch не сообщает прогресс отправки, а видео бывает большим
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: { detail?: unknown } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch { /* не JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new Error(typeof body.detail === 'string' ? body.detail : `Ошибка ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Сеть недоступна'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export const api = {
  songs: () => request<SongMeta[]>('/api/songs'),
  song: (id: string) => request<Song>(`/api/songs/${id}`),
  upload: (file: File, onProgress?: (fraction: number) => void) => upload<SongMeta>('/api/songs', file, onProgress),
  update: (id: string, changes: { title?: string; artist?: string; videoOffset?: number }) =>
    request<SongMeta>(`/api/songs/${id}`, json('PATCH', changes)),
  saveLyrics: (id: string, body: { title: string; artist: string; lines: Line[] }) =>
    request<SongMeta>(`/api/songs/${id}/lyrics`, json('PUT', body)),
  transcribe: (id: string, options: RecognizeOptions) =>
    request<SongMeta>(`/api/songs/${id}/transcribe`, json('POST', options)),
  recognize: (id: string, start: number, end: number, options: RecognizeOptions) =>
    request<{ lines: Line[] }>(`/api/songs/${id}/recognize`, json('POST', { start, end, ...options })),
  uploadVideo: (id: string, file: File, onProgress?: (fraction: number) => void) =>
    upload<SongMeta>(`/api/songs/${id}/video`, file, onProgress),
  deleteVideo: (id: string) => request<SongMeta>(`/api/songs/${id}/video`, { method: 'DELETE' }),
  retry: (id: string) => request<SongMeta>(`/api/songs/${id}/retry`, { method: 'POST' }),
  remove: (id: string) => request<{ ok: boolean }>(`/api/songs/${id}`, { method: 'DELETE' }),
};

export const stemUrl = (id: string, stem: 'minus' | 'vocals', key = 0) =>
  key ? `/api/songs/${id}/stem/${stem}?key=${key}` : `/media/${id}/${stem}.mp3`;

export const downloadUrl = (id: string, stem: 'minus' | 'vocals', key = 0) =>
  `/api/songs/${id}/stem/${stem}?download=1${key ? `&key=${key}` : ''}`;

export const videoUrl = (song: SongMeta) =>
  song.video ? `/media/${song.id}/${song.video}?v=${song.videoVersion ?? 0}` : null;

export const songLabel = (song: Pick<SongMeta, 'title' | 'artist'>) =>
  song.artist ? `${song.artist} — ${song.title}` : song.title;

export const isMedia = (file: File) =>
  file.type.startsWith('audio/') || file.type.startsWith('video/') ||
  /\.(mp3|wav|m4a|flac|ogg|aac|opus|mp4|mkv|webm|mov|avi|m4v|mpe?g|wmv|flv)$/i.test(file.name);

export const isVideo = (file: File) =>
  file.type.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi|m4v|mpe?g|wmv|flv)$/i.test(file.name);
