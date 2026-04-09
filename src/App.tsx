import { useEffect, useState } from "react";

export default function App() {
  const [backendReady, setBackendReady] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    // Poll until Python sidecar is up (takes ~2s on first launch)
    const poll = setInterval(async () => {
      try {
        const res = await fetch("http://127.0.0.1:8765/health");
        if (res.ok) {
          setBackendReady(true);
          clearInterval(poll);
          loadModels();
        }
      } catch {}
    }, 500);
    return () => clearInterval(poll);
  }, []);

  async function loadModels() {
    const res = await fetch("http://localhost:11434/api/tags");
    const data = await res.json();
    const names = data.models.map((m: any) => m.name);
    setModels(names);
    setSelectedModel(names[0] ?? "");
  }

  if (!backendReady) return <div className="loading">Starting local AI engine...</div>;

  return (
    <div className="app">
      <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
        {models.map(m => <option key={m}>{m}</option>)}
      </select>
      <p>Backend ready. Models loaded: {models.length}</p>
    </div>
  );
}