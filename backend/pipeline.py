"""Обработка песни: видеоклип, отделение голоса (Demucs), ноты (CREPE), текст (Whisper)."""
import json
import os
import queue
import re
import subprocess
import threading
import time
import traceback
from pathlib import Path

import certifi
import numpy as np

# у Python с python.org на macOS нет корневых сертификатов — без этого не скачаются веса моделей
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

SR = 44100
PITCH_SR = 16000
HOP = 160  # 10 мс
FRAME = HOP / PITCH_SR
DATA = Path(__file__).resolve().parent.parent / "data" / "songs"
# по умолчанию та же модель, что в Rakurs/Transcriber: она уже лежит в кэше Hugging Face
WHISPER_MODEL = os.environ.get("KARAOKE_WHISPER_MODEL", "medium")
WHISPER_MODELS = ("small", "medium", "large-v3-turbo", "large-v3")
LINE_CHARS = 34
# кодеки, которые браузер играет без перекодирования: -> контейнер
BROWSER_VIDEO = {"h264": "mp4", "av1": "mp4", "vp8": "webm", "vp9": "webm"}
STEMS = ("minus", "vocals")
MAX_KEY = 6

_lock = threading.Lock()
_whisper_lock = threading.Lock()
_shift_lock = threading.Lock()
_jobs: "queue.Queue[tuple[str, str, dict]]" = queue.Queue()
_models = {}


# ---------- хранилище ----------

def song_dir(song_id: str) -> Path:
    return DATA / song_id


def read_meta(song_id: str) -> dict | None:
    path = song_dir(song_id) / "meta.json"
    if not path.exists():
        return None
    with _lock:
        return json.loads(path.read_text("utf-8"))


def write_meta(song_id: str, **changes) -> dict:
    path = song_dir(song_id) / "meta.json"
    with _lock:
        meta = json.loads(path.read_text("utf-8")) if path.exists() else {"id": song_id}
        meta.update(changes)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
        tmp.replace(path)
    return meta


def list_songs() -> list[dict]:
    if not DATA.exists():
        return []
    songs = [m for d in DATA.iterdir() if d.is_dir() and (m := read_meta(d.name))]
    return sorted(songs, key=lambda m: m.get("created", 0))


# ---------- звук ----------

def decode(path: Path, sr: int = SR, channels: int = 2) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-f", "f32le", "-ac", str(channels),
           "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, np.float32)
    return audio.reshape(-1, channels) if channels > 1 else audio


def encode_mp3(audio: np.ndarray, path: Path) -> None:
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", "-",
           "-c:a", "libmp3lame", "-b:a", "192k", str(path)]
    subprocess.run(cmd, input=np.clip(audio, -1, 1).astype(np.float32).tobytes(), check=True)


def probe_tags(path: Path) -> tuple[str | None, str | None]:
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", str(path)],
                         capture_output=True, text=True).stdout
    try:
        tags = json.loads(out).get("format", {}).get("tags", {})
    except json.JSONDecodeError:
        return None, None
    tags = {k.lower(): v for k, v in tags.items()}
    return tags.get("title"), tags.get("artist")


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, capture_output=True, check=True)


def probe_video(path: Path) -> dict | None:
    """Первый настоящий видеопоток файла (обложка mp3/m4a не считается)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(path)],
                         capture_output=True, text=True).stdout
    try:
        streams = json.loads(out).get("streams", [])
    except json.JSONDecodeError:
        return None
    for s in streams:
        if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic"):
            return s
    return None


def prepare_video(src: Path, d: Path) -> str | None:
    """Делает из файла беззвучный клип, который играет браузер. Возвращает имя файла."""
    stream = probe_video(src)
    if not stream:
        return None
    container = BROWSER_VIDEO.get(stream.get("codec_name"))
    out = d / f"video.{container or 'mp4'}"
    tmp = d / f"video.tmp.{container or 'mp4'}"
    head = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-map", f"0:{stream['index']}", "-an", "-sn"]
    if container:
        _run(head + ["-c", "copy", "-movflags", "+faststart", str(tmp)])
    else:
        _run(head + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                     "-vf", "scale='min(1920,iw)':-2", "-movflags", "+faststart", str(tmp)])
    for old in d.glob("video.*"):
        if old != tmp:
            old.unlink()
    tmp.replace(out)
    return out.name


def stem_path(song_id: str, stem: str, key: int) -> Path:
    """Минус или голос, сдвинутые на key полутонов (с сохранением темпа); готовые кэшируются."""
    d = song_dir(song_id)
    src = d / f"{stem}.mp3"
    if key == 0:
        return src
    out = d / f"{stem}.key{key:+d}.mp3"
    with _shift_lock:
        if not out.exists():
            ratio = 2 ** (key / 12)
            tmp = out.with_suffix(".tmp.mp3")
            _run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af",
                  f"asetrate={SR * ratio:.3f},aresample={SR},atempo={1 / ratio:.6f}",
                  "-c:a", "libmp3lame", "-b:a", "192k", str(tmp)])
            tmp.replace(out)
    return out


def _devices() -> list[str]:
    import torch
    if torch.cuda.is_available():
        return ["cuda", "cpu"]
    if torch.backends.mps.is_available():
        return ["mps", "cpu"]
    return ["cpu"]


class _TqdmShim:
    """Подменяет tqdm внутри demucs.apply, чтобы отдавать прогресс наружу."""

    def __init__(self, callback):
        self.callback = callback

    def tqdm(self, iterable, **_):
        items = list(iterable)
        for i, item in enumerate(items):
            yield item
            self.callback((i + 1) / len(items))


# ---------- этапы ----------

def separate(audio: np.ndarray, on_progress) -> tuple[np.ndarray, np.ndarray]:
    import torch
    import demucs.apply as dapply
    from demucs.pretrained import get_model

    if "demucs" not in _models:
        _models["demucs"] = get_model("htdemucs").eval()
    model = _models["demucs"]

    wav = torch.from_numpy(audio.T.copy())
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    real_tqdm = dapply.tqdm
    dapply.tqdm = _TqdmShim(on_progress)
    try:
        for dev in _devices():
            try:
                with torch.no_grad():
                    out = dapply.apply_model(model, wav[None], device=dev, split=True,
                                             overlap=0.25, progress=True)[0].cpu()
                break
            except Exception:
                if dev == "cpu":
                    raise
    finally:
        dapply.tqdm = real_tqdm

    out = out * std + mean
    vocals = out[model.sources.index("vocals")]
    minus = out.sum(0) - vocals
    return vocals.numpy().T, minus.numpy().T


def extract_pitch(mono16k: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Возвращает (midi, voiced) с шагом 10 мс."""
    import torch
    import torchcrepe

    audio = torch.from_numpy(mono16k)[None]
    for dev in _devices():
        # полная модель на процессоре считает втрое медленнее реального времени
        capacity = "tiny" if dev == "cpu" else "full"
        try:
            f0, periodicity = torchcrepe.predict(
                audio, PITCH_SR, HOP, 65.0, 1000.0, capacity, batch_size=512, device=dev,
                return_periodicity=True, decoder=torchcrepe.decode.viterbi)
            break
        except Exception:
            if dev == "cpu":
                raise
    f0 = f0[0].cpu().numpy()
    periodicity = _median(periodicity[0].cpu().numpy(), 3)

    n = len(f0)
    padded = np.pad(mono16k, (HOP, HOP * 2))
    rms = np.array([np.sqrt(np.mean(padded[i * HOP:i * HOP + HOP * 2] ** 2)) for i in range(n)])
    db = 20 * np.log10(rms + 1e-9)
    loud = db > max(-50.0, np.percentile(db, 95) - 35.0)

    midi = 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440.0)
    voiced = (periodicity > 0.45) & loud
    return midi, voiced


def _median(x: np.ndarray, win: int) -> np.ndarray:
    pad = win // 2
    padded = np.pad(x, pad, mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(padded, win), axis=1)


def segment_notes(midi: np.ndarray, voiced: np.ndarray) -> list[dict]:
    """Режет контур высоты на ноты: новая нота при устойчивом сдвиге высоты или паузе."""
    MAX_GAP, JUMP, CONFIRM, MIN_LEN = 6, 0.8, 4, 8
    notes, cur, pending, gap = [], None, [], 0

    def close():
        nonlocal cur
        if cur and len(cur["vals"]) >= MIN_LEN:
            notes.append({"start": round(cur["start"] * FRAME, 3),
                          "end": round((cur["last"] + 1) * FRAME, 3),
                          "midi": round(float(np.median(cur["vals"])), 2)})
        cur = None

    for i in range(len(midi)):
        if not voiced[i]:
            gap += 1
            if cur and gap > MAX_GAP:
                close()
                pending = []
            continue
        gap = 0
        m = float(midi[i])
        if cur is None:
            cur, pending = {"start": i, "last": i, "vals": [m]}, []
        elif abs(m - np.median(cur["vals"][-30:])) <= JUMP:
            cur["vals"].append(m)
            cur["last"] = i
            pending = []
        else:
            pending.append((i, m))
            if len(pending) >= CONFIRM:
                close()
                cur = {"start": pending[0][0], "last": i, "vals": [p[1] for p in pending]}
                pending = []
    close()
    return notes


_HALLUCINATIONS = re.compile(
    r"субтитр|продолжение следует|редактор|корректор|amara\.org|thanks for watching|subtitles by|"
    r"подписывайтесь|подписывайся на канал|ставь лайк|до встречи в новых видео|dimatorzok", re.I)


def _whisper(name: str | None):
    from faster_whisper import WhisperModel

    name = name if name in WHISPER_MODELS else WHISPER_MODEL
    key = f"whisper:{name}"
    if key not in _models:
        _models[key] = WhisperModel(name, device="cpu", compute_type="int8")
    return _models[key]


def transcribe(mono16k: np.ndarray, voiced: np.ndarray | None, *, model: str | None = None,
               language: str | None = None, prompt: str | None = None, offset: float = 0.0,
               on_progress=None) -> tuple[list[dict], str | None]:
    """Текст по строкам. voiced=None — фрагмент выбран вручную, голосу верим без проверки."""
    whole = voiced is not None
    with _whisper_lock:
        segments, info = _whisper(model).transcribe(
            mono16k, word_timestamps=True, condition_on_previous_text=False,
            language=language or None, initial_prompt=(prompt or "").strip() or None,
            vad_filter=whole, vad_parameters={"min_silence_duration_ms": 1000, "speech_pad_ms": 400})
        duration = len(mono16k) / PITCH_SR

        lines = []
        for seg in segments:
            if on_progress:
                on_progress(min(1.0, seg.end / max(duration, 1e-6)))
            if seg.no_speech_prob > 0.8 or _HALLUCINATIONS.search(seg.text) or not seg.words:
                continue
            if whole:
                a, b = int(seg.start / FRAME), int(seg.end / FRAME) + 1
                if voiced[a:b].mean() < 0.1 if b > a and a < len(voiced) else True:
                    continue  # в этом месте никто не поёт — Whisper выдумал
            cur = []
            for w in seg.words:
                text = w.word.strip()
                if not text:
                    continue
                length = sum(len(x["text"]) + 1 for x in cur)
                if cur and (length + len(text) > LINE_CHARS or w.start - cur[-1]["t1"] > 2.0):
                    lines.append(cur)
                    cur = []
                cur.append({"t0": round(float(w.start) + offset, 2), "t1": round(float(w.end) + offset, 2),
                            "text": text})
            if cur:
                lines.append(cur)
    result = [{"start": ws[0]["t0"], "end": ws[-1]["t1"], "words": ws} for ws in lines]
    return result, info.language


def voiced_from_notes(notes: list[dict], frames: int) -> np.ndarray:
    voiced = np.zeros(frames, bool)
    for n in notes:
        voiced[int(n["start"] / FRAME):int(n["end"] / FRAME) + 1] = True
    return voiced


def _vocals16k(song_id: str) -> np.ndarray:
    return decode(song_dir(song_id) / "vocals.mp3", PITCH_SR, 1)


def recognize(song_id: str, start: float, end: float, **options) -> list[dict]:
    """Распознаёт выделенный фрагмент голоса; времена — от начала песни."""
    mono = _vocals16k(song_id)
    a = max(0, int((start - 0.2) * PITCH_SR))
    b = min(len(mono), int((end + 0.2) * PITCH_SR))
    lines, _ = transcribe(mono[a:b].copy(), None, offset=a / PITCH_SR, **options)
    for line in lines:
        for w in line["words"]:
            w["t0"], w["t1"] = max(start, min(end, w["t0"])), max(start, min(end, w["t1"]))
        line["start"], line["end"] = line["words"][0]["t0"], line["words"][-1]["t1"]
    return lines


# ---------- конвейер ----------

def _stage(song_id: str, name: str, lo: int, hi: int):
    write_meta(song_id, status="processing", stage=name, progress=lo)
    last = [lo]

    def cb(frac):
        value = round(lo + (hi - lo) * frac)
        if value != last[0]:
            last[0] = value
            write_meta(song_id, progress=value)
    return cb


def process(song_id: str) -> None:
    import torch
    import torchaudio.functional as AF

    d = song_dir(song_id)
    meta = read_meta(song_id)
    stage = lambda name, lo, hi: _stage(song_id, name, lo, hi)  # noqa: E731

    if meta.get("sourceVideo") and not meta.get("video"):
        stage("Готовим видеоклип", 0, 2)
        try:  # без клипа петь можно, поэтому ошибка видео не останавливает обработку
            write_meta(song_id, video=prepare_video(d / meta["source"], d), videoVersion=int(time.time()))
        except Exception as e:
            traceback.print_exc()
            write_meta(song_id, videoError=str(e)[-300:])

    cb = stage("Нейросеть вырезает голос", 2, 70)
    audio = decode(d / meta["source"])
    vocals, minus = separate(audio, cb)
    encode_mp3(minus, d / "minus.mp3")
    encode_mp3(vocals, d / "vocals.mp3")
    duration = len(audio) / SR
    del audio, minus

    stage("Раскладываем голос по нотам", 70, 85)
    mono = torch.from_numpy(vocals.mean(1).copy())
    mono16k = AF.resample(mono, SR, PITCH_SR).numpy()
    del vocals
    midi, voiced = extract_pitch(mono16k)
    notes = segment_notes(_median(midi, 5), voiced)
    (d / "notes.json").write_text(json.dumps(notes), "utf-8")

    cb = stage("Распознаём текст песни", 85, 100)
    try:
        lines, language = transcribe(mono16k, voiced, on_progress=cb)
        warning = None if lines else "Текст не распознан"
    except Exception as e:  # текст не обязателен для игры
        traceback.print_exc()
        lines, language, warning = [], None, f"Текст не распознан: {e}"
    (d / "lyrics.json").write_text(json.dumps(lines, ensure_ascii=False), "utf-8")

    write_meta(song_id, status="ready", stage=None, progress=100, duration=round(duration, 2),
               notes=len(notes), lines=len(lines), language=language, warning=warning)


def retranscribe(song_id: str, options: dict) -> None:
    """Распознаёт текст заново по готовому голосу; при неудаче песня остаётся с прежним текстом."""
    d = song_dir(song_id)
    cb = _stage(song_id, "Распознаём текст заново", 0, 100)
    try:
        mono16k = _vocals16k(song_id)
        notes = json.loads((d / "notes.json").read_text("utf-8"))
        voiced = voiced_from_notes(notes, len(mono16k) // HOP + 1)
        lines, language = transcribe(mono16k, voiced, on_progress=cb, **options)
    except Exception as e:
        traceback.print_exc()
        write_meta(song_id, status="ready", stage=None, progress=100, warning=f"Не удалось распознать: {e}")
        return
    (d / "lyrics.json").write_text(json.dumps(lines, ensure_ascii=False), "utf-8")
    write_meta(song_id, status="ready", stage=None, progress=100, lines=len(lines),
               language=language, warning=None if lines else "Текст не распознан")


def _worker() -> None:
    while True:
        kind, song_id, options = _jobs.get()
        try:
            if not read_meta(song_id):
                continue
            if kind == "transcribe":
                retranscribe(song_id, options)
            else:
                process(song_id)
        except Exception as e:
            traceback.print_exc()
            if read_meta(song_id):
                detail = e.stderr.decode("utf-8", "replace")[-300:] if isinstance(
                    e, subprocess.CalledProcessError) and e.stderr else str(e)
                write_meta(song_id, status="error", stage=None, error=detail or type(e).__name__)


def enqueue(song_id: str, kind: str = "process", **options) -> None:
    write_meta(song_id, status="queued", stage="В очереди", progress=0, error=None, job=kind)
    _jobs.put((kind, song_id, options))


def attach_video(song_id: str, upload: Path) -> None:
    """Готовит загруженный клип в фоне: песня тем временем остаётся доступной."""
    def run():
        try:
            video = prepare_video(upload, song_dir(song_id))
            if read_meta(song_id):
                write_meta(song_id, video=video, videoVersion=int(time.time()), videoStatus=None,
                           videoError=None if video else "В файле нет видео")
        except Exception as e:
            traceback.print_exc()
            if read_meta(song_id):
                write_meta(song_id, videoStatus=None, videoError=str(e)[-300:])
        finally:
            upload.unlink(missing_ok=True)

    write_meta(song_id, videoStatus="processing", videoError=None)
    threading.Thread(target=run, daemon=True).start()


def start() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    for meta in list_songs():
        if meta.get("status") in ("queued", "processing"):
            if meta.get("job") == "transcribe":
                enqueue(meta["id"], "transcribe")
            else:
                enqueue(meta["id"])
        if meta.get("videoStatus"):
            write_meta(meta["id"], videoStatus=None)
    threading.Thread(target=_worker, daemon=True).start()
