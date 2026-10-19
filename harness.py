import os
from llama_cpp import Llama

# Point this to your downloaded GGUF file path
MODEL_PATH = os.getenv("MODEL_PATH", "./models/model.gguf")

print("Initializing model and offloading layers to CUDA VRAM...")
llm = Llama(
    model_path=MODEL_PATH,
    n_gpu_layers=-1,  # Offloads 100% of layers to the GPU
    n_ctx=4096,  # Adjust context window size based on VRAM limits
    verbose=False,
)


def run_stage(system_prompt: str, user_input: str) -> str:
  """Helper to run an individual prompt stage through the local model."""
  response = llm.create_chat_completion(
      messages=[
          {"role": "system", "content": system_prompt},
          {"role": "user", "content": user_input},
      ],
      temperature=0.1,  # Low temperature keeps analytical stages focused
      max_tokens=1024,
  )
  return response["choices"][0]["message"]["content"]


def execute_pipeline(user_prompt: str) -> str:
  print(f"\n[Raw User Prompt]: {user_prompt}\n" + "-" * 40)

  # Stage 1: Break down meaning/intent
  print("⚡ [Stage 1/4]: Deconstructing prompt intent...")
  stage_1_sys = (
      "Break down the core intent, constraints, and implicit meaning of the"
      " user prompt into a structured analysis."
  )
  intent_breakdown = run_stage(stage_1_sys, user_prompt)
  print(intent_breakdown + "\n" + "-" * 40)

  # Stage 2: Collect/Map information
  print("⚡ [Stage 2/4]: Collecting necessary information and logic...")
  stage_2_sys = (
      "Based on this breakdown, list the key factual components, steps, or"
      " angles required to address the prompt."
  )
  collected_info = run_stage(stage_2_sys, intent_breakdown)
  print(collected_info + "\n" + "-" * 40)

  # Stage 3: Review and collate
  print("⚡ [Stage 3/4]: Reviewing and structuring outline...")
  stage_3_sys = (
      "Review the collected information for gaps, redundancies, or logical"
      " errors, and organize a finalized clean outline."
  )
  collate_review = run_stage(stage_3_sys, collected_info)
  print(collate_review + "\n" + "-" * 40)

  # Stage 4: Generate output
  print("⚡ [Stage 4/4]: Generating final structured output...")
  stage_4_sys = (
      "Using the final structured outline, write out the comprehensive and"
      " polished final response."
  )
  final_output = run_stage(stage_4_sys, collate_review)

  return final_output


if __name__ == "__main__":
  # Ensure you have a model placed at ./models/model.gguf or update MODEL_PATH
  sample_prompt = (
      "Design a clean architecture for a local Python event logging daemon"
      " and outline its error-handling behavior."
  )

  result = execute_pipeline(sample_prompt)

  print("\n" + "=" * 40)
  print("=== FINAL RESULT ===")
  print("=" * 40)
  print(result)