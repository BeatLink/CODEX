"""How the interfaces show a task tree: one line per task, and the details of the chosen one."""

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
