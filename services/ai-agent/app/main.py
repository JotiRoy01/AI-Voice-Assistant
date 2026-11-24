from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from app.agent.graph import langgraph_agent
from app.core.config import config
from app.guardrails import GuardrailPolicy, get_tenant_policy, set_tenant_policy
from app.rag.rag_store import rag_store
from app.realtime import RealtimeVoiceSessionWorker
from app.schemas.models import AgentTurnRequest, AgentTurnResponse

app = FastAPI(
    title="FlowMind AI — Phase 2 Python AI Agent & Multi-Tenant RAG Service",
    version="2.0.0",
    description="LangGraph-style Stateful Bangla Voice Commerce Agent with CSV/Document RAG, Dedicated Anti-Hallucination Guardrails & Dynamic Product Attribute Schema Validation.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class CsvIngestRequest(BaseModel):
    tenant_id: str
    csv_content: str
    replace_existing: bool = False


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "flowmind-python-ai-agent",
        "version": "2.0.0",
        "gemini_configured": bool(config.GEMINI_API_KEY),
        "ollama_url": config.OLLAMA_BASE_URL,
        "guardrails_enabled": True,
    }


@app.get("/api/v1/guardrails/policy/{tenant_id}", response_model=GuardrailPolicy)
def get_guardrail_policy(tenant_id: str):
    """
    Returns the active Anti-Hallucination GuardrailPolicy for `tenant_id`.
    """
    return get_tenant_policy(tenant_id)


@app.put("/api/v1/guardrails/policy/{tenant_id}", response_model=GuardrailPolicy)
def update_guardrail_policy(tenant_id: str, policy: GuardrailPolicy):
    """
    Updates the Anti-Hallucination GuardrailPolicy for `tenant_id`
    (e.g., toggling `strict_catalog_only` or `enforce_attribute_options_whitelist`).
    """
    return set_tenant_policy(tenant_id, policy)


@app.get("/api/v1/catalog/{tenant_id}")
def get_tenant_catalog(tenant_id: str):
    """
    Returns all products and their required_attributes for `tenant_id`
    (auto-seeding the 12-item multi-category Bangladeshi catalog if empty).
    """
    items = rag_store.ensure_tenant_seeded(tenant_id, config.SAMPLE_CSV_PATH)
    return {
        "tenant_id": tenant_id,
        "count": len(items),
        "products": [item.model_dump() for item in items],
    }


@app.post("/api/v1/knowledge/ingest-csv")
def ingest_csv_json(req: CsvIngestRequest):
    """
    Ingests raw CSV text content for a tenant (supports both full schema CSVs and simple 2-column CSVs).
    """
    if not req.csv_content.strip():
        raise HTTPException(status_code=400, detail="csv_content cannot be empty")
    items = rag_store.ingest_csv_content(
        req.tenant_id, req.csv_content, replace_existing=req.replace_existing
    )
    return {
        "tenant_id": req.tenant_id,
        "ingested_count": len(items),
        "products": [item.model_dump() for item in items],
    }


@app.post("/api/v1/knowledge/upload-file")
async def upload_catalog_file(
    tenant_id: str = Form(...),
    replace_existing: bool = Form(False),
    file: UploadFile = File(...),
):
    """
    Multipart file upload endpoint for `.csv` or `.json` company product files.
    """
    raw_bytes = await file.read()
    content_str = raw_bytes.decode("utf-8", errors="replace")
    items = rag_store.ingest_csv_content(
        tenant_id, content_str, replace_existing=replace_existing
    )
    return {
        "tenant_id": tenant_id,
        "filename": file.filename,
        "ingested_count": len(items),
        "products": [item.model_dump() for item in items],
    }


@app.post("/api/v1/agent/turn", response_model=AgentTurnResponse)
def process_agent_turn(req: AgentTurnRequest):
    """
    Executes one conversational turn through the Python AI Agent
    (Input Guard -> RAG Lookup -> LLM Tool Calling -> Guardrail Verification -> StoreAdapter Formatter).
    """
    return langgraph_agent.run_turn(req)


@app.websocket("/ws/realtime")
async def realtime_voice_websocket(websocket: WebSocket):
    """
    Phase 3 Full-Duplex Real-Time Voice Endpoint:
    Streams 20ms 16kHz PCM mic frames IN + Speculative RAG + Smart Semantic Turn Detection
    + Instant Barge-In (<50ms audio flush & context truncation) + Clause-by-Clause Streaming Bangla TTS OUT.
    """
    worker = RealtimeVoiceSessionWorker(websocket)
    await worker.run()
