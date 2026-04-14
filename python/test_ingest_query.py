import httpx
import time

def run_test():
    print("Ingesting test_docs directory...")
    res = httpx.post("http://127.0.0.1:8765/ingest", json={"path": "c:/Users/Fluttershy/Desktop/Projects and Code/Cephalon/test_docs"}, timeout=10)
    print("Ingest response:", res.json())

    # Wait for ingestion to finish
    for i in range(15):
        time.sleep(2)
        docs = httpx.get("http://127.0.0.1:8765/documents").json().get("documents", [])
        if all(d.get("status") == "ready" for d in docs) and len(docs) > 0:
            print("Documents ready:", docs)
            break
        print("Waiting for ingestion...")
    else:
        print("Ingestion timed out or failed.")
        return

    print("\nQuerying: 'Tell me about the 4-7-8 method.'")
    with httpx.stream("POST", "http://127.0.0.1:8765/query", json={"prompt": "Tell me about the 4-7-8 method.", "history": [], "model": "nemotron-3-nano:4b"}, timeout=60) as r:
        for chunk in r.iter_text():
            print(chunk, end="", flush=True)

if __name__ == "__main__":
    run_test()
