import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css"; // Import dynamic CSS token system

type Message = { role: "user" | "assistant"; content: string };
type Document = { id: string; name: string; status: string; chunks: number; path: string };

function parseThinking(content: string): { thinking: string; response: string } {
  const closeTag = "</think>";
  const closeIdx = content.indexOf(closeTag);
  
  // No closing tag at all — no thinking block present
  if (closeIdx === -1) {
    // Check if there's an opening tag without a close (still streaming thinking)
    const openTag = "<think>";
    const openIdx = content.indexOf(openTag);
    if (openIdx !== -1) {
      return { thinking: content.substring(openIdx + openTag.length).trim(), response: "" };
    }
    return { thinking: "", response: content };
  }
  
  // Found </think> — extract thinking and response
  const openTag = "<think>";
  const openIdx = content.indexOf(openTag);
  
  // If opening tag exists, use content between open and close
  // If no opening tag (common with some GGUF templates), everything before </think> is thinking
  const thinkStart = openIdx !== -1 ? openIdx + openTag.length : 0;
  const thinking = content.substring(thinkStart, closeIdx).trim();
  const response = content.substring(closeIdx + closeTag.length).trim();
  
  return { thinking, response };
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div>
      <button className="thinking-toggle" onClick={() => setIsOpen(!isOpen)}>
        <span className={`chevron ${isOpen ? 'open' : ''}`}>▶</span>
        {isOpen ? "Hide reasoning" : "View reasoning"}
      </button>
      <div className={`thinking-content ${isOpen ? 'visible' : ''}`}>
        <div className="thinking-content-inner">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{thinking}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  /** 
   * CRITICAL STATE 
   * bootStatus tracks the FastAPI lifecycle.
   * models/selectedModel tracks locally installed .gguf models.
   */
  const [bootStatus, setBootStatus] = useState<'waking' | 'ready'>('waking');
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  /**
   * UI STATE
   */
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [ingestStatus, setIngestStatus] = useState<{message: string, type: 'info' | 'success' | 'error'} | null>(null);
  const [docToDelete, setDocToDelete] = useState<Document | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /**
   * THEME HOOK
   * Automatically detects user's OS preference on first boot, then strictly defaults to localStorage.
   */
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved) return saved as 'light' | 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  /**
   * BACKEND BOOT POLLING
   * React inherently boots faster than PyInstaller Sidecars. We pause rendering until Python is ready.
   */
  useEffect(() => {
    let active = true;
    const poll = async () => {
      while (active) {
        try {
          const res = await fetch("http://127.0.0.1:8765/health");
          if (res.ok) {
            await loadModels();
            break;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
    };
    poll();
    return () => { active = false; };
  }, []);

  /**
   * BACKGROUND SYNC MULTIPLEXER
   * Polls the SQLite metadata periodically to cleanly update UI states for massive document ingestion limits.
   */
  useEffect(() => {
    if (bootStatus === 'ready') {
      const interval = setInterval(fetchDocuments, 3000);
      return () => clearInterval(interval);
    }
  }, [bootStatus]);

  async function loadModels() {
    try {
      const res = await fetch("http://127.0.0.1:8765/models");
      if (res.ok) {
        const data = await res.json();
        const names = data.models;
        setModels(names);
        
        if (names.length > 0) {
          setSelectedModel(names[0]);
        }
      }
    } catch (e) {
      console.warn("Engine proxy not fully reachable. Bypassing lock:", e);
    } finally {
      fetchDocuments();
      setBootStatus("ready");
    }
  }

  async function fetchDocuments() {
    try {
      const res = await fetch("http://127.0.0.1:8765/documents");
      const data = await res.json();
      setDocuments(data.documents);
    } catch (e) {}
  }

  /**
   * TAURI OS INTEGRATION
   * Directly hooks into Desktop OS native Drag-and-Drop parameters for instant file queueing.
   */
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
        fetchDocuments(); 
      } else {
        setIngestStatus({ message: `Error: ${data.error}`, type: 'error' });
      }
    } catch (error) {
      setIngestStatus({ message: "Connection failed.", type: 'error' });
    }
    setTimeout(() => setIngestStatus(null), 4000);
  }

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
      await revealItemInDir(filePath);
    } catch (e) {
      console.error("Failed to open directory:", e);
    }
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

  /**
   * RENDER: BOOT SCREEN
   */
  if (bootStatus !== 'ready') {
    return (
      <div className="container" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🧠</div>
          <h2>Waking Cephalon Core...</h2>
          <p>This might take a moment while the engine decompresses.</p>
        </div>
      </div>
    );
  }

  /**
   * RENDER: MAIN APPLICATION
   */
  return (
    <div className="container" style={{ paddingTop: 0 }}>
      {/* Delete Confirmation Modal */}
      {docToDelete && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ backgroundColor: "var(--panel-bg)", padding: "2rem", borderRadius: "12px", maxWidth: "400px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.2)", border: "1px solid var(--border-color)" }}>
            <h3 style={{ marginTop: 0, color: 'var(--text-main)' }}>Remove Reference?</h3>
            <p style={{ color: "var(--text-muted)" }}>Are you sure you want to remove <strong>{docToDelete.name}</strong>? The AI will no longer use this file for context.</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1.5rem" }}>
              <button onClick={() => setDocToDelete(null)} style={{ padding: "0.5rem 1rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--panel-bg)", color: "var(--text-main)", cursor: "pointer", fontWeight: 500 }}>Cancel</button>
              <button onClick={confirmDelete} style={{ padding: "0.5rem 1rem", borderRadius: "6px", border: "none", backgroundColor: "var(--error-text)", color: "white", cursor: "pointer", fontWeight: 500 }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar UI */}
      <div style={{ width: isSidebarOpen ? "320px" : "0px", transition: "width 0.3s ease", overflow: "hidden", backgroundColor: "var(--sidebar-bg)", borderRight: isSidebarOpen ? "1px solid var(--border-color)" : "none", display: "flex", flexDirection: "column", zIndex: 10 }}>
        <div style={{ padding: "1.5rem", borderBottom: "1px solid var(--border-color)", minWidth: "320px", boxSizing: "border-box" }}>
          <h2 style={{ margin: "0 0 1rem 0", fontSize: "1.1rem", color: "var(--text-main)", fontWeight: 600 }}>Reference Library</h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input type="text" placeholder="Search files..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ flex: 1, padding: "0.5rem 0.75rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--input-bg)", color: "var(--text-main)", boxSizing: "border-box", fontSize: "0.875rem", width: "100%" }} />
            <button onClick={handleAddFolder} style={{ padding: "0.5rem", backgroundColor: "var(--panel-bg)", border: "1px solid var(--border-color)", borderRadius: "6px", cursor: "pointer", color: "var(--text-main)", fontWeight: 500, fontSize: "0.875rem", whiteSpace: "nowrap" }} title="Import Folder">
              + Folder
            </button>
          </div>
        </div>

        <div style={{ minWidth: "320px", flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {ingestStatus && (
            <div style={{ padding: "0.75rem", margin: "1rem 1rem 0 1rem", borderRadius: "6px", fontSize: "0.875rem", backgroundColor: `var(--${ingestStatus.type}-bg)`, color: `var(--${ingestStatus.type}-text)` }}>
              {ingestStatus.message}
            </div>
          )}

          <div style={{ padding: "1rem" }}>
            {Object.keys(groupedDocs).length === 0 ? (
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", textAlign: "center", marginTop: "2rem" }}>Drop files anywhere to add them to memory.</p>
            ) : (
              Object.entries(groupedDocs).map(([ext, docs]) => (
                <div key={ext} style={{ marginBottom: "1.5rem" }}>
                  <h4 style={{ fontSize: "0.75rem", color: "var(--text-muted)", letterSpacing: "0.05em", margin: "0 0 0.5rem 0" }}>{ext} FILES</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {docs.map(doc => (
                      <div key={doc.id} style={{ backgroundColor: "var(--panel-bg)", padding: "0.75rem", borderRadius: "8px", border: "1px solid var(--border-color)", fontSize: "0.875rem" }}>
                        <div style={{ fontWeight: 500, color: "var(--text-main)", wordBreak: "break-all", marginBottom: "0.25rem" }} title={doc.name}>
                          {doc.name}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: doc.status === 'ready' ? "var(--success-text)" : doc.status === 'ingesting' ? "#f59e0b" : "var(--error-text)", fontWeight: 500, marginBottom: "0.5rem" }}>
                          {doc.status === 'ready' ? '✓ Ready' : doc.status === 'ingesting' ? '⏳ Processing...' : `⚠ ${doc.status}`}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>{doc.chunks} chunks</span>
                          <div style={{ display: "flex", gap: "0.75rem" }}>
                            <button onClick={() => handleOpenLocation(doc.path)} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "0.75rem", padding: 0, fontWeight: 500 }}>Open</button>
                            <button onClick={() => setDocToDelete(doc)} style={{ background: "none", border: "none", color: "var(--error-text)", cursor: "pointer", fontSize: "0.75rem", padding: 0, fontWeight: 500 }}>Remove</button>
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

      {/* Main Chat Area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", backgroundColor: "var(--app-bg)" }}>
        
        {/* Header Menu */}
        <div style={{ padding: "1rem 1.5rem", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "var(--panel-bg)", zIndex: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} style={{ background: "none", border: "1px solid var(--border-color)", borderRadius: "6px", padding: "0.4rem 0.6rem", cursor: "pointer", color: "var(--text-muted)", backgroundColor: isSidebarOpen ? "var(--input-bg)" : "var(--panel-bg)" }}>
              {isSidebarOpen ? "◀" : "▶"}
            </button>
            <h1 style={{ margin: 0, fontSize: "1.25rem", color: "var(--text-main)", fontWeight: 700, letterSpacing: "-0.5px" }}>Cephalon</h1>
          </div>
          
          <div style={{ display: "flex", gap: "0.8rem", alignItems: "center" }}>
            {/* Theme Toggle Button */}
            <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} style={{ background: "none", border: "1px solid var(--border-color)", borderRadius: "6px", padding: "0.4rem 0.6rem", cursor: "pointer", color: "var(--text-muted)", backgroundColor: "var(--panel-bg)", transition: "all 0.2s" }} title="Toggle Theme">
              {theme === 'light' ? "🌙" : "☀️"}
            </button>

            <div style={{ position: "relative" }}>
              <button onClick={() => setIsModelMenuOpen(!isModelMenuOpen)} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 1rem", borderRadius: "9999px", border: "1px solid var(--border-color)", backgroundColor: isModelMenuOpen ? "var(--input-bg)" : "var(--panel-bg)", fontSize: "0.875rem", color: "var(--text-main)", cursor: "pointer", fontWeight: 500, boxShadow: "0 1px 2px rgba(0,0,0,0.05)", transition: "all 0.2s" }}>
                <span style={{ color: "var(--accent)" }}>✨</span> {selectedModel || "Loading engine..."} <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", transform: isModelMenuOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▼</span>
              </button>
              {isModelMenuOpen && <div onClick={() => setIsModelMenuOpen(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 30 }} />}
              {isModelMenuOpen && (
                <div style={{ position: "absolute", top: "calc(100% + 0.5rem)", right: 0, width: "240px", backgroundColor: "var(--dropdown-bg)", border: "1px solid var(--border-color)", borderRadius: "12px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.2)", zIndex: 40, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <div style={{ padding: "0.75rem 1rem", backgroundColor: "var(--panel-bg)", borderBottom: "1px solid var(--border-color)", fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase" }}>Active Neural Engine</div>
                  <div style={{ maxHeight: "300px", overflowY: "auto" }}>
                    {models.length === 0 ? <div style={{ padding: "1rem", fontSize: "0.875rem", color: "var(--text-muted)", textAlign: "center" }}>No models found.</div> : models.map(m => (
                      <button key={m} onClick={() => { setSelectedModel(m); setIsModelMenuOpen(false); }} style={{ width: "100%", textAlign: "left", padding: "0.875rem 1rem", backgroundColor: selectedModel === m ? "var(--accent-light)" : "var(--dropdown-bg)", border: "none", borderBottom: "1px solid var(--border-color)", fontSize: "0.875rem", color: selectedModel === m ? "var(--accent)" : "var(--text-main)", cursor: "pointer", fontWeight: selectedModel === m ? 600 : 400, transition: "background-color 0.1s", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        {m} {selectedModel === m && <span style={{ color: "var(--accent)" }}>✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Message Feed */}
        <div style={{ flex: 1, overflowY: "auto", padding: "2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {messages.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--text-muted)", maxWidth: "400px" }}>
              <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🧠</div>
              <h2 style={{ marginBottom: "0.5rem", color: "var(--text-main)" }}>What's on your mind?</h2>
              <p style={{ lineHeight: "1.5" }}>I remember our past conversations. You can chat normally, or drop files and folders into this window to add them to my reference library.</p>
            </div>
          )}
          {messages.map((msg, i) => {
            const { thinking, response } = msg.role === "assistant" ? parseThinking(msg.content) : { thinking: "", response: msg.content };
            const hasThinking = thinking.length > 0;
            const isStreaming = isTyping && i === messages.length - 1;
            
            // During streaming: if no </think> found yet, the model may still be in its thinking phase.
            // Detect this by checking if the raw content lacks </think> but we're still receiving tokens.
            const isStillThinking = isStreaming && msg.role === "assistant" && !msg.content.includes("</think>") && !hasThinking;
            
            const displayContent = msg.role === "assistant" 
              ? (hasThinking ? response : (isStillThinking ? "" : msg.content))
              : msg.content;

            return (
            <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "80%", padding: "1rem 1.25rem", borderRadius: "16px", borderBottomRightRadius: msg.role === "user" ? "4px" : "16px", borderBottomLeftRadius: msg.role === "assistant" ? "4px" : "16px", backgroundColor: msg.role === "user" ? "var(--user-msg-bg)" : "var(--bot-msg-bg)", color: msg.role === "user" ? "var(--user-msg-text)" : "var(--text-main)", lineHeight: "1.6", boxShadow: msg.role === "user" ? "0 4px 6px -1px rgba(0, 0, 0, 0.1)" : "none" }}>
                {msg.role === "user" ? (
                  msg.content
                ) : (
                  <div className="markdown-body" style={{ fontSize: "0.875rem", width: "100%", overflowX: "auto" }}>
                    {hasThinking && !isStreaming && <ThinkingBlock thinking={thinking} />}
                    {(isStillThinking || (hasThinking && isStreaming && !response)) && (
                      <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontStyle: "italic", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span style={{ display: "inline-block", animation: "pulse 1.5s ease-in-out infinite" }}>🧠</span> Reasoning...
                      </div>
                    )}
                    {displayContent && <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>}
                  </div>
                )}
              </div>
            </div>
          );})}
          {isTyping && messages[messages.length - 1]?.role === "user" && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
               <div style={{ backgroundColor: "var(--bot-msg-bg)", padding: "1rem 1.25rem", borderRadius: "16px", color: "var(--text-muted)", fontSize: "0.875rem", fontStyle: "italic" }}>Synthesizing memories...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Form */}
        <div style={{ padding: "1.5rem", borderTop: "1px solid var(--border-color)", backgroundColor: "var(--panel-bg)", zIndex: 10 }}>
          <form onSubmit={handleSend} style={{ display: "flex", gap: "0.75rem", maxWidth: "56rem", margin: "0 auto" }}>
            <input type="text" value={input} onChange={e => setInput(e.target.value)} placeholder="Record a thought, or ask me anything..." disabled={isTyping} style={{ flex: 1, padding: "1rem 1.25rem", borderRadius: "12px", border: "1px solid var(--border-color)", fontSize: "1rem", backgroundColor: "var(--input-bg)", color: "var(--text-main)", outline: "none", boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)" }} />
            <button type="submit" disabled={isTyping || !input.trim()} style={{ padding: "0 1.5rem", borderRadius: "12px", fontWeight: 600, cursor: (isTyping || !input.trim()) ? "not-allowed" : "pointer", backgroundColor: (isTyping || !input.trim()) ? "var(--border-color)" : "var(--accent)", color: (isTyping || !input.trim()) ? "var(--text-muted)" : "white", border: "none", transition: "all 0.2s" }}>Send</button>
          </form>
        </div>

      </div>
    </div>
  );
}