# Cephalon (v1.1.0)
> **Cephalon** is a strictly private, locally-hosted intelligence platform. It merges zero-dependency OS-native windowing via Tauri v2 with the extreme out-of-core scalability of LanceDB. Feed it anything - from dense PDFs to colossal multi-sheet Excel files - and instantly retrieve explicitly cited answers with 100% data privacy.

![Version 1.1](https://img.shields.io/badge/version-1.1.0-blue) ![License MIT](https://img.shields.io/badge/license-MIT-green)

---

## Technical Architecture

Cephalon is constructed using a decoupled, dual-language pipeline designed to maximize both front-end speed and semantic parsing capabilities without compromising local memory.

### 1. Decoupled Pipeline
*   **Frontend (Tauri + React):** The user interface is driven by a lightning-fast Rust framework (Tauri) rendering React. This bypasses the heavy RAM bloat of traditional Electron applications.
*   **Backend (FastAPI + Python):** Complex document parsing (OCR, proprietary format extraction) and vector embedding mathematics are hosted natively in Python.
*   **Invisible Bridging:** In production, the backend is bundled via PyInstaller and automatically managed as a hidden Sidecar executable by Tauri OS bindings.

### 2. Dual-Database Topology
*   **LanceDB:** A serverless engine managing all Machine Learning embeddings highly efficiently on-disk, allowing processing of massive datasets without overwhelming local RAM.
*   **SQLite:** Traditional lightweight relational layer tracking file paths, ingestion state metadata, and deletion synchronization to ensure the UI interface reflects the vector state perfectly.

### 3. Pipeline Ingestion & Reranking
*   **Ingestion:** Cephalon automatically hooks into OS events, parsing `.pdf`, `.docx`, multi-sheet `.xlsx`, `.pptx`, and `.csv`. Text is mathematically embedded explicitly via `nomic-embed-text`.
*   **Cross-Encoder Reasoning:** Instead of relying solely on generic cosine rankings, the pipeline passes the top 20 retrieved candidates through the `ms-marco` neural network. This layers a manual semantic grading pass to strictly push only the most accurate context to the final Chat context window.

---

## Key Features

*   **Radical Privacy (100% Offline):** All ingestion parsing, NLP embeddings, and LLM inferences happen directly on your silicon. No cloud, no analytics, no external APIs.
*   **Sleek Multi-Thematic UI:** Fully integrated Dark and Light modes dynamically adjusting to your OS preference, packaged inside a heavily optimized, CSS-token interface.
*   **Smart Automation:** Minimal setup. Simply drag and drop folders into the window and the engine begins chunking in the background instantly.

---

## Prerequisites

Ensure you have the core LLM engine running smoothly before boot:
1.  Target memory model: `ollama run nomic-embed-text`
2.  Target dialogue model: `ollama run nemotron-3-nano:4b`

## Development Boot

Run the backend and frontend decoupled pipeline manually during development:

```bash
# Terminal 1: Python Engine
cd python
pip install -r requirements.txt
python main.py

# Terminal 2: React/Rust Bridge
npm i
npm run tauri dev
```