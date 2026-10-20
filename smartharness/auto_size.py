"""Pick a context size and reply limits that fit the model file and this machine's memory."""

import shutil
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

GGUF_MAGIC = b"GGUF"

# Bytes per value for each GGUF scalar type code.
GGUF_SCALAR_FORMATS = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}
GGUF_STRING = 8
GGUF_ARRAY = 9

# Tokens llama.cpp processes per batch, which sizes its attention scratch buffer.
BATCH_TOKENS = 512

# Memory set aside for the runtime's fixed buffers and anything else sharing the device.
FIXED_RESERVE_BYTES = 512 * 1024 * 1024
HEADROOM_FRACTION = 0.10

# Small models lose track of long inputs and every stage re-reads its whole input, so stop here.
MAX_AUTO_CONTEXT = 32_768
MIN_AUTO_CONTEXT = 2_048
CONTEXT_STEP = 1_024


# ==============================================================================
# Reading the model file
# ==============================================================================


def read_gguf_metadata(model_path: str | Path) -> dict[str, Any]:
    """Read the GGUF header's key-value metadata, keeping only the length of long arrays."""
    with Path(model_path).expanduser().open("rb") as model_file:
        if model_file.read(4) != GGUF_MAGIC:
            raise ValueError(f"{model_path} is not a GGUF model file.")
        _read(model_file, "I")
        _read(model_file, "Q")
        entry_count = _read(model_file, "Q")
        metadata = {}
        for _ in range(entry_count):
            key = _read_string(model_file)
            metadata[key] = _read_value(model_file, _read(model_file, "I"))
        return metadata


def _read(model_file: BinaryIO, fmt: str) -> Any:
    size = struct.calcsize("<" + fmt)
    return struct.unpack("<" + fmt, model_file.read(size))[0]


def _read_string(model_file: BinaryIO) -> str:
    return model_file.read(_read(model_file, "Q")).decode("utf-8", "replace")


def _read_value(model_file: BinaryIO, value_type: int) -> Any:
    if value_type == GGUF_STRING:
        return _read_string(model_file)
    if value_type == GGUF_ARRAY:
        item_type = _read(model_file, "I")
        length = _read(model_file, "Q")
        # Tokenizer vocabularies run to six figures; only short arrays such as per-layer counts are kept.
        if length > 1024:
            for _ in range(length):
                _read_value(model_file, item_type)
            return length
        return [_read_value(model_file, item_type) for _ in range(length)]
    if value_type not in GGUF_SCALAR_FORMATS:
        raise ValueError(f"Unknown GGUF value type {value_type}.")
    return _read(model_file, GGUF_SCALAR_FORMATS[value_type])


@dataclass
class ModelShape:
    name: str
    trained_context: int
    file_bytes: int
    # Memory each token of context costs: its key-value cache plus the attention scratch buffer.
    bytes_per_token: int


def model_shape(model_path: str | Path) -> ModelShape:
    metadata = read_gguf_metadata(model_path)
    architecture = metadata.get("general.architecture", "")

    def number(key: str, default: int = 0) -> int:
        value = metadata.get(f"{architecture}.{key}", default)
        # Some models list a count per layer; the largest one bounds the cost.
        return max(value) if isinstance(value, list) and value else int(value or default)

    layers = number("block_count")
    heads = number("attention.head_count", 1)
    kv_heads = number("attention.head_count_kv", heads)
    head_size = number("embedding_length") // max(1, heads)
    key_size = number("attention.key_length", head_size)
    value_size = number("attention.value_length", head_size)
    # Hybrid models keep a cache only on every n-th layer; the rest hold a fixed-size state.
    interval = number("full_attention_interval", 1)
    attention_layers = max(1, layers // max(1, interval))

    cache_bytes = attention_layers * kv_heads * (key_size + value_size) * 2
    scratch_bytes = BATCH_TOKENS * heads * 4
    return ModelShape(
        name=str(metadata.get("general.name") or Path(model_path).stem),
        trained_context=number("context_length", MIN_AUTO_CONTEXT),
        file_bytes=Path(model_path).expanduser().stat().st_size,
        bytes_per_token=cache_bytes + scratch_bytes,
    )


# ==============================================================================
# Reading the machine
# ==============================================================================


def free_gpu_bytes() -> int | None:
    """Return the free memory on the first NVIDIA GPU, or None when there is no GPU."""
    gpu_present = Path("/proc/driver/nvidia").exists() or Path("/dev/nvidia0").exists()
    if shutil.which("nvidia-smi") is None:
        if gpu_present:
            raise ValueError("An NVIDIA GPU is present but nvidia-smi is missing, so its free memory is unknown.")
        return None
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
        return int(output.split()[0]) * 1024 * 1024
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as error:
        # Sizing for RAM instead would pick a context the GPU cannot hold.
        raise ValueError(
            f"Could not read free GPU memory from nvidia-smi ({error}); set GPU layers to 0 to size for RAM."
        ) from error


def available_ram_bytes() -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


# ==============================================================================
# Choosing the limits
# ==============================================================================


@dataclass
class SizeChoice:
    context_size: int
    max_tokens: int
    background_max_tokens: int
    explanation: str


def choose_sizes(
    shape: ModelShape,
    gpu_free: int | None,
    ram_free: int | None,
    gpu_layers: int,
    loaded_context: int | None = None,
) -> SizeChoice:
    """Fit the largest sensible context into free memory, then split it between input and reply.

    `loaded_context` is the context of this model when it is already loaded, so its memory counts as free.
    """
    reclaimed = (
        shape.file_bytes + shape.bytes_per_token * loaded_context + FIXED_RESERVE_BYTES if loaded_context else 0
    )
    on_gpu = gpu_layers != 0 and gpu_free is not None
    device = "GPU" if on_gpu else "RAM"
    free = gpu_free if on_gpu else ram_free
    if free is None:
        free = shape.file_bytes + shape.bytes_per_token * MIN_AUTO_CONTEXT + FIXED_RESERVE_BYTES
    free += reclaimed

    spare = free * (1 - HEADROOM_FRACTION) - shape.file_bytes - FIXED_RESERVE_BYTES
    fits = int(max(0, spare) // shape.bytes_per_token)
    limit = min(fits, shape.trained_context, MAX_AUTO_CONTEXT)
    context_size = max(MIN_AUTO_CONTEXT, limit // CONTEXT_STEP * CONTEXT_STEP)

    # A quarter of the window for the reply leaves three quarters for the request and evidence.
    max_tokens = max(512, min(8_192, context_size // 4))
    # Background calls hold the model lock, so their replies are kept shorter.
    background_max_tokens = max(256, min(4_096, context_size // 8))

    explanation = (
        f"{shape.name}: {shape.file_bytes / 2**30:.1f} GiB of weights,"
        f" {shape.bytes_per_token / 1024:.0f} KiB per context token,"
        f" {free / 2**30:.1f} GiB free {device}"
    )
    if context_size > fits:
        explanation += (
            "; even the smallest context may not fit, so lower GPU layers or close other GPU programs"
            if on_gpu
            else "; even the smallest context may not fit"
        )
    return SizeChoice(context_size, max_tokens, background_max_tokens, explanation)


def auto_size(model_path: str, gpu_layers: int, loaded_context: int | None = None) -> SizeChoice:
    gpu_free = free_gpu_bytes() if gpu_layers != 0 else None
    return choose_sizes(model_shape(model_path), gpu_free, available_ram_bytes(), gpu_layers, loaded_context)
