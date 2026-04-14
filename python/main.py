import os
import time
import uuid
import json
import hashlib
import sqlite3
import httpx
import uvicorn
import lancedb

from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
from pydantic import BaseModel
from pypdf import PdfReader
from langchain_text_splitters import RecursiveCharacterTextSplitter

# =============================================================================
# 1. CONSTANTS & DATABASE SETUP
# =============================================================================
DB_PATH = os.path.expanduser("~/local-rag-data")
os.makedirs(DB_PATH, exist_ok=True)

def _init_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            ingested_at INTEGER,
            chunk_count INTEGER,
            status TEXT DEFAULT 'pending',
            type TEXT DEFAULT 'file'
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
            chunk_index INTEGER,
            text TEXT NOT NULL
        );
    """)
    
    # NEW: Safe migration to add the 'type' column to your existing database
    try:
        conn.execute("ALTER TABLE documents ADD COLUMN type TEXT DEFAULT 'file'")
    except sqlite3.OperationalError:
        pass # Column already exists, safe to ignore
        
    # Ensure a container exists for our continuous memories
    cursor = conn.cursor()
    cursor.execute("INSERT OR IGNORE INTO documents (id, path, content_hash, chunk_count, status, type) VALUES (?, ?, ?, ?, ?, ?)", 
                   ("cephalon_memory", "Internal AI Memory", "none", 0, "ready", "memory"))
    conn.commit()

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.lance = lancedb.connect(f"{DB_PATH}/lancedb")
    app.state.sqlite = sqlite3.connect(f"{DB_PATH}/meta.db", check_same_thread=False)
    _init_db(app.state.sqlite)
    yield
    app.state.sqlite.close()

app = FastAPI(lifespan=lifespan, title="Lifelong Memory AI")

app.add_middleware(
    CORSMiddleware, 
    allow_origins=["tauri://localhost", "http://localhost:1420"], 
    allow_methods=["*"], 
    allow_headers=["*"]
)

# =============================================================================
# 2. PYDANTIC DATA MODELS
# =============================================================================
class Message(BaseModel):
    role: str
    content: str

class IngestRequest(BaseModel):
    path: str

class QueryRequest(BaseModel):
    prompt: str
    model: str = "nemotron-3-nano:4b" 
    history: list[Message] = []        

# =============================================================================
# 3. AI & MEMORY SERVICES
# =============================================================================
def get_file_hash(path: str) -> str:
    """Calculates SHA-256 to detect file modifications."""
    hasher = hashlib.sha256()
    with open(path, 'rb') as f:
        hasher.update(f.read())
    return hasher.hexdigest()

async def get_embedding(text: str) -> list[float]:
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "http://localhost:11434/api/embeddings",
            json={"model": "nomic-embed-text", "prompt": text},
            timeout=30.0
        )
        res.raise_for_status()
        return res.json()["embedding"]

async def save_permanent_memory(user_prompt: str, vector: list[float], lance_db):
    """Runs in the background to permanently store user interactions into LanceDB."""
    memory_id = f"mem_{uuid.uuid4()}"
    memory_text = f"[Past Conversation Context]: The user previously stated/asked: '{user_prompt}'"
    
    lance_data = [{
        "vector": vector,
        "id": memory_id,
        "doc_id": "cephalon_memory",
        "text": memory_text
    }]
    
    try:
        if "vectors" in lance_db.table_names():
            tbl = lance_db.open_table("vectors")
            tbl.add(lance_data)
        else:
            lance_db.create_table("vectors", data=lance_data)
    except Exception as e:
        print(f"Failed to save memory: {e}")

async def stream_ollama(prompt: str, context: str, model: str, history: list[Message]):
    """Streams the LLM response using both persistent memory and short-term chat history."""
    system_instruction = (
        "You are Cephalon, a highly intelligent AI companion with persistent memory. "
        "Below are fragments of your past conversations with the user, as well as any files they have given you. "
        "Use this retrieved context to maintain continuity, recall past facts about the user, and inform your answers. "
        "If a file is referenced, explicitly cite its name.\n\n"
        "SYSTEM AWARENESS: You are a desktop application built with Tauri v2, React, and FastAPI. "
        "Your memory is powered by LanceDB (for vector search) and SQLite (for metadata tracking). "
        "You run locally via Ollama. You use the nomic-embed-text model for embeddings and a RecursiveCharacterTextSplitter to parse documents. "
        "Every message the user sends is permanently embedded and stored in LanceDB. You retrieve these past messages "
        "to simulate lifelong memory. You are capable of discussing your own architecture and suggesting technical improvements to the user if asked.\n\n"
        f"--- START RECALLED MEMORIES & FILES ---\n{context}\n--- END RECALLED MEMORIES & FILES ---\n\n"
        f"USER'S LATEST PROMPT: {prompt}"
    )
    
    formatted_messages = [{"role": msg.role, "content": msg.content} for msg in history]
    formatted_messages.append({"role": "user", "content": system_instruction})

    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST", "http://localhost:11434/api/chat",
            json={"model": model, "messages": formatted_messages, "stream": True, "temperature": 0.4},
            timeout=120.0
        ) as response:
            async for chunk in response.aiter_lines():
                if chunk:
                    data = json.loads(chunk)
                    if "message" in data and "content" in data["message"]:
                        yield data["message"]["content"]

# =============================================================================
# 4. API ENDPOINTS
# =============================================================================
@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/documents")
def get_documents():
    cursor = app.state.sqlite.cursor()
    # Filter out the internal 'cephalon_memory' from the UI file list
    cursor.execute("SELECT id, path, status, chunk_count FROM documents WHERE type = 'file' ORDER BY ingested_at DESC")
    docs = [{"id": r[0], "name": os.path.basename(r[1]), "path": r[1], "status": r[2], "chunks": r[3]} for r in cursor.fetchall()]
    return {"documents": docs}

@app.post("/ingest")
async def ingest_document(req: IngestRequest):
    if not os.path.exists(req.path): return {"error": "File not found"}
        
    doc_id = str(uuid.uuid4())
    content_hash = get_file_hash(req.path) # (Assuming you keep your hashing/extraction functions from before)
    
    # Text extraction & Recursive Chunking
    if req.path.lower().endswith('.pdf'):
        raw_text = "\n".join([page.extract_text() for page in PdfReader(req.path).pages if page.extract_text()])
    else:
        with open(req.path, 'r', encoding='utf-8') as f: raw_text = f.read()
        
    splitter = RecursiveCharacterTextSplitter(chunk_size=1500, chunk_overlap=150, separators=["\n\n", "\n", r"(?<=\. )", " ", ""])
    chunks = splitter.split_text(raw_text)
    
    sqlite_conn = app.state.sqlite
    cursor = sqlite_conn.cursor()
    cursor.execute("INSERT INTO documents (id, path, content_hash, ingested_at, chunk_count, status, type) VALUES (?, ?, ?, ?, ?, ?, 'file')", 
                   (doc_id, req.path, content_hash, int(time.time()), len(chunks), 'ingesting'))
    sqlite_conn.commit()

    try:
        lance_data = []
        for i, text in enumerate(chunks):
            chunk_id = f"{doc_id}_{i}"
            vector = await get_embedding(text)
            cursor.execute("INSERT INTO chunks (id, doc_id, chunk_index, text) VALUES (?, ?, ?, ?)", (chunk_id, doc_id, i, text))
            lance_data.append({"vector": vector, "id": chunk_id, "doc_id": doc_id, "text": text})

        db = app.state.lance
        if "vectors" in db.table_names():
            db.open_table("vectors").add(lance_data)
        else:
            db.create_table("vectors", data=lance_data)

        cursor.execute("UPDATE documents SET status = 'ready' WHERE id = ?", (doc_id,))
        sqlite_conn.commit()
        return {"status": "success", "doc_id": doc_id, "chunks_processed": len(chunks)}
    except Exception as e:
        cursor.execute("UPDATE documents SET status = 'failed' WHERE id = ?", (doc_id,))
        sqlite_conn.commit()
        return {"error": str(e)}

@app.post("/query")
async def chat_and_remember(req: QueryRequest, background_tasks: BackgroundTasks):
    query_vector = await get_embedding(req.prompt)
    db = app.state.lance
    
    # 1. Add this conversation to permanent memory in the background
    background_tasks.add_task(save_permanent_memory, req.prompt, query_vector, app.state.lance)
    
    context_chunks = []
    if "vectors" in db.table_names():
        tbl = db.open_table("vectors")
        # Pull top 6 most relevant past memories OR file chunks combined
        results = tbl.search(query_vector).limit(6).to_list()
        
        if results:
            doc_ids = list(set([res["doc_id"] for res in results]))
            placeholders = ",".join("?" * len(doc_ids))
            cursor = app.state.sqlite.cursor()
            cursor.execute(f"SELECT id, path FROM documents WHERE id IN ({placeholders})", doc_ids)
            path_map = {row[0]: os.path.basename(row[1]) for row in cursor.fetchall()}
            
            for res in results:
                if res["doc_id"] == "cephalon_memory":
                    context_chunks.append(res['text'])
                else:
                    filename = path_map.get(res["doc_id"], "Unknown Document")
                    context_chunks.append(f"[Source File: {filename}]\n{res['text']}")
                
    assembled_context = "\n\n".join(context_chunks) if context_chunks else "No relevant memories or documents found."
    
    return StreamingResponse(
        stream_ollama(req.prompt, assembled_context, req.model, req.history),
        media_type="text/event-stream"
    )

@app.delete("/documents/{doc_id}")
def delete_document(doc_id: str):
    cursor = app.state.sqlite.cursor()
    db = app.state.lance
    if "vectors" in db.table_names():
        db.open_table("vectors").delete(f"doc_id = '{doc_id}'")
    cursor.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
    cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    app.state.sqlite.commit()
    return {"status": "success"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")