import math
import re
import struct
from dataclasses import dataclass
from typing import Tuple


@dataclass
class VadFrameResult:
    rms: float
    is_speech: bool
    speech_duration_ms: float
    silence_duration_ms: float
    should_trigger_barge_in: bool


@dataclass
class SemanticTurnDecision:
    is_complete: bool
    recommended_silence_ms: int
    reason: str


class AudioVadProcessor:
    """
    Real-Time Voice Activity Detector (VAD) operating on 16kHz Mono Int16 PCM frames (~20ms-32ms).
    Computes RMS energy + adaptive noise floor in <0.2ms per frame, detecting:
      1. Active human speech vs background noise.
      2. Continuous speech >= `min_barge_in_ms` while AI is speaking -> triggers instant Barge-In!
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        energy_threshold: float = 0.025,
        min_barge_in_ms: float = 180.0,
    ) -> None:
        self.sample_rate = sample_rate
        self.energy_threshold = energy_threshold
        self.min_barge_in_ms = min_barge_in_ms
        self.noise_floor: float = 0.008
        self.speech_duration_ms: float = 0.0
        self.silence_duration_ms: float = 0.0
        self._barge_in_emitted: bool = False

    def reset_turn(self) -> None:
        self.speech_duration_ms = 0.0
        self.silence_duration_ms = 0.0
        self._barge_in_emitted = False

    def process_pcm16_frame(
        self, pcm_bytes: bytes, ai_is_speaking: bool
    ) -> VadFrameResult:
        num_samples = len(pcm_bytes) // 2
        if num_samples == 0:
            return VadFrameResult(0.0, False, self.speech_duration_ms, self.silence_duration_ms, False)

        frame_ms = (num_samples / float(self.sample_rate)) * 1000.0
        samples = struct.unpack(f"<{num_samples}h", pcm_bytes[: num_samples * 2])
        sum_sq = sum(s * s for s in samples)
        rms = math.sqrt(sum_sq / num_samples) / 32768.0

        # Adaptive threshold stays safely above background room noise
        dynamic_threshold = max(self.energy_threshold, self.noise_floor * 2.6)
        # Slightly higher threshold while AI is speaking to reject residual speaker bleed
        effective_threshold = dynamic_threshold * (1.25 if ai_is_speaking else 1.0)
        is_speech = rms >= effective_threshold

        if is_speech:
            self.speech_duration_ms += frame_ms
            self.silence_duration_ms = 0.0
        else:
            # Smoothly track ambient noise floor during silence
            self.noise_floor = (self.noise_floor * 0.96) + (min(rms, 0.04) * 0.04)
            self.silence_duration_ms += frame_ms
            if self.silence_duration_ms >= 140.0:
                self.speech_duration_ms = 0.0
                self._barge_in_emitted = False

        should_barge_in = False
        if (
            ai_is_speaking
            and not self._barge_in_emitted
            and self.speech_duration_ms >= self.min_barge_in_ms
        ):
            self._barge_in_emitted = True
            should_barge_in = True

        return VadFrameResult(
            rms=round(rms, 4),
            is_speech=is_speech,
            speech_duration_ms=round(self.speech_duration_ms, 1),
            silence_duration_ms=round(self.silence_duration_ms, 1),
            should_trigger_barge_in=should_barge_in,
        )


# Bangla trailing words that indicate the customer is STILL mid-sentence (wait longer!)
_INCOMPLETE_ENDINGS = re.compile(
    r"(?:আমি|আমার|আমাকে|একটা|একটি|দুটো|দুইটা|নতুন|এবং|আর|কিন্তু|অথবা|হবে|হচ্ছে|কালার|রঙ|সাইজ|ব্র্যান্ড|ঠিকানা|ডেলিভারি|প্রোডাক্ট|পণ্য|যে|যদি|উম|মানে|তাহলে|জন্য)\s*$",
    re.I,
)

# Bangla / Banglish endings that clearly indicate a finished thought (respond rapidly!)
_COMPLETE_ENDINGS = re.compile(
    r"(?:চাই|চাচ্ছি|নিব|নিবো|দিন|দেন|করুন|করবো|করব|করো|পাঠান|পাঠাবেন|দিবেন|ঠিক\s*আছে|কনফার্ম|ধন্যবাদ|বাই\s*বাই|হাফেজ|পিকআপ|পিকাপ|আগেরটাই|আগের\s*ঠিকানায়|আগের\s*ঠিকানায়|ব্লু|কালো|সাদা|মেরুন|লাল|সবুজ|ddr4|ddr5|gb|mhz|hz|ips|va|inch|corsair|kingston|asus|lg|samsung|xiaomi|logitech|a4tech|\b[০-৯0-9]{2}\b|\b(?:m|l|xl)\b)\s*[।?!.]*$",
    re.I,
)


class BanglaSemanticTurnDetector:
    """
    Smart Semantic End-of-Turn (EOT) Detector for Bangla Voice Commerce.
    Solves the classic silence-timer dilemma:
      - If customer pauses mid-sentence ("আমি একটা পাঞ্জাবি..."), extends patience to 2100ms.
      - If customer finishes a clear thought ("সাইজ ৪২ নেভি ব্লু" / "আগের ঠিকানায় কনফার্ম করুন"),
        triggers response in just 650ms!
    """

    def evaluate_turn(self, partial_text: str) -> SemanticTurnDecision:
        cleaned = (partial_text or "").strip()
        if not cleaned:
            return SemanticTurnDecision(False, 2200, "empty")

        words = cleaned.split()
        if _INCOMPLETE_ENDINGS.search(cleaned):
            return SemanticTurnDecision(
                is_complete=False,
                recommended_silence_ms=2100,
                reason="incomplete_bangla_clause",
            )

        if _COMPLETE_ENDINGS.search(cleaned):
            return SemanticTurnDecision(
                is_complete=True,
                recommended_silence_ms=650,
                reason="complete_bangla_utterance",
            )

        # Very short 1-word partial (could still be starting a sentence)
        if len(words) <= 1:
            return SemanticTurnDecision(
                is_complete=False,
                recommended_silence_ms=1600,
                reason="single_word_waiting",
            )

        return SemanticTurnDecision(
            is_complete=True,
            recommended_silence_ms=1100,
            reason="standard_pause_threshold",
        )
