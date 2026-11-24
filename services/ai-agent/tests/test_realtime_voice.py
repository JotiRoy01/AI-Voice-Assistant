import asyncio
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from app.core.config import config
from app.main import app
from app.rag.rag_store import rag_store
from app.realtime import (
    AudioVadProcessor,
    BanglaSemanticTurnDetector,
    BargeInController,
    SpeculativeSttStreamProcessor,
    split_into_spoken_clauses,
)


class TestPhase3RealtimeAudioEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rag_store.ensure_tenant_seeded("tenant_rt_test", config.SAMPLE_CSV_PATH)

    def test_1_audio_vad_triggers_barge_in_on_continuous_speech(self):
        vad = AudioVadProcessor(sample_rate=16000, energy_threshold=0.02, min_barge_in_ms=150.0)
        # Generate loud speech-like 20ms Int16 PCM frame (320 samples @ 16kHz)
        loud_frame = struct.pack("<320h", *([8000] * 320))
        quiet_frame = struct.pack("<320h", *([10] * 320))

        # Quiet frames never trigger barge-in
        for _ in range(10):
            res = vad.process_pcm16_frame(quiet_frame, ai_is_speaking=True)
            self.assertFalse(res.should_trigger_barge_in)

        # Continuous loud frames >= 150ms (8 frames = 160ms) trigger instant barge-in!
        triggered = False
        for _ in range(10):
            res = vad.process_pcm16_frame(loud_frame, ai_is_speaking=True)
            if res.should_trigger_barge_in:
                triggered = True
        self.assertTrue(triggered)

    def test_2_semantic_turn_detector_avoids_mid_sentence_cutoff(self):
        detector = BanglaSemanticTurnDetector()
        incomplete = detector.evaluate_turn("আমি একটা নতুন পাঞ্জাবি")
        # Wait longer when user pauses after "আমি একটা"
        incomplete2 = detector.evaluate_turn("আমি একটা")
        self.assertFalse(incomplete2.is_complete)
        self.assertGreaterEqual(incomplete2.recommended_silence_ms, 2000)

        complete = detector.evaluate_turn("সাইজ ৪২ নেভি ব্লু দিন")
        self.assertTrue(complete.is_complete)
        self.assertLessEqual(complete.recommended_silence_ms, 700)

    def test_3_speculative_rag_runs_while_customer_is_still_speaking(self):
        stt = SpeculativeSttStreamProcessor()
        analysis = stt.process_interim_transcript("tenant_rt_test", "আমি একটা পাঞ্জাবি শেষ ৪২")
        self.assertIn("সাইজ ৪২", analysis.normalized_text)
        self.assertGreater(len(analysis.matched_products), 0)
        self.assertEqual(analysis.matched_products[0]["bangla_name"], "কটন পাঞ্জাবি")
        self.assertIn("colour", analysis.matched_products[0]["required_attributes"])

    def test_4_barge_in_controller_cancels_task_and_truncates_unspoken_clauses(self):
        async def run_scenario():
            ctrl = BargeInController()
            clauses = split_into_spoken_clauses(
                "আপনার কটন পাঞ্জাবি নোট করেছি। মোট বিল ২৪৫০ টাকা। ডেলিভারি কি গুলশানে পাঠাবো?"
            )
            self.assertEqual(len(clauses), 3)

            async def slow_stream():
                await asyncio.sleep(5)

            task = asyncio.create_task(slow_stream())
            ctrl.begin_ai_turn("turn-1", clauses, task)
            # Client heard only clause 0 ("আপনার কটন পাঞ্জাবি নোট করেছি।") before interrupting!
            ctrl.mark_clause_played("turn-1", 0)
            res = await ctrl.trigger_barge_in()

            self.assertTrue(res.interrupted)
            self.assertTrue(task.cancelled())
            self.assertIn("পাঞ্জাবি নোট করেছি", res.spoken_text_before_interrupt)
            self.assertIn("২৪৫০ টাকা", res.unspoken_text_discarded)

        asyncio.run(run_scenario())

    def test_5_websocket_realtime_speculative_and_barge_in_flow(self):
        client = TestClient(app)
        with client.websocket_connect("/ws/realtime") as ws:
            conn_evt = ws.receive_json()
            self.assertEqual(conn_evt["type"], "connected")

            # Send interim transcript WHILE speaking -> expect speculative_update immediately!
            ws.send_json(
                {
                    "type": "transcript_interim",
                    "text": "আমি একটা ১৬ জিবি DDR4 র‍্যাম",
                }
            )
            spec_evt = ws.receive_json()
            self.assertEqual(spec_evt["type"], "speculative_update")
            self.assertGreater(len(spec_evt["matched_products"]), 0)
            self.assertEqual(spec_evt["matched_products"][0]["category"], "PC Hardware")


if __name__ == "__main__":
    unittest.main()
