# Progress labels the pipeline reports for each stage, in order, and the short names interfaces show.
STAGE_LABELS = (
    "Stage 1/8: Identifying the task and constraints",
    "Stage 2/8: Researching and inspecting relevant files",
    "Stage 3/8: Preparing an answer plan",
    "Stage 4/8: Reviewing the plan and research evidence",
    "Stage 5/8: Executing reviewed tool actions",
    "Stage 6/8: Drafting the response",
    "Stage 7/8: Critiquing the draft",
    "Stage 8/8: Revising the response",
)
STAGE_TAB_TITLES = ("Task", "Research", "Plan", "Review", "Actions", "Draft", "Critique", "Revise")

# Task tree runs report steps as "Task <number> · <step>", and interfaces show each task's state in a short word.
TASK_STEP_PREFIX = "Task "
TASK_STATE_WORDS = {"pending": "WAIT", "running": "NOW ", "done": "DONE", "unverified": "WARN", "failed": "FAIL"}
TASK_PROMPT_CHARS = 80


def task_tree_lines(nodes: list[dict]) -> list[str]:
    """Write each task as one line: its state, then its number and prompt, indented by depth."""
    lines = []
    for node in nodes:
        prompt = " ".join(node["prompt"].split())
        if len(prompt) > TASK_PROMPT_CHARS:
            prompt = prompt[:TASK_PROMPT_CHARS - 1] + "…"
        indent = "  " * node["id"].count(".")
        lines.append(f"{TASK_STATE_WORDS.get(node['status'], 'WAIT')}  {indent}{node['id']} {prompt}")
    return lines


def task_detail_markdown(node: dict) -> str:
    """Describe one task for the interfaces: what it asks, what finished looks like, how it went, and its result."""
    state = node["status"] + (f", {node['approach']}" if node.get("approach") else "")
    parts = [f"### Task {node['id']}", node["prompt"], f"**Deliverable:** {node['deliverable']}", f"**State:** {state}"]
    if node.get("depends_on"):
        parts.append(f"**Builds on:** {', '.join(node['depends_on'])}")
    if node.get("note"):
        parts.append(f"**Note:** {node['note']}")
    parts.append(node.get("result") or "_No result yet._")
    if node.get("result_shortened"):
        parts.append("_The result is shortened here; the Steps tab has all of it._")
    return "\n\n".join(parts)
