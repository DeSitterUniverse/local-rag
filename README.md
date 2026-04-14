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

1. Input Processing: When a user sends a message, the text is passed to the backend for embedding.
2. Background Storage: The raw text and its resulting vector embedding are immediately stored in the database under a dedicated memory namespace.
3. Hybrid Retrieval: Before generating a response, the application runs a hybrid search combining vector similarity and keyword matching against the user's prompt. It draws a wide net of potential matches.
4. Re-ranking: The retrieved fragments are scored by a specialized cross-encoder model to determine exact contextual relevance, filtering out weak matches.
5. Synthesis: The final refined fragments are injected into the system prompt. The model reads these recalled memories as current context, creating continuous memory retrieval.

## System Design and Architecture

Cephalon uses a decoupled architecture to separate the user interface from the heavy data processing pipeline. This ensures the frontend remains responsive while the backend handles document embedding and machine learning tasks asynchronously.

### Frontend
* Tauri v2 and React: Tauri was selected to bypass browser sandboxing restrictions. This allows for native drag-and-drop events and direct file system access, avoiding the need for a local web server to handle file uploads. React handles the complex UI state management for the chat interface and the memory library.

### Backend
* FastAPI (Python): Chosen for native compatibility with standard machine learning libraries like LangChain and for its high performance asynchronous HTTP streaming capabilities. It acts as the orchestrator for all data ingestion and queries.
* Document Parsing: The backend uses specialized libraries like PyPDF, python-docx, and openpyxl to extract raw text accurately across different file formats.

### Database Layer
The data storage is split across two localized systems to maximize efficiency.
* Relational Metadata (SQLite): Used to track document metadata, chunk counts, file paths, and ingestion status. Separating metadata from vector data keeps vector searches incredibly fast and allows for immediate relational queries, such as grouping the user interface by file type without querying the vector index.
* Document Chunks and Vectors (LanceDB): Chosen because it runs entirely in process. It does not require a separate database server unlike Milvus or Qdrant, making it ideal for a standalone desktop application. It defines an explicit PyArrow schema to typecast vectors and text chunks, enabling advanced indexing.

### Semantic Search Pipeline
Retrieving the right information accurately is the hardest part of local AI. Cephalon solves this using a multi stage pipeline.
* Text Chunking: Uses the LangChain RecursiveCharacterTextSplitter. This replaces a naive word counting approach. It ensures text is split at natural language boundaries like paragraphs and sentences. Preserving sentence integrity prevents fragmented context and improves embedding accuracy.
* Embeddings: Text chunks are converted into mathematical arrays using the `nomic-embed-text` model via Ollama.
* Hybrid Search (BM25 and Vectors): Pure vector search struggles with finding exact names or rigid keywords. LanceDB builds a Full Text Search index across all ingested text. The search query is run through both a mathematical vector similarity comparison and a keyword BM25 search simultaneously. 
* Cross Encoder Re-ranking: Traditional vector and keyword searches are fast but lack deep comprehension of the query. Cephalon takes the top 20 results from the hybrid search and runs them through a `sentence-transformers` Cross Encoder model (`ms-marco-MiniLM-L-6-v2`). This model strictly scores the relationship between the user prompt and each chunk. The results are sorted, and only the absolute top three chunks are passed to the AI to prevent context window dilution.

### LLM Inference
* Ollama: Provides a standardized and highly reliable API for running quantized local models. The application interfaces with it for both generating embeddings and streaming the final text responses to the user.