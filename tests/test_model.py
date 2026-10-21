import sys
import unittest
from unittest.mock import MagicMock, patch

from codex.model import ModelCache, create_model, run_stage


class RunStageTests(unittest.TestCase):
    def test_run_stage_streams_and_reassembles_content(self):
        class StreamingModel:
            def __init__(self):
                self.request = None

            def create_chat_completion(self, **request):
                self.request = request
                return iter(
                    [
                        {"choices": [{"delta": {"content": "First "}, "finish_reason": None}]},
                        {"choices": [{"delta": {"content": "second"}, "finish_reason": "stop"}]},
                    ]
                )

        llm = StreamingModel()
        streamed = []

        result = run_stage(llm, "System", "Input", on_token=streamed.append)

        self.assertEqual(result, "First second")
        self.assertEqual(streamed, ["First ", "second"])
        self.assertTrue(llm.request["stream"])

    def test_run_stage_omits_streaming_when_disabled(self):
        class NonStreamingModel:
            def __init__(self):
                self.request = None

            def create_chat_completion(self, **request):
                self.request = request
                return {
                    "choices": [
                        {"finish_reason": "stop", "message": {"content": "Complete"}}
                    ]
                }

        llm = NonStreamingModel()
        result = run_stage(llm, "System", "Input")

        self.assertEqual(result, "Complete")
        self.assertNotIn("stream", llm.request)

    def test_a_cut_off_reply_keeps_its_complete_sentences_only_when_asked(self):
        llm = MagicMock()
        llm.create_chat_completion.return_value = {
            "choices": [{"finish_reason": "length", "message": {"content": "WAL is faster. Readers do not block wri"}}]
        }

        with self.assertRaisesRegex(RuntimeError, "token limit"):
            run_stage(llm, "System", "Input")
        self.assertEqual(run_stage(llm, "System", "Input", keep_cut_off=True), "WAL is faster.")

        llm.create_chat_completion.return_value = {
            "choices": [{"finish_reason": "length", "message": {"content": "Readers do not block wri"}}]
        }
        with self.assertRaisesRegex(RuntimeError, "token limit"):
            run_stage(llm, "System", "Input", keep_cut_off=True)


class ModelCacheTests(unittest.TestCase):
    def test_cache_reuses_the_model_until_load_settings_change(self):
        with patch("codex.model.create_model", side_effect=lambda *args: object()) as create_model:
            cache = ModelCache()
            self.assertFalse(cache.has("model.gguf", 4096, -1))
            first = cache.get("model.gguf", 4096, -1)
            self.assertIs(cache.get("model.gguf", 4096, -1), first)
            self.assertTrue(cache.has("model.gguf", 4096, -1))
            second = cache.get("model.gguf", 8192, -1)

        self.assertIsNot(second, first)
        self.assertEqual(create_model.call_count, 2)

    def test_a_cpu_model_keeps_its_cache_and_prompt_batches_off_the_gpu(self):
        llama_cpp = MagicMock()
        # A GPU load takes the shared GPU lock, which another program may be holding.
        with patch.dict(sys.modules, {"llama_cpp": llama_cpp}), patch("codex.model.GPU_LOCK"):
            create_model("model.gguf", 4096, 0)
            cpu = llama_cpp.Llama.call_args.kwargs
            create_model("model.gguf", 4096, -1)
            gpu = llama_cpp.Llama.call_args.kwargs

        self.assertEqual((cpu["offload_kqv"], cpu["op_offload"]), (False, False))
        self.assertEqual((gpu["offload_kqv"], gpu["op_offload"]), (True, True))


if __name__ == "__main__":
    unittest.main()
