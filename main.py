import ollama

MODEL_NAME = "llama3.2"  # Or another small model that fits fully in VRAM


def run_stage(system_prompt, user_input):
    response = ollama.chat(
        model=MODEL_NAME,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
        options={"temperature": 0.1},  # Low temp keeps small models focused
    )
    return response["message"]["content"]


def smart_pipeline(user_prompt):
    print("--- Stage 1: Deconstructing Prompt ---")
    stage_1_prompt = "Break down the core intent, constraints, and implicit meaning of the following user prompt."
    intent_breakdown = run_stage(stage_1_prompt, user_prompt)
    print(intent_breakdown)

    print("\n--- Stage 2: Collecting Information/Context ---")
    stage_2_prompt = "Based on this breakdown, list the key facts, angles, or logical steps needed to answer it."
    collected_info = run_stage(stage_2_prompt, intent_breakdown)
    print(collected_info)

    print("\n--- Stage 3: Reviewing and Collating ---")
    stage_3_prompt = (
        "Review the collected information for gaps, redundancies, or errors,"
        " and organize a final structured outline."
    )
    collate_review = run_stage(stage_3_prompt, collected_info)
    print(collate_review)

    print("\n--- Stage 4: Generating Final Output ---")
    stage_4_prompt = (
        "Using the final structured outline, write out the comprehensive and"
        " polished final response."
    )
    final_output = run_stage(stage_4_prompt, collate_review)

    return final_output


# Example usage
final_result = smart_pipeline(
    "Design a minimalist weekly budget template and explain how to stick to" " it."
)
print("\n=== FINAL RESULT ===")
print(final_result)
