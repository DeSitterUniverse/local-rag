import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";

type Message = { role: "user" | "assistant"; content: string };
type Document = { id: string; name: string; status: string; chunks: number; path: string };

export default function App() {
  const [backendReady, setBackendReady] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [ingestStatus, setIngestStatus] = useState<{message: string, type: 'info' | 'success' | 'error'} | null>(null);
  const [docToDelete, setDocToDelete] = useState<Document | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch("http://127.0.0.1:8765/health");
        if (res.ok) {
          setBackendReady(true);
          clearInterval(poll);
          loadModels();
          fetchDocuments();
        }
      } catch {}
    }, 500);
    return () => clearInterval(poll);
  }, []);

  // NEW: Auto-poll the database every 3 seconds to watch background tasks complete
  useEffect(() => {
    if (backendReady) {
      const interval = setInterval(fetchDocuments, 3000);
      return () => clearInterval(interval);
    }
  }, [backendReady]);

  async function loadModels() {
    try {
      const res = await fetch("http://localhost:11434/api/tags");
      const data = await res.json();
      const names = data.models.map((m: any) => m.name);
      setModels(names);
      setSelectedModel(names.includes("gemma4:e4b") ? "gemma4:e4b" : names[0] || "");
    } catch (e) {}
  }

  async function fetchDocuments() {
    try {
      const res = await fetch("http://127.0.0.1:8765/documents");
      const data = await res.json();
      setDocuments(data.documents);
    } catch (e) {}
  }

  useEffect(() => {
    const unlistenV1Promise = listen("tauri://file-drop", (event: any) => {
      if (event.payload && event.payload.length > 0) handleIngest(event.payload[0]);
    });
    const unlistenV2Promise = listen("tauri://drag-drop", (event: any) => {
      if (event.payload?.paths && event.payload.paths.length > 0) handleIngest(event.payload.paths[0]);
    });

    const preventDefault = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragenter", preventDefault);
    document.addEventListener("dragover", preventDefault);
    document.addEventListener("drop", preventDefault);

    return () => {
      unlistenV1Promise.then(unlisten => unlisten()).catch(() => {});
      unlistenV2Promise.then(unlisten => unlisten()).catch(() => {});
      document.removeEventListener("dragenter", preventDefault);
      document.removeEventListener("dragover", preventDefault);
      document.removeEventListener("drop", preventDefault);
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleIngest(path: string) {
    setIsSidebarOpen(true);
    setIngestStatus({ message: "Task queued...", type: 'info' });
    try {
      const res = await fetch("http://127.0.0.1:8765/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path }),
      });
      const data = await res.json();
      if (data.status === "success") {
        setIngestStatus({ message: data.message, type: 'success' });
        fetchDocuments(); // Trigger immediate visual update
      } else {
        setIngestStatus({ message: `Error: ${data.error}`, type: 'error' });
      }
    } catch (error) {
      setIngestStatus({ message: "Connection failed.", type: 'error' });
    }
    setTimeout(() => setIngestStatus(null), 4000);
  }

  // NEW: Trigger Native Folder Selection Dialog
  async function handleAddFolder() {
    try {
      const selectedPath = await openDialog({ directory: true, multiple: false });
      if (selectedPath && typeof selectedPath === 'string') {
        handleIngest(selectedPath);
      }
    } catch (e) {
      console.error("Failed to open dialog", e);
    }
  }

  async function handleOpenLocation(filePath: string) {
    try {
      const dirPath = filePath.substring(0, Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')));
      await openPath(dirPath);
    } catch (e) {}
  }

  async function confirmDelete() {
    if (!docToDelete) return;
    try {
      await fetch(`http://127.0.0.1:8765/documents/${docToDelete.id}`, { method: "DELETE" });
      fetchDocuments();
    } catch (e) {}
    setDocToDelete(null);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isTyping) return;
    
    const userMsg = input;
    setInput("");
    const historyPayload = messages.slice(-6);
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setIsTyping(true);
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("http://127.0.0.1:8765/query", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: userMsg, model: selectedModel, history: historyPayload }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages(prev => {
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          newMessages[lastIndex] = { ...newMessages[lastIndex], content: newMessages[lastIndex].content + chunk };
          return newMessages;
        });
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: "assistant", content: "Error connecting to AI engine." }]);
    }
    setIsTyping(false);
  }

  const filteredDocs = documents.filter(d => d.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const groupedDocs = filteredDocs.reduce((acc, doc) => {
    const extMatch = doc.name.match(/\.([^.]+)$/);
    const ext = extMatch ? extMatch[1].toUpperCase() : 'OTHER';
    if (!acc[ext]) acc[ext] = [];
    acc[ext].push(doc);
    return acc;
  }, {} as Record<string, Document[]>);

  if (!backendReady) return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>Awakening Cephalon engine...</div>;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif", position: "relative", backgroundColor: "#f9fafb" }}>
      
      {docToDelete && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ backgroundColor: "white", padding: "2rem", borderRadius: "12px", maxWidth: "400px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)" }}>
            <h3 style={{ marginTop: 0, color: '#111827' }}>Remove Reference?</h3>
            <p style={{ color: "#4b5563" }}>Are you sure you want to remove <strong>{docToDelete.name}</strong>? The AI will no longer use this file for context.</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1.5rem" }}>
              <button onClick={() => setDocToDelete(null)} style={{ padding: "0.5rem 1rem", borderRadius: "6px", border: "1px solid #d1d5db", backgroundColor: "white", cursor: "pointer", fontWeight: 500 }}>Cancel</button>
              <button onClick={confirmDelete} style={{ padding: "0.5rem 1rem", borderRadius: "6px", border: "none", backgroundColor: "#dc2626", color: "white", cursor: "pointer", fontWeight: 500 }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ width: isSidebarOpen ? "320px" : "0px", transition: "width 0.3s ease", overflow: "hidden", backgroundColor: "white", borderRight: isSidebarOpen ? "1px solid #e5e7eb" : "none", display: "flex", flexDirection: "column", boxShadow: "2px 0 8px rgba(0,0,0,0.05)", zIndex: 10 }}>
        <div style={{ padding: "1.5rem", borderBottom: "1px solid #e5e7eb", minWidth: "320px", boxSizing: "border-box" }}>
          <h2 style={{ margin: "0 0 1rem 0", fontSize: "1.1rem", color: "#374151", fontWeight: 600 }}>Reference Library</h2>
          
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input type="text" placeholder="Search files..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ flex: 1, padding: "0.5rem 0.75rem", borderRadius: "6px", border: "1px solid #d1d5db", boxSizing: "border-box", fontSize: "0.875rem", width: "100%" }} />
            <button onClick={handleAddFolder} style={{ padding: "0.5rem", backgroundColor: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: "6px", cursor: "pointer", color: "#374151", fontWeight: 500, fontSize: "0.875rem", whiteSpace: "nowrap" }} title="Import Folder">
              + Folder
            </button>
          </div>
        </div>

        <div style={{ minWidth: "320px", flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {ingestStatus && (
            <div style={{ padding: "0.75rem", margin: "1rem 1rem 0 1rem", borderRadius: "6px", fontSize: "0.875rem", backgroundColor: ingestStatus.type === 'error' ? '#fee2e2' : ingestStatus.type === 'success' ? '#dcfce3' : '#e0f2fe', color: ingestStatus.type === 'error' ? '#991b1b' : ingestStatus.type === 'success' ? '#166534' : '#075985' }}>
              {ingestStatus.message}
            </div>
          )}

          <div style={{ padding: "1rem" }}>
            {Object.keys(groupedDocs).length === 0 ? (
              <p style={{ fontSize: "0.875rem", color: "#9ca3af", textAlign: "center", marginTop: "2rem" }}>Drop files anywhere to add them to memory.</p>
            ) : (
              Object.entries(groupedDocs).map(([ext, docs]) => (
                <div key={ext} style={{ marginBottom: "1.5rem" }}>
                  <h4 style={{ fontSize: "0.75rem", color: "#6b7280", letterSpacing: "0.05em", margin: "0 0 0.5rem 0" }}>{ext} FILES</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {docs.map(doc => (
                      <div key={doc.id} style={{ backgroundColor: "#f9fafb", padding: "0.75rem", borderRadius: "8px", border: "1px solid #f3f4f6", fontSize: "0.875rem" }}>
                        <div style={{ fontWeight: 500, color: "#374151", wordBreak: "break-all", marginBottom: "0.25rem" }} title={doc.name}>
                          {doc.name}
                        </div>
                        {/* Dynamic Status Indicator */}
                        <div style={{ fontSize: "0.75rem", color: doc.status === 'ready' ? "#10b981" : doc.status === 'ingesting' ? "#f59e0b" : "#ef4444", fontWeight: 500, marginBottom: "0.5rem" }}>
                          {doc.status === 'ready' ? '✓ Ready' : doc.status === 'ingesting' ? '⏳ Processing...' : `⚠ ${doc.status}`}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{doc.chunks} chunks</span>
                          <div style={{ display: "flex", gap: "0.75rem" }}>
                            <button onClick={() => handleOpenLocation(doc.path)} style={{ background: "none", border: "none", color: "#4f46e5", cursor: "pointer", fontSize: "0.75rem", padding: 0, fontWeight: 500 }} title="Open Folder">Open</button>
                            <button onClick={() => setDocToDelete(doc)} style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: "0.75rem", padding: 0, fontWeight: 500 }} title="Delete">Remove</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        <div style={{ padding: "1rem 1.5rem", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "white", zIndex: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: "6px", padding: "0.4rem 0.6rem", cursor: "pointer", color: "#4b5563", backgroundColor: isSidebarOpen ? "#f3f4f6" : "white" }}>
              {isSidebarOpen ? "◀" : "▶"}
            </button>
            <h1 style={{ margin: 0, fontSize: "1.25rem", color: "#111827", fontWeight: 700, letterSpacing: "-0.5px" }}>Cephalon</h1>
          </div>
          
          <div style={{ position: "relative" }}>
            <button onClick={() => setIsModelMenuOpen(!isModelMenuOpen)} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 1rem", borderRadius: "9999px", border: "1px solid #e5e7eb", backgroundColor: isModelMenuOpen ? "#f3f4f6" : "white", fontSize: "0.875rem", color: "#374151", cursor: "pointer", fontWeight: 500, boxShadow: "0 1px 2px rgba(0,0,0,0.05)", transition: "all 0.2s" }}>
              <span style={{ color: "#8b5cf6" }}>✨</span> {selectedModel || "Loading engine..."} <span style={{ fontSize: "0.7rem", color: "#9ca3af", transform: isModelMenuOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▼</span>
            </button>
            {isModelMenuOpen && <div onClick={() => setIsModelMenuOpen(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 30 }} />}
            {isModelMenuOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 0.5rem)", right: 0, width: "240px", backgroundColor: "white", border: "1px solid #e5e7eb", borderRadius: "12px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)", zIndex: 40, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "0.75rem 1rem", backgroundColor: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", letterSpacing: "0.05em", textTransform: "uppercase" }}>Active Neural Engine</div>
                <div style={{ maxHeight: "300px", overflowY: "auto" }}>
                  {models.length === 0 ? <div style={{ padding: "1rem", fontSize: "0.875rem", color: "#9ca3af", textAlign: "center" }}>No models found.</div> : models.map(m => (
                    <button key={m} onClick={() => { setSelectedModel(m); setIsModelMenuOpen(false); }} style={{ width: "100%", textAlign: "left", padding: "0.875rem 1rem", backgroundColor: selectedModel === m ? "#f5f3ff" : "white", border: "none", borderBottom: "1px solid #f3f4f6", fontSize: "0.875rem", color: selectedModel === m ? "#6d28d9" : "#374151", cursor: "pointer", fontWeight: selectedModel === m ? 600 : 400, transition: "background-color 0.1s", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      {m} {selectedModel === m && <span style={{ color: "#8b5cf6" }}>✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {messages.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: "#6b7280", maxWidth: "400px" }}>
              <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🧠</div>
              <h2 style={{ marginBottom: "0.5rem", color: "#111827" }}>What's on your mind?</h2>
              <p style={{ lineHeight: "1.5" }}>I remember our past conversations. You can chat normally, or drop files and folders into this window to add them to my reference library.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "80%", padding: "1rem 1.25rem", borderRadius: "16px", borderBottomRightRadius: msg.role === "user" ? "4px" : "16px", borderBottomLeftRadius: msg.role === "assistant" ? "4px" : "16px", backgroundColor: msg.role === "user" ? "#111827" : "#f3f4f6", color: msg.role === "user" ? "white" : "#1f2937", lineHeight: "1.6", boxShadow: msg.role === "user" ? "0 4px 6px -1px rgba(0, 0, 0, 0.1)" : "none" }}>
                {msg.role === "user" ? msg.content : <div className="prose prose-sm"><ReactMarkdown>{msg.content}</ReactMarkdown></div>}
              </div>
            </div>
          ))}
          {isTyping && messages[messages.length - 1]?.role === "user" && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
               <div style={{ backgroundColor: "#f3f4f6", padding: "1rem 1.25rem", borderRadius: "16px", color: "#6b7280", fontSize: "0.875rem", fontStyle: "italic" }}>Synthesizing memories...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div style={{ padding: "1.5rem", borderTop: "1px solid #e5e7eb", backgroundColor: "white" }}>
          <form onSubmit={handleSend} style={{ display: "flex", gap: "0.75rem", maxWidth: "56rem", margin: "0 auto" }}>
            <input type="text" value={input} onChange={e => setInput(e.target.value)} placeholder="Record a thought, or ask me anything..." disabled={isTyping} style={{ flex: 1, padding: "1rem 1.25rem", borderRadius: "12px", border: "1px solid #d1d5db", fontSize: "1rem", outline: "none", boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)" }} />
            <button type="submit" disabled={isTyping || !input.trim()} style={{ padding: "0 1.5rem", borderRadius: "12px", fontWeight: 600, cursor: (isTyping || !input.trim()) ? "not-allowed" : "pointer", backgroundColor: (isTyping || !input.trim()) ? "#e5e7eb" : "#111827", color: (isTyping || !input.trim()) ? "#9ca3af" : "white", border: "none", transition: "all 0.2s" }}>Send</button>
          </form>
        </div>
      </div>
    </div>
  );
}