// Отправка текста песни на повторное распознавание.
import { WandSparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LANGUAGES, WHISPER_MODELS, type RecognizeOptions, type WhisperModel } from '../api';
import { Button, Modal, Select } from './ui';

const STORE = 'karaoke-recognize';

export function loadRecognizeOptions(): { model: WhisperModel; language: string } {
  try {
    return { model: 'medium', language: '', ...JSON.parse(localStorage.getItem(STORE) || '{}') };
  } catch {
    return { model: 'medium', language: '' };
  }
}

export function saveRecognizeOptions(options: { model: WhisperModel; language: string }) {
  try {
    localStorage.setItem(STORE, JSON.stringify(options));
  } catch { /* приватный режим */ }
}

export function RecognizeFields({ model, language, onChange }: {
  model: WhisperModel;
  language: string;
  onChange: (v: { model: WhisperModel; language: string }) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Select label="Модель" value={model} options={WHISPER_MODELS.map((m) => ({ value: m.id, label: m.label }))} onChange={(m) => onChange({ model: m, language })} />
      <Select label="Язык" value={language} options={LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} onChange={(l) => onChange({ model, language: l })} />
    </div>
  );
}

export function RetranscribeDialog({ open, onClose, onSubmit, initialPrompt = '', initialLanguage }: {
  open: boolean;
  onClose: () => void;
  onSubmit: (options: RecognizeOptions) => void;
  initialPrompt?: string;
  initialLanguage?: string | null;
}) {
  const [options, setOptions] = useState(loadRecognizeOptions);
  const [prompt, setPrompt] = useState(initialPrompt);

  useEffect(() => {
    if (!open) return;
    setPrompt(initialPrompt);
    const saved = loadRecognizeOptions();
    setOptions({ ...saved, language: saved.language || initialLanguage || '' });
  }, [open, initialPrompt, initialLanguage]);

  return (
    <Modal open={open} onClose={onClose} title="Распознать текст заново">
      <p className="mb-4 text-sm text-white/60">
        Нейросеть заново прослушает вырезанный голос и заменит текст песни. Несохранённые правки пропадут.
      </p>
      <div className="space-y-4">
        <RecognizeFields {...options} onChange={setOptions} />
        <label className="block">
          <span className="mb-1 block text-sm text-white/70">Подсказка — текст песни, если знаете</span>
          <textarea
            className="h-36 w-full resize-none rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-accent"
            placeholder="Вставьте точный текст песни, если он у вас есть, — так слова и имена распознаются вернее. Если не знаете, оставьте пустым: неточная подсказка только навредит."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button
          variant="primary"
          icon={<WandSparkles size={16} />}
          onClick={() => {
            saveRecognizeOptions(options);
            onSubmit({ model: options.model, language: options.language || null, prompt: prompt.trim() || null });
          }}
        >
          Распознать
        </Button>
      </div>
    </Modal>
  );
}
