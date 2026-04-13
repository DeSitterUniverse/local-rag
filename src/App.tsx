import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";

type Message = { role: "user" | "assistant"; content: string };
// New: Added 'path' to the type
type Document = { id: string; name: string; status: string; chunks: number; path: string };

export default function App() {
  const [backendReady, setBackendReady] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [ingestStatus, setIngestStatus] = useState<{message: string, type: 'info' | 'success' | 'error'} | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ... (Keep your existing useEffects and loadModels/fetchDocuments/handleIngest functions) ...
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

  async function loadModels() {
    try {
      const res = await fetch("http://localhost:11434/api/tags");
      const data = await res.json();
      const names = data.models.map((m: any) => m.name);
      setModels(names);
      setSelectedModel(names.includes("gemma4:e4b") ? "gemma4:e4b" : names[0] || "");
    } catch (e) {
      console.error("Failed to load models");
    }
  }

  async function fetchDocuments() {
    try {
      const res = await fetch("http://127.0.0.1:8765/documents");
      const data = await res.json();
      setDocuments(data.documents);
    } catch (e) {
      console.error("Failed to fetch documents");
    }
  }

  useEffect(() => {
    const unlisten = listen("tauri://file-drop", async (event) => {
      const paths = event.payload as string[];
      if (paths.length > 0) handleIngest(paths[0]);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleIngest(filePath: string) {
    setIngestStatus({ message: "Processing document...", type: 'info' });
    try {
      const res = await fetch("http://127.0.0.1:8765/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json();
      if (data.status === "success") {
        setIngestStatus({ message: `Success! Added ${data.chunks_processed} chunks.`, type: 'success' });
        fetchDocuments();
      } else {
        setIngestStatus({ message: `Error: ${data.error}`, type: 'error' });
      }
    } catch (error) {
      setIngestStatus({ message: "Failed to connect to backend.", type: 'error' });
    }
    setTimeout(() => setIngestStatus(null), 3000);
  }

  // --- NEW: Delete functionality ---
  async function handleDelete(docId: string) {
    if (!confirm("Are you sure you want to remove this document from the AI's memory?")) return;
    try {
      await fetch(`http://127.0.0.1:8765/documents/${docId}`, { method: "DELETE" });
      fetchDocuments();
    } catch (e) {
      alert("Failed to delete document.");
    }
  }

  // --- NEW: Open Folder functionality ---
  async function handleOpenLocation(filePath: string) {
    const isWindows = filePath.includes('\\');
    const separator = isWindows ? '\\' : '/';
    const dirPath = filePath.substring(0, filePath.lastIndexOf(separator));
    
    try {
      // Use the new v2 command
      await openPath(dirPath);
    } catch (e) {
      console.error("Failed to open location:", e);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMsg = input;
    setInput("");
    
    // Create a snapshot of the current messages to send as history
    // We slice the last 6 to prevent the context window from exploding
    const historyPayload = messages.slice(-6);
    
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setIsTyping(true);
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("http://127.0.0.1:8765/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // NEW: Sending the history in the payload
        body: JSON.stringify({ prompt: userMsg, model: selectedModel, history: historyPayload }),
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
      setMessages(prev => [...prev, { role: "assistant", content: "Error connecting to AI." }]);
    }
    setIsTyping(false);
  }

  if (!backendReady) return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>Starting local AI engine...</div>;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      
      {/* SIDEBAR */}
      <div style={{ width: "320px", backgroundColor: "#f3f4f6", borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "1rem", borderBottom: "1px solid #e5e7eb" }}>
          <h2 style={{ margin: 0, fontSize: "1.25rem", color: "#111827" }}>LocalRAG</h2>
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} style={{ width: "100%", marginTop: "0.75rem", padding: "0.5rem", borderRadius: "0.375rem", border: "1px solid #d1d5db" }}>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        {ingestStatus && (
          <div style={{ padding: "0.75rem", margin: "1rem 1rem 0 1rem", borderRadius: "0.375rem", fontSize: "0.875rem", backgroundColor: ingestStatus.type === 'error' ? '#fee2e2' : ingestStatus.type === 'success' ? '#dcfce3' : '#e0f2fe', color: ingestStatus.type === 'error' ? '#991b1b' : ingestStatus.type === 'success' ? '#166534' : '#075985' }}>
            {ingestStatus.message}
          </div>
        )}

        <div style={{ padding: "1rem", flex: 1, overflowY: "auto" }}>
          <h3 style={{ fontSize: "0.875rem", textTransform: "uppercase", color: "#6b7280", letterSpacing: "0.05em", marginBottom: "0.5rem" }}>Library</h3>
          {documents.length === 0 ? (
            <p style={{ fontSize: "0.875rem", color: "#9ca3af" }}>No documents yet. Drag & drop a file here.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {documents.map(doc => (
                <li key={doc.id} style={{ backgroundColor: "white", padding: "0.75rem", borderRadius: "0.375rem", border: "1px solid #e5e7eb", fontSize: "0.875rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <div style={{ fontWeight: 500, color: "#374151", wordBreak: "break-all" }} title={doc.name}>
                    📄 {doc.name}
                  </div>
                  
                  {/* NEW: Action Buttons */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{doc.chunks} chunks</span>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button onClick={() => handleOpenLocation(doc.path)} style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontSize: "0.75rem", padding: 0 }} title="Open Folder">
                        📁 Open
                      </button>
                      <button onClick={() => handleDelete(doc.id)} style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: "0.75rem", padding: 0 }} title="Delete">
                        🗑️ Delete
                      </button>
                    </div>
                  </div>

                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* CHAT INTERFACE (Unchanged mostly) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", backgroundColor: "white" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: "2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {messages.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: "#6b7280" }}>
              <h2 style={{ marginBottom: "0.5rem" }}>How can I help you?</h2>
              <p>Ask about your documents, or just have a normal chat.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "75%", padding: "1rem", borderRadius: "0.5rem", backgroundColor: msg.role === "user" ? "#2563eb" : "#f3f4f6", color: msg.role === "user" ? "white" : "#1f2937", border: msg.role === "assistant" ? "1px solid #e5e7eb" : "none", lineHeight: "1.5" }}>
                {msg.role === "user" ? msg.content : <ReactMarkdown>{msg.content}</ReactMarkdown>}
              </div>
            </div>
          ))}
          {isTyping && messages[messages.length - 1]?.role === "user" && <div style={{ color: "#6b7280", fontSize: "0.875rem", fontStyle: "italic" }}>AI is thinking...</div>}
          <div ref={messagesEndRef} />
        </div>

        <div style={{ padding: "1.5rem", borderTop: "1px solid #e5e7eb", backgroundColor: "white" }}>
          <form onSubmit={handleSend} style={{ display: "flex", gap: "1rem", maxWidth: "48rem", margin: "0 auto" }}>
            <input type="text" value={input} onChange={e => setInput(e.target.value)} placeholder="Ask anything..." disabled={isTyping} style={{ flex: 1, padding: "0.75rem 1rem", borderRadius: "0.5rem", border: "1px solid #d1d5db", fontSize: "1rem", outline: "none" }} />
            <button type="submit" disabled={isTyping || !input.trim()} style={{ padding: "0.75rem 1.5rem", borderRadius: "0.5rem", fontWeight: 500, cursor: (isTyping || !input.trim()) ? "not-allowed" : "pointer", backgroundColor: (isTyping || !input.trim()) ? "#9ca3af" : "#2563eb", color: "white", border: "none" }}>Send</button>
          </form>
        </div>
      </div>
      
    </div>
  );
}