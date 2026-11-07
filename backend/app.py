import json
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import pipeline

FRONTEND = Path(__file__).resolve().parent.parent / "frontend" / "dist"
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus"}
VIDEO_EXT = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    pipeline.start()
    yield


app = FastAPI(lifespan=lifespan)


def _meta_or_404(song_id: str) -> dict:
    meta = pipeline.read_meta(song_id) if song_id.isalnum() else None
    if not meta:
        raise HTTPException(404, "Песня не найдена")
    return meta


def _ready_or_409(song_id: str) -> dict:
    meta = _meta_or_404(song_id)
    if meta["status"] != "ready":
        raise HTTPException(409, "Песня ещё не обработана")
    return meta


def _save_upload(file: UploadFile, path: Path) -> None:
    with path.open("wb") as out:
        shutil.copyfileobj(file.file, out)


@app.get("/api/songs")
def songs():
    return pipeline.list_songs()


@app.post("/api/songs")
def upload(file: UploadFile):
    name = Path(file.filename or "song.mp3")
    ext = name.suffix.lower()
    if ext not in AUDIO_EXT | VIDEO_EXT:
        raise HTTPException(400, "Нужен аудио- или видеофайл")
    song_id = uuid.uuid4().hex[:10]
    d = pipeline.song_dir(song_id)
    d.mkdir(parents=True)
    source = d / f"source{ext}"
    _save_upload(file, source)

    title, artist = pipeline.probe_tags(source)
    pipeline.write_meta(song_id, title=title or name.stem, artist=artist, source=source.name,
                        created=time.time(), sourceVideo=pipeline.probe_video(source) is not None)
    pipeline.enqueue(song_id)
    return pipeline.read_meta(song_id)


@app.get("/api/songs/{song_id}")
def song(song_id: str):
    meta = _meta_or_404(song_id)
    if meta["status"] == "ready":
        d = pipeline.song_dir(song_id)
        meta["noteList"] = json.loads((d / "notes.json").read_text("utf-8"))
        meta["lyrics"] = json.loads((d / "lyrics.json").read_text("utf-8"))
    return meta


class SongUpdate(BaseModel):
    title: str | None = None
    artist: str | None = None
    videoOffset: float | None = Field(default=None, ge=-600, le=600)


@app.patch("/api/songs/{song_id}")
def update_song(song_id: str, body: SongUpdate):
    meta = _meta_or_404(song_id)
    changes = {}
    if body.title is not None:
        changes["title"] = body.title.strip() or meta["title"]
    if body.artist is not None:
        changes["artist"] = body.artist.strip() or None
    if body.videoOffset is not None:
        changes["videoOffset"] = round(body.videoOffset, 3)
    return pipeline.write_meta(song_id, **changes)


class Word(BaseModel):
    t0: float = Field(ge=0)
    t1: float = Field(ge=0)
    text: str = Field(min_length=1)


class Line(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    words: list[Word] = Field(min_length=1)


class LyricsUpdate(BaseModel):
    title: str
    artist: str | None = None
    lines: list[Line]


@app.put("/api/songs/{song_id}/lyrics")
def save_lyrics(song_id: str, body: LyricsUpdate):
    meta = _ready_or_409(song_id)
    lines = sorted((line.model_dump() for line in body.lines), key=lambda line: line["start"])
    path = pipeline.song_dir(song_id) / "lyrics.json"
    path.write_text(json.dumps(lines, ensure_ascii=False), "utf-8")
    return pipeline.write_meta(song_id, title=body.title.strip() or meta["title"],
                               artist=(body.artist or "").strip() or None, lines=len(lines),
                               warning=None if lines else "Текст не задан")


class RecognizeOptions(BaseModel):
    model: Literal[pipeline.WHISPER_MODELS] | None = None  # type: ignore[valid-type]
    language: str | None = Field(default=None, max_length=8)
    prompt: str | None = Field(default=None, max_length=2000)


class RecognizeRange(RecognizeOptions):
    start: float = Field(ge=0)
    end: float = Field(gt=0)


@app.post("/api/songs/{song_id}/transcribe")
def transcribe(song_id: str, body: RecognizeOptions):
    """Распознать весь текст заново (в очереди обработки)."""
    _ready_or_409(song_id)
    pipeline.enqueue(song_id, "transcribe", **body.model_dump())
    return pipeline.read_meta(song_id)


@app.post("/api/songs/{song_id}/recognize")
def recognize(song_id: str, body: RecognizeRange):
    """Распознать выделенный фрагмент голоса и вернуть строки, ничего не сохраняя."""
    _ready_or_409(song_id)
    if body.end - body.start > 120:
        raise HTTPException(400, "Фрагмент длиннее двух минут — распознайте песню целиком")
    if body.end <= body.start:
        raise HTTPException(400, "Пустой фрагмент")
    options = body.model_dump(exclude={"start", "end"})
    return {"lines": pipeline.recognize(song_id, body.start, body.end, **options)}


@app.get("/api/songs/{song_id}/stem/{stem}")
def stem(song_id: str, stem: str, key: int = Query(0, ge=-pipeline.MAX_KEY, le=pipeline.MAX_KEY),
         download: bool = False):
    """Минус или голос в нужной тональности; download=1 — отдать файлом с понятным именем."""
    meta = _ready_or_409(song_id)
    if stem not in pipeline.STEMS:
        raise HTTPException(404, "Нет такой дорожки")
    path = pipeline.stem_path(song_id, stem, key)
    if not download:
        return FileResponse(path, media_type="audio/mpeg")
    name = f"{meta['artist']} — {meta['title']}" if meta.get("artist") else meta["title"]
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", name).strip() or "song"
    suffix = {"minus": "минус", "vocals": "голос"}[stem] + (f", тон {key:+d}" if key else "")
    return FileResponse(path, media_type="audio/mpeg", filename=f"{name} ({suffix}).mp3")


@app.post("/api/songs/{song_id}/video")
def upload_video(song_id: str, file: UploadFile):
    meta = _meta_or_404(song_id)
    ext = Path(file.filename or "clip.mp4").suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, "Нужен видеофайл")
    if meta.get("videoStatus") == "processing":
        raise HTTPException(409, "Предыдущий клип ещё готовится")
    upload = pipeline.song_dir(song_id) / f"clip-upload{ext}"
    _save_upload(file, upload)
    pipeline.attach_video(song_id, upload)
    return pipeline.read_meta(song_id)


@app.delete("/api/songs/{song_id}/video")
def delete_video(song_id: str):
    _meta_or_404(song_id)
    for path in pipeline.song_dir(song_id).glob("video.*"):
        path.unlink()
    return pipeline.write_meta(song_id, video=None, videoOffset=0, videoError=None)


@app.post("/api/songs/{song_id}/retry")
def retry(song_id: str):
    meta = _meta_or_404(song_id)
    if meta["status"] != "error":
        raise HTTPException(409, "Песня не в состоянии ошибки")
    pipeline.enqueue(song_id)
    return pipeline.read_meta(song_id)


@app.delete("/api/songs/{song_id}")
def delete(song_id: str):
    _meta_or_404(song_id)
    shutil.rmtree(pipeline.song_dir(song_id))
    return {"ok": True}


pipeline.DATA.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=pipeline.DATA), name="media")
if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
else:
    @app.get("/")
    def no_frontend():
        return HTMLResponse("<p>Фронтенд не собран: <code>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</code></p>")
