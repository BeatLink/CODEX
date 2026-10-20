"""Keep model input within the context window so no stage overflows it."""

# A cautious characters-per-token estimate, so a budget errs towards fitting.
CHARS_PER_TOKEN = 3

# Tokens kept free for the chat template and message framing.
TEMPLATE_RESERVE_TOKENS = 128

TRIMMED_MARKER = "\n[Trimmed to fit the context window.]"


def input_char_budget(context_size: int, max_tokens: int, *fixed_texts: str) -> int:
    """Return how many characters of input fit beside the reply and the fixed texts."""
    free_tokens = context_size - max_tokens - TEMPLATE_RESERVE_TOKENS
    fixed_chars = sum(len(text) for text in fixed_texts)
    return max(500, free_tokens * CHARS_PER_TOKEN - fixed_chars)


def fit_sections(sections: list[tuple[str, str]], char_budget: int) -> list[tuple[str, str]]:
    """Trim the longest section texts evenly until the headings and texts fit the budget."""
    overhead = sum(len(heading) + 4 for heading, _ in sections)
    available = max(0, char_budget - overhead)
    lengths = [len(text) for _, text in sections]
    if sum(lengths) <= available:
        return sections

    # Find the largest per-section cap that keeps the total within the budget.
    cap = 0
    remaining = available
    ordered = sorted(lengths)
    for position, length in enumerate(ordered):
        share = remaining // (len(ordered) - position)
        if length > share:
            cap = share
            break
        remaining -= length

    fitted = []
    for heading, text in sections:
        if len(text) > cap:
            text = text[:max(0, cap - len(TRIMMED_MARKER))] + TRIMMED_MARKER
        fitted.append((heading, text))
    return fitted
