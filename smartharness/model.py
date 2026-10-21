"""Load the local model and make one call to it."""

from collections.abc import Callable
from typing import Any
import weakref

from .gpu_lock import GPU_LOCK
from .settings import MAX_TOKENS, TEMPERATURE


def create_model(
    model_path: str,
    context_size: int,
    gpu_layers: int,
    on_wait: Callable[[str], None] | None = None,
) -> Any:
    """Load the local GGUF model only when inference is requested.

    A model with layers on the GPU holds the shared GPU lock until it is freed.
    """
    try:
        from llama_cpp import Llama
    except ImportError as error:
        raise RuntimeError(
            "llama-cpp-python is required; install it in the active environment."
        ) from error

    # A CUDA build still puts the context cache and large prompt batches on the GPU unless told not to.
    on_cpu_only = gpu_layers == 0
    if not on_cpu_only:
        GPU_LOCK.acquire(on_wait)
    try:
        model = Llama(
            model_path=model_path,
            n_gpu_layers=gpu_layers,
            n_ctx=context_size,
            offload_kqv=not on_cpu_only,
            op_offload=not on_cpu_only,
            verbose=False,
        )
    except BaseException:
        if not on_cpu_only:
            GPU_LOCK.release()
        raise
    if not on_cpu_only:
        weakref.finalize(model, GPU_LOCK.release)
    return model


class ModelCache:
    """Keep one loaded model and reload it only when its load settings change."""

    def __init__(self) -> None:
        self._key: tuple[str, int, int] | None = None
        self._model: Any = None

    def has(self, model_path: str, context_size: int, gpu_layers: int) -> bool:
        return self._model is not None and self._key == (model_path, context_size, gpu_layers)

    def get(
        self,
        model_path: str,
        context_size: int,
        gpu_layers: int,
        on_wait: Callable[[str], None] | None = None,
    ) -> Any:
        if not self.has(model_path, context_size, gpu_layers):
            # Drop the old model first so two never sit in memory together.
            self._model = None
            self._model = create_model(model_path, context_size, gpu_layers, on_wait)
            self._key = (model_path, context_size, gpu_layers)
        return self._model

    def unload(self) -> bool:
        """Drop the loaded model to give its memory back, returning whether one was loaded."""
        loaded = self._model is not None
        self._model, self._key = None, None
        return loaded


def run_stage(
    llm: Any,
    system_prompt: str,
    user_input: str,
    max_tokens: int = MAX_TOKENS,
    temperature: float = TEMPERATURE,
    on_token: Callable[[str], None] | None = None,
    json_schema: dict[str, Any] | None = None,
    keep_cut_off: bool = False,
) -> str:
    """Run one model call; with keep_cut_off, a prose reply that hits the token limit keeps its complete sentences."""
    request = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_schema is not None:
        # llama.cpp turns the schema into a grammar, so the reply is always valid JSON of this shape.
        request["response_format"] = {"type": "json_object", "schema": json_schema}
    if on_token is not None:
        request["stream"] = True
    response = llm.create_chat_completion(**request)
    if on_token is not None:
        content_parts = []
        finish_reason = None
        for chunk in response:
            choices = chunk.get("choices", [])
            if not choices:
                continue
            choice = choices[0]
            finish_reason = choice.get("finish_reason") or finish_reason
            content = choice.get("delta", {}).get("content")
            if isinstance(content, str) and content:
                content_parts.append(content)
                on_token(content)
        response = {
            "choices": [
                {
                    "finish_reason": finish_reason,
                    "message": {"content": "".join(content_parts)},
                }
            ]
        }
    choices = response.get("choices", [])
    if not choices:
        raise RuntimeError("The model returned no completion choices.")

    choice = choices[0]
    content = choice.get("message", {}).get("content")
    if choice.get("finish_reason") == "length" and keep_cut_off and isinstance(content, str):
        end = max(content.rfind(mark) for mark in (". ", ".\n", "! ", "? "))
        if end > 0:
            return content[: end + 1].strip()
    if choice.get("finish_reason") == "length":
        raise RuntimeError(
            "A model call reached the token limit; raise max_tokens (background_max_tokens for background research) or context_size, or use Auto size in Options."
        )
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("The model returned an empty completion.")
    return content.strip()


def load_model(
    llm: Any,
    model_path: str,
    context_size: int,
    gpu_layers: int,
    model_cache: ModelCache | None,
    progress_callback: Callable[[str], None] | None,
) -> Any:
    """Return the given model, or load one, reporting the load only when it takes time."""
    if llm is not None:
        return llm
    if model_cache is None or not model_cache.has(model_path, context_size, gpu_layers):
        if progress_callback is not None:
            progress_callback("Loading model")
        else:
            print(f"Loading model from {model_path}...")
    load = model_cache.get if model_cache is not None else create_model
    return load(model_path, context_size, gpu_layers, progress_callback or print)
