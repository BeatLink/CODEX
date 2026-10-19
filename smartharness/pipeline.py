from typing import Any

from .settings import CONTEXT_SIZE, DEFAULT_MODEL_PATH, MAX_TOKENS, TEMPERATURE


def create_model(model_path: str, context_size: int, gpu_layers: int) -> Any:
    """Load the local GGUF model only when inference is requested."""
    try:
        from llama_cpp import Llama
    except ImportError as error:
        raise RuntimeError(
            "llama-cpp-python is required; install it in the active environment."
        ) from error

    return Llama(
        model_path=model_path,
        n_gpu_layers=gpu_layers,
        n_ctx=context_size,
        verbose=False,
    )


def run_stage(
    llm: Any,
    system_prompt: str,
    user_input: str,
    max_tokens: int = MAX_TOKENS,
    temperature: float = TEMPERATURE,
) -> str:
    response = llm.create_chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
    )
    choices = response.get("choices", [])
    if not choices:
        raise RuntimeError("The model returned no completion choices.")

    choice = choices[0]
    if choice.get("finish_reason") == "length":
        raise RuntimeError(
            "A pipeline stage reached the token limit; increase --max-tokens."
        )
    content = choice.get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("The model returned an empty completion.")
    return content.strip()


def _stage_context(user_prompt: str, previous_results: list[tuple[str, str]]) -> str:
    sections = [f"Original user request:\n{user_prompt}"]
    sections.extend(f"{label}:\n{result}" for label, result in previous_results)
    return "\n\n".join(sections)


def execute_pipeline(
    user_prompt: str,
    model_path: str = DEFAULT_MODEL_PATH,
    context_size: int = CONTEXT_SIZE,
    gpu_layers: int = -1,
    max_tokens: int = MAX_TOKENS,
    temperature: float = TEMPERATURE,
    llm: Any = None,
) -> str:
    if not user_prompt.strip():
        raise ValueError("The prompt cannot be empty.")
    if llm is None:
        print(f"Loading model from {model_path}...")
        llm = create_model(model_path, context_size, gpu_layers)

    stages = [
        (
            "Stage 1/4: Identifying the task and constraints",
            "Extract the requested outcome, explicit constraints, and any"
            " assumptions that need clarification. Return a concise checklist.",
        ),
        (
            "Stage 2/4: Preparing an answer plan",
            "Using the original request and task checklist, make a concise"
            " answer plan. Use general knowledge only; flag uncertain or"
            " time-sensitive claims instead of implying external research.",
        ),
        (
            "Stage 3/4: Reviewing the plan",
            "Check the plan against the original request and constraints."
            " Identify omissions, unsupported claims, or contradictions,"
            " then provide a corrected outline.",
        ),
        (
            "Stage 4/4: Writing the response",
            "Answer the original request using the reviewed outline. Follow"
            " its constraints, address every requested outcome, and state"
            " material assumptions or uncertainty. Do not claim research"
            " that was not performed.",
        ),
    ]
    previous_results: list[tuple[str, str]] = []
    for index, (label, system_prompt) in enumerate(stages, start=1):
        print(f"[{label}]...")
        result = run_stage(
            llm,
            system_prompt,
            _stage_context(user_prompt, previous_results),
            max_tokens=max_tokens,
            temperature=temperature,
        )
        previous_results.append((f"Stage {index} result", result))

    return previous_results[-1][1]