import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.auto_size import ModelShape, auto_size, choose_sizes, model_shape, read_gguf_metadata

MIB = 1024 * 1024


def write_gguf(path: Path, entries: list[tuple[str, int, object]]) -> None:
    def string(text: str) -> bytes:
        data = text.encode()
        return struct.pack("<Q", len(data)) + data

    body = b"GGUF" + struct.pack("<IQQ", 3, 0, len(entries))
    for key, value_type, value in entries:
        body += string(key) + struct.pack("<I", value_type)
        if value_type == 8:
            body += string(value)
        elif value_type == 9:
            body += struct.pack("<IQ", 8, len(value)) + b"".join(string(item) for item in value)
        else:
            body += struct.pack("<I", value)
    path.write_bytes(body)


class ModelShapeTests(unittest.TestCase):
    def test_reads_hybrid_attention_shape_and_skips_long_arrays(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.gguf"
            write_gguf(path, [
                ("general.architecture", 8, "qwen35"),
                ("general.name", 8, "Tiny"),
                ("tokenizer.ggml.tokens", 9, [f"t{index}" for index in range(2000)]),
                ("qwen35.block_count", 4, 32),
                ("qwen35.context_length", 4, 262144),
                ("qwen35.embedding_length", 4, 2560),
                ("qwen35.attention.head_count", 4, 16),
                ("qwen35.attention.head_count_kv", 4, 4),
                ("qwen35.attention.key_length", 4, 256),
                ("qwen35.attention.value_length", 4, 256),
                ("qwen35.full_attention_interval", 4, 4),
            ])

            self.assertEqual(read_gguf_metadata(path)["tokenizer.ggml.tokens"], 2000)
            shape = model_shape(path)

        self.assertEqual(shape.name, "Tiny")
        self.assertEqual(shape.trained_context, 262144)
        # 8 cached layers x 4 heads x 512 values x 2 bytes, plus the 512-token attention scratch.
        self.assertEqual(shape.bytes_per_token, 8 * 4 * 512 * 2 + 512 * 16 * 4)

    def test_rejects_a_file_that_is_not_gguf(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.bin"
            path.write_bytes(b"nope")
            with self.assertRaises(ValueError):
                model_shape(path)


class ChooseSizesTests(unittest.TestCase):
    shape = ModelShape("Tiny", 262144, 2187 * MIB, 64 * 1024)

    def test_fits_context_into_free_gpu_memory(self):
        choice = choose_sizes(self.shape, 4096 * MIB, 9000 * MIB, -1)
        self.assertEqual(choice.context_size, 21504)
        self.assertEqual((choice.max_tokens, choice.background_max_tokens), (5376, 2688))
        self.assertIn("GPU", choice.explanation)

    def test_matches_the_contexts_measured_on_a_4_gb_gpu(self):
        # Measured with a full window: the Q4_K_XL file runs at 6144 and aborts at 7168; Q3_K_M runs at 15360.
        q4_k_xl = ModelShape("Qwen3.5-4B UD-Q4_K_XL", 262144, 2_912_109_728, 64 * 1024)
        q3_k_m = ModelShape("Qwen3.5-4B Q3_K_M", 262144, 2_293_388_448, 64 * 1024)

        self.assertEqual(choose_sizes(q4_k_xl, 3760 * MIB, None, -1).context_size, 6144)
        self.assertEqual(choose_sizes(q3_k_m, 3760 * MIB, None, -1).context_size, 15360)

    def test_counts_the_loaded_model_as_free(self):
        busy = choose_sizes(self.shape, 1078 * MIB, None, -1)
        reclaimed = choose_sizes(self.shape, 1078 * MIB, None, -1, loaded_context=4096)
        self.assertEqual(busy.context_size, 2048)
        self.assertIn("lower GPU layers", busy.explanation)
        self.assertGreater(reclaimed.context_size, 8192)

    def test_caps_context_on_cpu_and_at_the_trained_length(self):
        self.assertEqual(choose_sizes(self.shape, None, 64000 * MIB, -1).context_size, 32768)
        short = ModelShape("Short", 8192, 2187 * MIB, 64 * 1024)
        self.assertEqual(choose_sizes(short, None, 64000 * MIB, 0).context_size, 8192)


    def test_refuses_when_the_gpu_is_present_but_unreadable(self):
        with (
            patch("smartharness.auto_size.shutil.which", return_value="/bin/nvidia-smi"),
            patch("smartharness.auto_size.subprocess.run", side_effect=OSError("crashed")),
            patch("smartharness.auto_size.model_shape", return_value=self.shape),
        ):
            with self.assertRaisesRegex(ValueError, "GPU layers to 0"):
                auto_size("model.gguf", -1)
            self.assertIn("RAM", auto_size("model.gguf", 0).explanation)


if __name__ == "__main__":
    unittest.main()
