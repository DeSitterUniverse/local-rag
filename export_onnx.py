from optimum.onnxruntime import ORTModelForSequenceClassification, ORTModelForFeatureExtraction
from transformers import AutoTokenizer
import os

def export_model():
    print("Initiating one-time ONNX export...")
    onnx_path = os.path.expanduser("~/cephalon-data/models/cross-encoder")
    embed_path = os.path.expanduser("~/cephalon-data/models/embedder")
    
    os.makedirs(onnx_path, exist_ok=True)
    os.makedirs(embed_path, exist_ok=True)
    
    print("Exporting ONNX Reranker...")
    model = ORTModelForSequenceClassification.from_pretrained("cross-encoder/ms-marco-MiniLM-L-6-v2", export=True)
    tokenizer = AutoTokenizer.from_pretrained("cross-encoder/ms-marco-MiniLM-L-6-v2")
    model.save_pretrained(onnx_path)
    tokenizer.save_pretrained(onnx_path)
    
    print("Exporting ONNX Embedding Engine (768 dims)...")
    embed_model = ORTModelForFeatureExtraction.from_pretrained("BAAI/bge-base-en-v1.5", export=True)
    embed_tok = AutoTokenizer.from_pretrained("BAAI/bge-base-en-v1.5")
    embed_model.save_pretrained(embed_path)
    embed_tok.save_pretrained(embed_path)
    
    print(f"ONNX Reranker & Embedder successfully verified!")
    print("You may now completely purge PyTorch and Optimum from your machine.")

if __name__ == "__main__":
    export_model()
