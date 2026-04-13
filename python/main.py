import os
import time
import uuid
import json
import hashlib
import sqlite3
import httpx
import uvicorn
import lancedb

from fastapi import FastAPI
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
    """Initializes the SQLite schema for tracking documents and chunks."""
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manages database connections for the lifecycle of the FastAPI app."""
    app.state.lance = lancedb.connect(f"{DB_PATH}/lancedb")
    app.state.sqlite = sqlite3.connect(f"{DB_PATH}/meta.db", check_same_thread=False)
    _init_db(app.state.sqlite)
    yield
    app.state.sqlite.close()

# Initialize FastAPI App
app = FastAPI(lifespan=lifespan, title="LocalRAG API")

# Allow UI to communicate with the backend
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
    model: str = "nemotron-3-nano:4b"  # Default model
    history: list[Message] = []        # Critical for chat memory


# =============================================================================
# 3. AI & FILE PROCESSING SERVICES
# =============================================================================
def get_file_hash(path: str) -> str:
    """Calculates SHA-256 to detect file modifications."""
    hasher = hashlib.sha256()
    with open(path, 'rb') as f:
        hasher.update(f.read())
    return hasher.hexdigest()

def extract_text(path: str) -> str:
    """Extracts raw text from PDFs or plain text files."""
    if path.lower().endswith('.pdf'):
        reader = PdfReader(path)
        return "\n".join([page.extract_text() for page in reader.pages if page.extract_text()])
    else:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()

def chunk_text(text: str, chunk_size: int = 1500, overlap: int = 150) -> list[str]:
    """
    Splits text intelligently using natural language boundaries.
    Note: chunk_size is in CHARACTERS, not words. 
    1500 chars is roughly 300-400 words.
    """
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=overlap,
        # It tries to split by paragraph first. 
        # If the paragraph is too big, it tries by sentence, then by word.
        separators=["\n\n", "\n", r"(?<=\. )", " ", ""]
    )
    
    # LangChain handles all the complex boundary math for us
    return splitter.split_text(text)

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

async def stream_ollama(prompt: str, context: str, model: str, history: list[Message]):
    """Yields text tokens from Ollama, incorporating chat history and document context."""
    
    # Instruction directing the model to use context if applicable, or general knowledge otherwise
    system_instruction = (
        "You are an intelligent, capable AI assistant. "
        "You have access to the user's documents below. If the user's question relates to these documents, "
        "use the context to answer and explicitly cite the source filename (e.g., 'According to document.pdf...'). "
        "If the question is general, use your own general knowledge to answer normally.\n\n"
        f"--- START DOCUMENT CONTEXT ---\n{context}\n--- END DOCUMENT CONTEXT ---\n\n"
        f"USER'S LATEST PROMPT: {prompt}"
    )
    
    # Format the past conversation history
    formatted_messages = [{"role": msg.role, "content": msg.content} for msg in history]
    # Append the newly constructed prompt as the latest user message
    formatted_messages.append({"role": "user", "content": system_instruction})

    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST", 
            "http://localhost:11434/api/chat",
            json={
                "model": model,
                "messages": formatted_messages,
                "stream": True,
                "temperature": 0.3 # Allows conversational flow while maintaining accuracy
            },
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
    """Simple health check for the UI to poll."""
    return {"status": "ok"}

@app.get("/documents")
def get_documents():
    """Returns a list of all ingested documents to populate the UI sidebar."""
    cursor = app.state.sqlite.cursor()
    cursor.execute("SELECT id, path, status, chunk_count FROM documents ORDER BY ingested_at DESC")
    docs = []
    for row in cursor.fetchall():
        docs.append({
            "id": row[0],
            "name": os.path.basename(row[1]),
            "path": row[1],
            "status": row[2],
            "chunks": row[3]
        })
    return {"documents": docs}

@app.post("/ingest")
async def ingest_document(req: IngestRequest):
    """Processes a file: extracts text, chunks it, embeds it, and stores it."""
    if not os.path.exists(req.path):
        return {"error": "File not found"}
        
    doc_id = str(uuid.uuid4())
    content_hash = get_file_hash(req.path)
    raw_text = extract_text(req.path)
    chunks = chunk_text(raw_text)
    
    sqlite_conn = app.state.sqlite
    cursor = sqlite_conn.cursor()
    
    cursor.execute("""
        INSERT INTO documents (id, path, content_hash, ingested_at, chunk_count, status)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (doc_id, req.path, content_hash, int(time.time()), len(chunks), 'ingesting'))
    sqlite_conn.commit()

    try:
        lance_data = []
        for i, text in enumerate(chunks):
            chunk_id = f"{doc_id}_{i}"
            vector = await get_embedding(text)
            
            cursor.execute("""
                INSERT INTO chunks (id, doc_id, chunk_index, text)
                VALUES (?, ?, ?, ?)
            """, (chunk_id, doc_id, i, text))
            
            lance_data.append({
                "vector": vector,
                "id": chunk_id,
                "doc_id": doc_id,
                "text": text
            })

        db = app.state.lance
        table_name = "vectors"
        if table_name in db.table_names():
            tbl = db.open_table(table_name)
            tbl.add(lance_data)
        else:
            db.create_table(table_name, data=lance_data)

        cursor.execute("UPDATE documents SET status = 'ready' WHERE id = ?", (doc_id,))
        sqlite_conn.commit()
        
        return {"status": "success", "doc_id": doc_id, "chunks_processed": len(chunks)}

    except Exception as e:
        cursor.execute("UPDATE documents SET status = 'failed' WHERE id = ?", (doc_id,))
        sqlite_conn.commit()
        return {"error": str(e)}

@app.post("/query")
async def query_documents(req: QueryRequest):
    """Retrieves relevant document chunks and streams an AI response."""
    query_vector = await get_embedding(req.prompt)
    db = app.state.lance
    
    context_chunks = []
    if "vectors" in db.table_names():
        tbl = db.open_table("vectors")
        results = tbl.search(query_vector).limit(4).to_list()
        
        # Inject filenames into the retrieved chunks for accurate AI citations
        if results:
            doc_ids = list(set([res["doc_id"] for res in results]))
            placeholders = ",".join("?" * len(doc_ids))
            cursor = app.state.sqlite.cursor()
            cursor.execute(f"SELECT id, path FROM documents WHERE id IN ({placeholders})", doc_ids)
            path_map = {row[0]: os.path.basename(row[1]) for row in cursor.fetchall()}
            
            for res in results:
                filename = path_map.get(res["doc_id"], "Unknown Document")
                context_chunks.append(f"[Source File: {filename}]\n{res['text']}")
                
    assembled_context = "\n\n".join(context_chunks) if context_chunks else "No relevant documents found."
    
    return StreamingResponse(
        stream_ollama(req.prompt, assembled_context, req.model, req.history),
        media_type="text/event-stream"
    )

@app.delete("/documents/{doc_id}")
def delete_document(doc_id: str):
    """Removes a document from both the SQL metadata and Vector DB."""
    cursor = app.state.sqlite.cursor()
    
    db = app.state.lance
    if "vectors" in db.table_names():
        tbl = db.open_table("vectors")
        tbl.delete(f"doc_id = '{doc_id}'")
        
    cursor.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
    cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    app.state.sqlite.commit()
    
    return {"status": "success"}


# =============================================================================
# 5. ENTRY POINT
# =============================================================================
if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")