import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from fastapi.responses import StreamingResponse
import lancedb
import sqlite3
import os
import json

DB_PATH = os.path.expanduser("~/local-rag-data")
os.makedirs(DB_PATH, exist_ok=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.lance = lancedb.connect(f"{DB_PATH}/lancedb")
    app.state.sqlite = sqlite3.connect(f"{DB_PATH}/meta.db", check_same_thread=False)
    _init_db(app.state.sqlite)
    yield
    app.state.sqlite.close()

def _init_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            ingested_at INTEGER,
            chunk_count INTEGER,
            status TEXT DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
            chunk_index INTEGER,
            text TEXT NOT NULL
        );
    """)
    conn.commit()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["tauri://localhost", "http://localhost:1420"], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")

def health():
    return {"status": "ok"}
import hashlib
import uuid
import time
import httpx
from pydantic import BaseModel
from pypdf import PdfReader

class IngestRequest(BaseModel):
    path: str

def get_file_hash(path: str) -> str:
    """Calculates SHA-256 to detect file modifications."""
    hasher = hashlib.sha256()
    with open(path, 'rb') as f:
        hasher.update(f.read())
    return hasher.hexdigest()

def extract_text(path: str) -> str:
    """Basic extraction. Expand this later for docx, markdown, etc."""
    if path.lower().endswith('.pdf'):
        reader = PdfReader(path)
        return "\n".join([page.extract_text() for page in reader.pages if page.extract_text()])
    else:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()

def chunk_text(text: str, chunk_size: int = 400, overlap: int = 50) -> list[str]:
    """A naive word-based chunker. (Upgrade to LangChain's RecursiveTextSplitter later)."""
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size - overlap):
        chunk = " ".join(words[i:i + chunk_size])
        chunks.append(chunk)
    return chunks

async def get_embedding(text: str) -> list[float]:
    """Calls local Ollama to vectorize the text."""
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "http://localhost:11434/api/embeddings",
            json={"model": "nomic-embed-text", "prompt": text},
            timeout=30.0
        )
        res.raise_for_status()
        return res.json()["embedding"]

@app.post("/ingest")
async def ingest_document(req: IngestRequest):
    # 1. Validate & Hash
    if not os.path.exists(req.path):
        return {"error": "File not found"}
        
    doc_id = str(uuid.uuid4())
    content_hash = get_file_hash(req.path)
    
    # 2. Extract & Chunk
    raw_text = extract_text(req.path)
    chunks = chunk_text(raw_text)
    
    sqlite_conn = app.state.sqlite
    cursor = sqlite_conn.cursor()
    
    # Insert Document Metadata (Status: Ingesting)
    cursor.execute("""
        INSERT INTO documents (id, path, content_hash, ingested_at, chunk_count, status)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (doc_id, req.path, content_hash, int(time.time()), len(chunks), 'ingesting'))
    sqlite_conn.commit()

    try:
        lance_data = []
        # 3. Embed & Prepare Database Rows
        for i, text in enumerate(chunks):
            chunk_id = f"{doc_id}_{i}"
            vector = await get_embedding(text)
            
            # Save to SQLite (for BM25 rebuilding later)
            cursor.execute("""
                INSERT INTO chunks (id, doc_id, chunk_index, text)
                VALUES (?, ?, ?, ?)
            """, (chunk_id, doc_id, i, text))
            
            # Prepare for LanceDB
            lance_data.append({
                "vector": vector,
                "id": chunk_id,
                "doc_id": doc_id,
                "text": text
            })

        # 4. Save to LanceDB
        db = app.state.lance
        table_name = "vectors"
        if table_name in db.table_names():
            tbl = db.open_table(table_name)
            tbl.add(lance_data)
        else:
            # LanceDB dynamically creates the schema based on the first data batch
            db.create_table(table_name, data=lance_data)

        # Update Document Status
        cursor.execute("UPDATE documents SET status = 'ready' WHERE id = ?", (doc_id,))
        sqlite_conn.commit()
        
        return {"status": "success", "doc_id": doc_id, "chunks_processed": len(chunks)}

    except Exception as e:
        cursor.execute("UPDATE documents SET status = 'failed' WHERE id = ?", (doc_id,))
        sqlite_conn.commit()
        return {"error": str(e)}

class QueryRequest(BaseModel):
    prompt: str
    model: str = "nemotron-3-nano:4b"  # Default, but allow the UI to override

async def stream_ollama(prompt: str, context: str, model: str):
    """Yields text tokens from Ollama to stream back to the client."""
    # Bundle everything into a single user prompt for Gemma compatibility
    combined_prompt = (
        "You are an intelligent local assistant. Answer the user's question based strictly on the provided context.\n"
        "If the answer is not contained within the context, state that you do not know based on your current documents.\n\n"
        f"--- START CONTEXT ---\n{context}\n--- END CONTEXT ---\n\n"
        f"QUESTION: {prompt}"
    )
    # --- DEBUG BLOCK ---
    # print("\n" + "="*50)
    # print("🚀 DEBUG: EXACT PROMPT SENT TO OLLAMA")
    # print("="*50)
    # print(combined_prompt)
    # print("="*50 + "\n")
    # ----------------------------
    
    async with httpx.AsyncClient() as client:
        # We use a context manager to stream the response from Ollama
        async with client.stream(
            "POST", 
            "http://localhost:11434/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "user", "content": combined_prompt}
                ],
                "stream": True,
                "temperature": 0.1
            },
            timeout=120.0
        ) as response:
            async for chunk in response.aiter_lines():
                if chunk:
                    # Ollama sends JSON lines; parse each one
                    data = json.loads(chunk)
                    if "message" in data and "content" in data["message"]:
                        # Yield the raw text token
                        yield data["message"]["content"]

@app.post("/query")
async def query_documents(req: QueryRequest):
    # 1. Embed the user's question
    query_vector = await get_embedding(req.prompt)
    
    # 2. Search LanceDB
    db = app.state.lance
    try:
        tbl = db.open_table("vectors")
        # Perform L2 distance vector search, grab top 3 chunks
        results = tbl.search(query_vector).limit(3).to_list()
    except Exception:
        return {"error": "Vector database is empty. Please ingest a document first."}
        
    # 3. Assemble Context
    context_chunks = [res["text"] for res in results]
    assembled_context = "\n\n---\n\n".join(context_chunks)
    
    # 4. Stream the LLM generation back to the UI
    return StreamingResponse(
        stream_ollama(req.prompt, assembled_context, req.model),
        media_type="text/event-stream"
    )
if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")