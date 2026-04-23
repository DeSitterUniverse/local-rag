# Cephalon (v1.3.0)
> **Cephalon** is a fully self-contained, locally-hosted intelligence platform. It merges zero-dependency OS-native windowing via Tauri v2 with the extreme out-of-core scalability of LanceDB. Feed it anything - from dense PDFs to colossal multi-sheet Excel files - and instantly retrieve explicitly cited answers. No cloud. No telemetry. No external services.

![Version 1.3](https://img.shields.io/badge/version-1.3.0-blue) ![License MIT](https://img.shields.io/badge/license-MIT-green)

---

## Technical Architecture

Cephalon is constructed using a decoupled, dual-language pipeline designed to maximize both front-end speed and semantic parsing capabilities without compromising local memory.

### 1. Decoupled Pipeline
*   **Frontend (Tauri + React):** The user interface is driven by a Rust framework (Tauri) rendering React. A lot lower ram usage compared to Electron apps.
*   **Backend (FastAPI + Python):** Complex document parsing (OCR, proprietary format extraction) and vector embedding mathematics are hosted natively in Python.
*   **Invisible Bridging:** In production, the backend is bundled via PyInstaller and automatically managed as a hidden Sidecar executable by Tauri OS bindings.

### 2. Dual-Database Topology
*   **LanceDB:** A serverless engine managing all Machine Learning embeddings highly efficiently on-disk, allowing processing of massive datasets without overwhelming local RAM.
*   **SQLite:** Traditional lightweight relational layer tracking file paths, ingestion state metadata, and deletion synchronization to ensure the UI interface reflects the vector state perfectly.

### 3. Inference Engine (llama-cpp-python)
*   **Dynamic GGUF Loading:** Cephalon scans `~/cephalon-data/models` for `.gguf` model files and presents them in a frontend dropdown for hot-swapping. Models are loaded into VRAM on-demand with automatic deallocation on switch.
*   **GPU Acceleration:** Full GPU offloading via `n_gpu_layers=-1` with Vulkan backend support for AMD/NVIDIA hardware.
*   **No External Daemons:** Unlike previous versions that relied on Ollama, generation now runs directly inside the FastAPI process. No background services needed.

### 4. Retrieval & Reranking Pipeline
*   **Embedding:** Text is embedded locally using a pure ONNX Runtime inference session running `BAAI/bge-base-en-v1.5` (768 dimensions). Zero PyTorch dependency.
*   **Cross-Encoder Reranking:** The top 20 hybrid search candidates are reranked through `ms-marco-MiniLM-L-6-v2` running natively on ONNX Runtime. Only the top 3 most semantically relevant chunks are passed to the LLM context window.

### 5. Thinking/Reasoning UI
*   Models that emit `<think>` tags have their chain-of-thought reasoning automatically hidden behind a collapsible toggle in the chat UI. Users can expand the reasoning on demand without cluttering the visible response.

---

## Key Features

*   **100% Offline & Self-Contained:** All ingestion, embeddings, reranking, and text generation happen directly on your silicon. No cloud, no analytics, no external APIs, no background daemons.
*   **Sleek Multi-Thematic UI:** Fully integrated Dark and Light modes dynamically adjusting to your OS preference, packaged inside a heavily optimized, CSS-token interface.
*   **Smart Automation:** Minimal setup. Simply drag and drop folders into the window and the engine begins chunking in the background instantly.

---

## Prerequisites

1.  **ONNX Models:** Run the one-time export script to cache the reranker and embedding engines locally:
    ```bash
    pip install optimum[onnxruntime] torch
    python export_onnx.py
    pip uninstall -y optimum torch
    ```
2.  **LLM Models:** Place any `.gguf` model file into `~/cephalon-data/models/`. The UI will automatically detect and list them.

## Development Boot

Run the backend and frontend decoupled pipeline manually during development:

```bash
# Terminal 1: Python Engine
pip install -r requirements.txt
python python/main.py

# Terminal 2: React/Rust Bridge
npm i
npm run tauri dev
```
