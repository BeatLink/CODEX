"""Turn text into vectors with a small embedding model run on the CPU, so stored knowledge is found by meaning."""

import math
import struct
import threading
from pathlib import Path
from typing import Any

# Qwen3 embedding models expect a task instruction before a query, and nothing before a document.
QUERY_INSTRUCTION = "Instruct: Given a question, retrieve stored facts and topics that help answer it\nQuery:"

# Facts and topic summaries are short, so a small window keeps the model's memory use low.
EMBEDDING_CONTEXT_SIZE = 2048

# Characters kept from one text, well inside the window.
MAX_TEXT_CHARS = 4000

# Query vectors kept, since one request looks up the same words for several of its tasks.
QUERY_CACHE_SIZE = 64


class Embedder:
    """One embedding model, loaded on first use and used by one caller at a time."""

    def __init__(self, model_path: str) -> None:
        self.model_path = model_path
        self.name = Path(model_path).resolve().name
        self._model: Any = None
        self._lock = threading.Lock()
        self._query_cache: dict[str, list[float]] = {}

    def _load(self) -> Any:
        if self._model is None:
            from llama_cpp import Llama

            # The GPU is left to the chat model; embedding a few short texts is quick on the CPU.
            self._model = Llama(
                model_path=self.model_path,
                embedding=True,
                n_gpu_layers=0,
                offload_kqv=False,
                n_ctx=EMBEDDING_CONTEXT_SIZE,
                verbose=False,
            )
        return self._model

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        with self._lock:
            vectors = self._load().embed([text[:MAX_TEXT_CHARS] for text in texts])
        return [normalize(vector) for vector in vectors]

    def embed_query(self, text: str) -> list[float]:
        text = text[:MAX_TEXT_CHARS]
        with self._lock:
            if text not in self._query_cache:
                if len(self._query_cache) >= QUERY_CACHE_SIZE:
                    self._query_cache.pop(next(iter(self._query_cache)))
                self._query_cache[text] = normalize(self._load().embed(QUERY_INSTRUCTION + text))
            return self._query_cache[text]


_embedders: dict[str, Embedder] = {}
_embedders_lock = threading.Lock()


def get_embedder(model_path: str) -> Embedder | None:
    """Return the shared embedder for a model file, or None when no file is configured or it is missing."""
    if not model_path or not Path(model_path).expanduser().is_file():
        return None
    path = str(Path(model_path).expanduser().resolve())
    with _embedders_lock:
        if path not in _embedders:
            _embedders[path] = Embedder(path)
        return _embedders[path]


def normalize(vector: list[float]) -> list[float]:
    length = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / length for value in vector]


def pack(vector: list[float]) -> bytes:
    """Store a vector as the little-endian float32 blob sqlite-vec reads."""
    return struct.pack(f"<{len(vector)}f", *vector)
