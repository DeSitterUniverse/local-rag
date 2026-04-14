import httpx

def run_test():
    print("\nQuerying: 'Tell me about the 4-7-8 method.'")
    with httpx.stream("POST", "http://127.0.0.1:8765/query", json={"prompt": "Tell me about the 4-7-8 method.", "history": [], "model": "nemotron-3-nano:4b"}, timeout=60) as r:
        for chunk in r.iter_text():
            print(chunk, end="", flush=True)

if __name__ == "__main__":
    run_test()
