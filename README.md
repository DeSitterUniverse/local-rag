# LocalRAG: Offline-First Document Intelligence

A 100% local, privacy-first Retrieval-Augmented Generation (RAG) desktop application. Chat with your PDFs, code files, and notes with zero data leaving your machine and zero API costs. 

Built with **Tauri**, **React**, and **Python**, powered by local LLMs via **Ollama**.

---

## Key Features

* **100% Local & Private:** No OpenAI, no Cloud, no API keys. Your documents stay on your hard drive.
* **Hybrid Search Engine:** Combines Vector Search (LanceDB) with Keyword Search (BM25) and Cross-Encoder Reranking for production-grade retrieval accuracy.
* **Auto-Syncing "Magic" Folder:** Drop a file into your designated library folder. The app automatically detects, parses, chunks, and vectorizes it in the background using OS-level file watching (inode tracking).
* **Hot-Swappable Models:** Seamlessly switch between local models on the fly via the UI.
* **Robust State Management:** Idempotent ingestion pipeline with SQLite metadata tracking ensures deleted or moved files don't create "ghost" data in your chat context.

---

## Architecture Stack

* **Desktop Shell:** [Tauri](https://tauri.app/) (Rust)
* **Frontend UI:** React, TypeScript, Vite
* **AI Orchestration:** [Ollama](https://ollama.com/)
* **Backend API & Processing:** Python, FastAPI, LlamaIndex
* **Vector Database:** [LanceDB](https://lancedb.com/) (Embedded, runs on disk)
* **Metadata Database:** SQLite
* **Search & Reranking:** `rank_bm25`, `sentence-transformers`

---

## Getting Started

### Prerequisites

You must have the following installed on your system:
1. **[Node.js](https://nodejs.org/)** (v18+)
2. **[Rust](https://rustup.rs/)** (Required for Tauri)
3. **[Python](https://www.python.org/)** (3.10+)
4. **[Ollama](https://ollama.com/)**

### 1. Download Local AI Models
Open a terminal and pull the models required for chatting and embedding:
```bash
ollama pull nemotron-3-nano:4b
ollama pull nomic-embed-text
