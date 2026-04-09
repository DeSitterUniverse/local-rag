import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import lancedb
import sqlite3
import os

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

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")