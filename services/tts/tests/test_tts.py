from fastapi.testclient import TestClient
from app.main import app, compute_cache_key


def test_health_endpoint():
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "flowmind-bangla-tts"


def test_voices_endpoint():
    client = TestClient(app)
    res = client.get("/voices")
    assert res.status_code == 200
    voices = res.json()["voices"]
    assert any(v["id"] == "bn-BD-NabanitaNeural" for v in voices)


def test_cache_key_deterministic():
    k1 = compute_cache_key("আসসালামু আলাইকুম", "bn-BD-NabanitaNeural", "mp3")
    k2 = compute_cache_key("  আসসালামু আলাইকুম  ", "bn-BD-NabanitaNeural", "mp3")
    k3 = compute_cache_key("আসসালামু আলাইকুম", "bn-BD-PradeepNeural", "mp3")
    assert k1 == k2
    assert k1 != k3
