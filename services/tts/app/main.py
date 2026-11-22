import hashlib
import os
import shutil
import subprocess
import wave
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

CACHE_DIR = Path(os.getenv("TTS_CACHE_DIR", "./audio-cache")).resolve()
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DEFAULT_VOICE = os.getenv("TTS_DEFAULT_VOICE", "bn-BD-NabanitaNeural")
PIPER_BIN = os.getenv("PIPER_BIN", "piper")
PIPER_MODEL_PATH = os.getenv("PIPER_MODEL_PATH", "")

SUPPORTED_VOICES = [
    {
        "id": "bn-BD-NabanitaNeural",
        "name": "Nabanita (Bangladeshi Bangla — Female Neural)",
        "language": "bn-BD",
        "engine": "edge-tts",
    },
    {
        "id": "bn-BD-PradeepNeural",
        "name": "Pradeep (Bangladeshi Bangla — Male Neural)",
        "language": "bn-BD",
        "engine": "edge-tts",
    },
    {
        "id": "bn-IN-TanishaaNeural",
        "name": "Tanishaa (Bengali — Female Neural)",
        "language": "bn-IN",
        "engine": "edge-tts",
    },
    {
        "id": "piper-bn-local",
        "name": "Piper Local ONNX (Offline Bengali)",
        "language": "bn-BD",
        "engine": "piper",
    },
]

app = FastAPI(
    title="FlowMind AI — Bangla TTS Microservice",
    version="1.0.0",
    description="Low-cost self-hostable Bangla TTS adapter with SHA-256 audio caching (SRS FR-07).",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voice: str = Field(default=DEFAULT_VOICE)
    language: str = Field(default="bn-BD")
    format: Literal["mp3", "wav"] = Field(default="mp3")


class SynthesizeResponse(BaseModel):
    cache_key: str
    cached: bool
    engine: str
    voice: str
    format: str
    audio_url: str
    size_bytes: int


def compute_cache_key(text: str, voice: str, fmt: str) -> str:
    payload = f"{voice}|{fmt}|{text.strip()}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


async def synthesize_with_edge_tts(text: str, voice: str, out_mp3: Path) -> None:
    import edge_tts

    selected_voice = voice if "Neural" in voice else DEFAULT_VOICE
    communicate = edge_tts.Communicate(text=text, voice=selected_voice, rate="-4%")
    await communicate.save(str(out_mp3))


def synthesize_with_piper(text: str, out_wav: Path) -> bool:
    if not PIPER_MODEL_PATH or not Path(PIPER_MODEL_PATH).exists() or not shutil.which(PIPER_BIN):
        return False
    proc = subprocess.run(
        [PIPER_BIN, "--model", PIPER_MODEL_PATH, "--output_file", str(out_wav)],
        input=text.encode("utf-8"),
        capture_output=True,
        timeout=20,
    )
    return proc.returncode == 0 and out_wav.exists() and out_wav.stat().st_size > 0


def synthesize_with_gtts(text: str, out_mp3: Path) -> None:
    from gtts import gTTS

    tts = gTTS(text=text, lang="bn", slow=False)
    tts.save(str(out_mp3))


def convert_to_asterisk_wav(src: Path, dst_wav: Path) -> bool:
    """Converts audio to 8kHz mono 16-bit PCM WAV for Asterisk PBX playback."""
    if not shutil.which("ffmpeg"):
        return False
    proc = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(src),
            "-ar",
            "8000",
            "-ac",
            "1",
            "-sample_fmt",
            "s16",
            str(dst_wav),
        ],
        capture_output=True,
        timeout=20,
    )
    return proc.returncode == 0 and dst_wav.exists()


def write_silence_wav_fallback(dst_wav: Path) -> None:
    """Generates a valid 1-second 8kHz mono PCM WAV fallback if offline with no models."""
    with wave.open(str(dst_wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00" * 8000)


@app.get("/health")
def health():
    cached_files = len(list(CACHE_DIR.glob("*.*")))
    return {
        "status": "ok",
        "service": "flowmind-bangla-tts",
        "default_voice": DEFAULT_VOICE,
        "piper_available": bool(PIPER_MODEL_PATH and Path(PIPER_MODEL_PATH).exists() and shutil.which(PIPER_BIN)),
        "ffmpeg_available": bool(shutil.which("ffmpeg")),
        "cached_assets": cached_files,
    }


@app.get("/voices")
def list_voices():
    return {"voices": SUPPORTED_VOICES}


@app.post("/synthesize", response_model=SynthesizeResponse)
async def synthesize(req: SynthesizeRequest):
    cache_key = compute_cache_key(req.text, req.voice, req.format)
    target_path = CACHE_DIR / f"{cache_key}.{req.format}"

    if target_path.exists() and target_path.stat().st_size > 0:
        return SynthesizeResponse(
            cache_key=cache_key,
            cached=True,
            engine="cache",
            voice=req.voice,
            format=req.format,
            audio_url=f"/audio/{cache_key}.{req.format}",
            size_bytes=target_path.stat().st_size,
        )

    engine_used: Optional[str] = None
    temp_mp3 = CACHE_DIR / f"{cache_key}.tmp.mp3"

    # 1. Try local offline Piper ONNX if requested/configured
    if req.voice == "piper-bn-local" or (PIPER_MODEL_PATH and req.format == "wav"):
        if synthesize_with_piper(req.text, target_path):
            engine_used = "piper"

    # 2. Try free Microsoft Neural Bangladeshi Bangla via edge-tts
    if not engine_used:
        try:
            await synthesize_with_edge_tts(req.text, req.voice, temp_mp3)
            engine_used = "edge-tts"
        except Exception:
            # 3. Fallback to free gTTS Bengali
            try:
                synthesize_with_gtts(req.text, temp_mp3)
                engine_used = "gtts"
            except Exception as fallback_err:
                if req.format == "wav":
                    write_silence_wav_fallback(target_path)
                    engine_used = "offline-fallback"
                else:
                    raise HTTPException(
                        status_code=503,
                        detail=f"All Bangla TTS engines unavailable: {fallback_err}",
                    )

    if temp_mp3.exists():
        if req.format == "mp3":
            temp_mp3.replace(target_path)
        else:
            ok = convert_to_asterisk_wav(temp_mp3, target_path)
            temp_mp3.unlink(missing_ok=True)
            if not ok:
                write_silence_wav_fallback(target_path)

    return SynthesizeResponse(
        cache_key=cache_key,
        cached=False,
        engine=engine_used or "unknown",
        voice=req.voice,
        format=req.format,
        audio_url=f"/audio/{cache_key}.{req.format}",
        size_bytes=target_path.stat().st_size,
    )


@app.get("/audio/{filename}")
def get_audio(filename: str):
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid audio filename")
    path = CACHE_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Cached audio asset not found")
    media_type = "audio/wav" if filename.endswith(".wav") else "audio/mpeg"
    return FileResponse(path=str(path), media_type=media_type, filename=filename)
