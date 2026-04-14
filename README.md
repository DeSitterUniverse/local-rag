# Cephalon

Cephalon is a local, privacy-centric AI application that functions as a persistent digital assistant. It maintains a continuous memory of past conversations and user-provided documents, allowing it to recall facts, context, and references indefinitely.

## Functionality

* Persistent Conversation Memory: All interactions are embedded and stored permanently. The AI recalls past statements and context without being limited by a traditional sliding context window.
* Document Reference Library: Users can drag and drop PDF and text files directly into the application window. The application extracts, chunks, embeds, and stores the text for retrieval.
* Native File System Integration: Users can open the source folder of any referenced document directly from the user interface or delete documents entirely from the AI's database.
* Offline Execution: All data processing, vector embedding, and language model inference happens locally on the host machine. No data is sent to external servers.
* Dynamic Model Selection: Users can switch between any locally installed Ollama models via the user interface.

## How Persistent Memory Works

The application achieves lifelong memory by treating past conversations exactly like ingested documents.

1. Input Processing: When a user sends a message, the text is embedded using the `nomic-embed-text` model.
2. Background Storage: The raw text and its resulting vector embedding are immediately stored in LanceDB under a dedicated `Cephalon_memory` namespace.
3. Retrieval: Before generating a response, the application performs a vector similarity search against the user's prompt. It retrieves the top six most relevant fragments from LanceDB. These fragments can be from previously uploaded files, past conversation turns, or a mix of both.
4. Synthesis: The retrieved fragments are injected into the system prompt. The model reads these recalled memories as current context, creating continuous, unbroken memory retrieval.

## Architecture and Technical Choices

* Frontend Framework: Tauri v2 and React. Tauri was selected to bypass browser security restrictions. This enables native drag-and-drop events and direct file system access without requiring the user to upload files to a local web server.
* Backend Framework: FastAPI (Python). Chosen for native compatibility with standard machine learning libraries (LangChain, PyPDF) and high-performance asynchronous HTTP streaming.
* Vector Database: LanceDB. Chosen because it runs entirely in-process. It does not require a separate database server (unlike Milvus or Qdrant), making it ideal for a standalone desktop application.
* Relational Database: SQLite. Used to track document metadata, chunk counts, file paths, and ingestion status. Separating metadata from vector data keeps vector searches fast and allows for relational queries, such as grouping the user interface by file type.
* LLM Engine: Ollama. Provides a standardized, reliable API for running quantized local models.
* Text Chunking: LangChain RecursiveCharacterTextSplitter. Replaced a naive word-counting approach. This ensures text is split at natural language boundaries (paragraphs and sentences). Preserving sentence integrity prevents fragmented context and significantly improves embedding accuracy.