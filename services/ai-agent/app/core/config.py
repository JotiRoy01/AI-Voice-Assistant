import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from workspace root .env (parents[4]), cwd .env, and services/backend/.env
ROOT_DIR = Path(__file__).resolve().parents[4]
load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path.cwd() / ".env")
load_dotenv(ROOT_DIR / "services" / "backend" / ".env")


class AgentConfig:
    """
    Centralized configuration for the FlowMind Python AI Agent Microservice.
    Reads GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, and OLLAMA_BASE_URL from root .env.
    """

    PORT: int = int(os.getenv("AI_AGENT_PORT", "8001"))
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "").strip()
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "").strip()
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").strip()
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen2.5:7b").strip()
    BACKEND_API_URL: str = os.getenv("BACKEND_API_URL", "http://localhost:4000").strip()
    INTERNAL_SERVICE_TOKEN: str = os.getenv(
        "INTERNAL_SERVICE_TOKEN", "flowmind-internal-service-token-change-me"
    ).strip()
    SAMPLE_CSV_PATH: Path = (
        Path(__file__).resolve().parents[2]
        / "sample_catalogs"
        / "bd_multi_category_products.csv"
    )


config = AgentConfig()
