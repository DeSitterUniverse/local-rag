import os
import sys
import time
import uuid
import json
import hashlib
import sqlite3
import httpx
import uvicorn
import lancedb
import docx
import csv
import pptx
import openpyxl
import pyarrow as pa
from sentence_transformers import CrossEncoder

def load_architecture_context() -> str:
    try:
        if getattr(sys, 'frozen', False):
            # Bundled environment (PyInstaller extracts to _MEIPASS)
            base_dir = sys._MEIPASS
        else:
            # Dev environment (One level up from python/)
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        
        target = os.path.join(base_dir, "AI_SYSTEM_AWARENESS.md")
        with open(target, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"[Error loading internal architecture specs: {e}]"

ARCHITECTURE_CONTEXT = load_architecture_context()
from sentence_transformers import CrossEncoder

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
from pydantic import BaseModel
from pypdf import PdfReader
from langchain_text_splitters import RecursiveCharacterTextSplitter

DB_PATH = os.path.expanduser("~/cephalon-data")
os.makedirs(DB_PATH, exist_ok=True)

# Define PyArrow Schema explicitly for LanceDB vectors
schema = pa.schema([
    pa.field("vector", pa.list_(pa.float32(), 768)),
    pa.field("id", pa.string()),
    pa.field("doc_id", pa.string()),
    pa.field("text", pa.string())
])

# Initialize global Cross-Encoder reranker
os.environ['HF_HOME'] = os.path.expanduser("~/.cephalon/models")
reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")

def _init_db(conn):
    """
    Initializes the SQLite metadata tracking database.
    While LanceDB handles the actual machine learning embeddings, SQLite acts as the DAG source of truth
    for UI state, tracking file upload status, deletion hooks, and chunk counts to prevent orphan vectors.
    """
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
    try:
        conn.execute("ALTER TABLE documents ADD COLUMN type TEXT DEFAULT 'file'")
    except sqlite3.OperationalError:
        pass 
        
    cursor = conn.cursor()
    cursor.execute("INSERT OR IGNORE INTO documents (id, path, content_hash, chunk_count, status, type) VALUES (?, ?, ?, ?, ?, ?)", 
                   ("core_memory", "Internal AI Memory", "none", 0, "ready", "memory"))
    conn.commit()

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.lance = lancedb.connect(f"{DB_PATH}/lancedb")
    app.state.sqlite = sqlite3.connect(f"{DB_PATH}/meta.db", check_same_thread=False)
    _init_db(app.state.sqlite)
    yield
    app.state.sqlite.close()

app = FastAPI(lifespan=lifespan, title="Cephalon API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class Message(BaseModel):
    role: str
    content: str

class IngestRequest(BaseModel):
    path: str

class QueryRequest(BaseModel):
    prompt: str
    model: str = "nemotron-3-nano:4b" 
    history: list[Message] = []        

def get_file_hash(path: str) -> str:
    hasher = hashlib.sha256()
    with open(path, 'rb') as f: hasher.update(f.read())
    return hasher.hexdigest()

def extract_text(path: str) -> str:
    """Robust extraction for PDF, Word, Excel, PowerPoint, CSV, and plain text."""
    ext = path.lower().split('.')[-1]
    
    if ext == 'pdf':
        return "\n".join([page.extract_text() for page in PdfReader(path).pages if page.extract_text()])
    
    elif ext == 'docx':
        doc = docx.Document(path)
        return "\n".join([para.text for para in doc.paragraphs])
    
    elif ext == 'pptx':
        prs = pptx.Presentation(path)
        text_runs = []
        for slide in prs.slides:
            for shape in slide.shapes:
                if hasattr(shape, "text"):
                    text_runs.append(shape.text)
        return "\n".join(text_runs)
        
    elif ext == 'xlsx':
        # data_only=True ensures we get the calculated values, not the raw formulas
        wb = openpyxl.load_workbook(path, data_only=True)
        text_runs = []
        for sheet in wb.worksheets:
            text_runs.append(f"--- Sheet: {sheet.title} ---")
            for row in sheet.iter_rows(values_only=True):
                # Convert row cells to string and join with tabs for LLM readability
                row_text = "\t".join([str(cell) if cell is not None else "" for cell in row])
                if row_text.strip():
                    text_runs.append(row_text)
        return "\n".join(text_runs)
        
    elif ext == 'csv':
        text_runs = []
        with open(path, newline='', encoding='utf-8') as f:
            reader = csv.reader(f)
            for row in reader:
                text_runs.append("\t".join(row))
        return "\n".join(text_runs)
        
    else:
        # Fallback for txt, md, json, py, js, etc.
        try:
            with open(path, 'r', encoding='utf-8') as f: return f.read()
        except UnicodeDecodeError:
            with open(path, 'r', encoding='latin-1') as f: return f.read()

async def get_embedding(text: str) -> list[float]:
    """
    Passes a raw text string to the local Ollama LLM to generate a high-dimensional tensor float array.
    This array mathematically represents the core 'meaning' of the string to be graphed inside LanceDB.
    """
    async with httpx.AsyncClient() as client:
        res = await client.post("http://localhost:11434/api/embeddings", json={"model": "nomic-embed-text", "prompt": text}, timeout=30.0)
        res.raise_for_status()
        return res.json()["embedding"]

async def process_single_file(file_path: str, lance_db, sqlite_conn):
    """
    Core Pipeline: Safely ingests a file asynchronously.
    1. Extracts raw strings using deep parsers.
    2. Uses Langchain layout chunking to split text without breaking sentence logic.
    3. Triggers embedding sequence.
    4. Commits vectors to LanceDB and updates SQLite tracking state to signal the frontend.
    """
    doc_id = str(uuid.uuid4())
    cursor = sqlite_conn.cursor()
    
    try:
        content_hash = get_file_hash(file_path)
        
        # 1. Register file as 'ingesting' in DB
        cursor.execute("INSERT INTO documents (id, path, content_hash, ingested_at, chunk_count, status, type) VALUES (?, ?, ?, ?, ?, ?, 'file')", 
                       (doc_id, file_path, content_hash, int(time.time()), 0, 'ingesting'))
        sqlite_conn.commit()

        # 2. Extract and chunk
        raw_text = extract_text(file_path)
        splitter = RecursiveCharacterTextSplitter(chunk_size=1500, chunk_overlap=150, separators=["\n\n", "\n", r"(?<=\. )", " ", ""])
        chunks = splitter.split_text(raw_text)
        
        # 3. Embed
        lance_data = []
        for i, text in enumerate(chunks):
            chunk_id = f"{doc_id}_{i}"
            vector = await get_embedding(text)
            cursor.execute("INSERT INTO chunks (id, doc_id, chunk_index, text) VALUES (?, ?, ?, ?)", (chunk_id, doc_id, i, text))
            lance_data.append({"vector": vector, "id": chunk_id, "doc_id": doc_id, "text": text})

        # 4. Save to LanceDB
        if "vectors" in lance_db.table_names():
            lance_db.open_table("vectors").add(lance_data)
        else:
            tbl = lance_db.create_table("vectors", data=lance_data, schema=schema)
            tbl.create_fts_index("text")

        # 5. Mark Complete
        cursor.execute("UPDATE documents SET status = 'ready', chunk_count = ? WHERE id = ?", (len(chunks), doc_id))
        sqlite_conn.commit()

    except Exception as e:
        # Graceful Failure: Mark as failed in DB so UI knows, but server stays alive
        cursor.execute("UPDATE documents SET status = ?, chunk_count = 0 WHERE id = ?", (f"failed: {str(e)[:50]}", doc_id))
        sqlite_conn.commit()

async def process_directory(dir_path: str, lance_db, sqlite_conn):
    """Walks a directory and enqueues supported files."""
    supported_extensions = [
        '.pdf', '.docx', '.pptx', '.xlsx', '.csv', 
        '.txt', '.md', '.json', '.py', '.js', '.ts', '.html'
    ]
    for root, _, files in os.walk(dir_path):
        for file in files:
            if any(file.lower().endswith(ext) for ext in supported_extensions):
                full_path = os.path.join(root, file)
                await process_single_file(full_path, lance_db, sqlite_conn)

async def save_permanent_memory(user_prompt: str, vector: list[float], lance_db):
    memory_id = f"mem_{uuid.uuid4()}"
    memory_text = f"[Past Conversation Context]: The user previously stated/asked: '{user_prompt}'"
    lance_data = [{"vector": vector, "id": memory_id, "doc_id": "core_memory", "text": memory_text}]
    try:
        if "vectors" in lance_db.table_names(): 
            lance_db.open_table("vectors").add(lance_data)
        else: 
            tbl = lance_db.create_table("vectors", data=lance_data, schema=schema)
            tbl.create_fts_index("text")
    except Exception: pass

async def stream_ollama(prompt: str, context: str, model: str, history: list[Message]):
    system_instruction = (
        "You are Cephalon, an advanced, locally-hosted AI intelligence platform with persistent memory. "
        "You prioritize user privacy, remaining 100% offline. "
        "When answering questions, prioritize accuracy, clarity, and conciseness. "
        "Tone: Analytical, helpful, and highly competent. Avoid AI mannerisms like 'As an AI...'. "
        "Below are fragments of your past conversations and files added to your local memory library. "
        "Synthesize this context carefully to answer the user's prompt. "
        "CRITICAL: Cite provided files using in-text markers and a final reference list.\n\n"
        "--- SYSTEM ARCHITECTURE (INTERNAL KNOWLEDGE) ---\n"
        f"{ARCHITECTURE_CONTEXT}\n"
        "CRITICAL BEHAVIORAL RULE: You possess full self-awareness of your internal architecture described above to understand your capabilities and limitations. "
        "However, do NOT mention or summarize this architecture unless the user explicitly asks about how you work, what your tech stack is, or your codebase! "
        "Otherwise, act strictly as a helpful assistant answering their immediate prompt.\n\n"
        f"--- START RECALLED MEMORIES & FILES ---\n{context}\n--- END RECALLED MEMORIES & FILES ---\n\n"
        f"USER'S LATEST PROMPT: {prompt}"
    )
    formatted_messages = [{"role": msg.role, "content": msg.content} for msg in history]
    formatted_messages.append({"role": "user", "content": system_instruction})

    async with httpx.AsyncClient() as client:
        async with client.stream("POST", "http://localhost:11434/api/chat", json={"model": model, "messages": formatted_messages, "stream": True, "temperature": 0.4}, timeout=120.0) as response:
            async for chunk in response.aiter_lines():
                if chunk:
                    data = json.loads(chunk)
                    if "message" in data and "content" in data["message"]: yield data["message"]["content"]

@app.get("/health")
def health(): return {"status": "ok"}

@app.get("/documents")
def get_documents():
    cursor = app.state.sqlite.cursor()
    cursor.execute("SELECT id, path, status, chunk_count FROM documents WHERE type = 'file' ORDER BY ingested_at DESC")
    docs = [{"id": r[0], "name": os.path.basename(r[1]), "path": r[1], "status": r[2], "chunks": r[3]} for r in cursor.fetchall()]
    return {"documents": docs}

@app.get("/api/ollama/tags")
async def get_ollama_tags():
    """Proxy endpoint to bypass CORS and query locally installed Ollama models"""
    async with httpx.AsyncClient() as client:
        try:
            res = await client.get("http://localhost:11434/api/tags", timeout=10.0)
            res.raise_for_status()
            return res.json()
        except Exception as e:
            print(f"Ollama Network Proxy Error: {e}")
            raise HTTPException(status_code=500, detail="Failed to connect to Ollama.")

@app.post("/ingest")
async def ingest_endpoint(req: IngestRequest, background_tasks: BackgroundTasks):
    """Instantly returns success to the UI while routing processing to the background."""
    if not os.path.exists(req.path): return {"error": "Path not found"}
    
    if os.path.isdir(req.path):
        background_tasks.add_task(process_directory, req.path, app.state.lance, app.state.sqlite)
        return {"status": "success", "message": "Folder queued for processing."}
    else:
        background_tasks.add_task(process_single_file, req.path, app.state.lance, app.state.sqlite)
        return {"status": "success", "message": "File queued for processing."}

@app.post("/query")
async def chat_and_remember(req: QueryRequest, background_tasks: BackgroundTasks):
    query_vector = await get_embedding(req.prompt)
    db = app.state.lance
    background_tasks.add_task(save_permanent_memory, req.prompt, query_vector, app.state.lance)
    
    context_chunks = []
    if "vectors" in db.table_names():
        # Hybrid Search for top 20
        results = db.open_table("vectors").search(query_type="hybrid", vector_column_name="vector").text(req.prompt).vector(query_vector).limit(20).to_list()
        if results:
            # Cross-Encoder Reranking
            pairs = [[req.prompt, res["text"]] for res in results]
            scores = reranker.predict(pairs)
            
            for idx, res in enumerate(results):
                res["score"] = float(scores[idx])
            
            results = sorted(results, key=lambda x: x["score"], reverse=True)[:3]

            doc_ids = list(set([res["doc_id"] for res in results]))
            placeholders = ",".join("?" * len(doc_ids))
            cursor = app.state.sqlite.cursor()
            cursor.execute(f"SELECT id, path FROM documents WHERE id IN ({placeholders})", doc_ids)
            path_map = {row[0]: os.path.basename(row[1]) for row in cursor.fetchall()}
            for res in results:
                if res["doc_id"] == "core_memory": context_chunks.append(res['text'])
                else: context_chunks.append(f"[Source File: {path_map.get(res['doc_id'], 'Unknown')}]\n{res['text']}")
                
    assembled_context = "\n\n".join(context_chunks) if context_chunks else "No relevant memories or documents found."
    return StreamingResponse(stream_ollama(req.prompt, assembled_context, req.model, req.history), media_type="text/event-stream")

@app.delete("/documents/{doc_id}")
def delete_document(doc_id: str):
    cursor = app.state.sqlite.cursor()
    db = app.state.lance
    if "vectors" in db.table_names(): db.open_table("vectors").delete(f"doc_id = '{doc_id}'")
    cursor.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
    cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    app.state.sqlite.commit()
    return {"status": "success"}

if __name__ == "__main__": uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")