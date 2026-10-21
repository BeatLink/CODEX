"""Checks on a written result that do not rely on the model."""

from pathlib import Path
import re
from typing import Any


CODE_BLOCK = re.compile(r"```.*?(?:```|$)", re.DOTALL)
_URL = re.compile(r"https?://[^\s<>()\[\]\"'`]+")
_FAILURE_WORD = re.compile(
    r"\b(fail\w*|error\w*|unable|blocked|timed out|could not|couldn't|did not|didn't|was not|wasn't)\b",
    re.IGNORECASE,
)
# Phrases such as "was updated", "I changed", or a sentence opening "Fixed", which a report must not use when no file was written.
_CLAIMED_CHANGE = re.compile(
    r"(?:\b(?:i|i've|i have|has been|have been|was|were)\s+(?:now\s+)?|(?:^|[.!?]\s+)\s*(?:[-*]\s+)?)"
    r"(?:wrote|written|updated|changed|created|modified|edited|renamed|fixed|added)\b",
    re.IGNORECASE | re.MULTILINE,
)
# Phrases such as "all tests now pass", which a report must not use unless a test run passed.
_CLAIMED_PASSING_TESTS = re.compile(
    r"\btests?\b(?:[^.!?\n]|\.(?=\w)){0,80}\b(?:pass|passes|passed|passing|succeed\w*)\b", re.IGNORECASE
)

_NEGATION = re.compile(r"\b(?:no|not|nothing|none|never|without)\b|n't\b", re.IGNORECASE)


def _claims(pattern: re.Pattern[str], report: str) -> bool:
    """Say whether the report makes the claim in a sentence that does not negate it, as "nothing was edited" does."""
    for match in pattern.finditer(report):
        sentence_start = max(report.rfind(mark, 0, match.start()) for mark in (". ", "!", "?", "\n")) + 1
        ends = [report.find(mark, match.end()) for mark in (". ", "!", "?", "\n")]
        sentence_end = min([end for end in ends if end != -1], default=len(report))
        if not _NEGATION.search(report[sentence_start:sentence_end]):
            return True
    return False


def uncited_urls(answer: str, evidence: str) -> list[str]:
    """List URLs the answer cites that appear nowhere in the captured evidence."""
    urls = dict.fromkeys(url.rstrip(".,;:!?") for url in _URL.findall(answer))
    return [url for url in urls if url not in evidence]


_VERSION = re.compile(r"(?<![\w.])v?(\d+(?:\.\d+)+)(?![\w.]*\d)")
_MONTHS = {
    name: number
    for number, names in enumerate(
        (("january", "jan"), ("february", "feb"), ("march", "mar"), ("april", "apr"), ("may",), ("june", "jun"),
         ("july", "jul"), ("august", "aug"), ("september", "sep", "sept"), ("october", "oct"),
         ("november", "nov"), ("december", "dec")),
        start=1,
    )
    for name in names
}
_MONTH = r"(" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + r")\.?"
_DATE_FORMATS = (
    # 2026-10-09
    (re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b"), ("year", "month", "day")),
    # October 9, 2026
    (re.compile(rf"\b{_MONTH}\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})\b", re.IGNORECASE), ("month", "day", "year")),
    # 9 October 2026
    (re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+{_MONTH},?\s+(\d{{4}})\b", re.IGNORECASE), ("day", "month", "year")),
)


def _dates(text: str) -> list[tuple[str, tuple[int, int, int]]]:
    """Find the calendar dates written in text, in any of the usual forms, as (as written, (year, month, day))."""
    found = []
    for pattern, fields in _DATE_FORMATS:
        for match in pattern.finditer(text):
            parts = dict(zip(fields, match.groups()))
            month = parts["month"]
            month_number = int(month) if month.isdigit() else _MONTHS[month.casefold()]
            found.append((match.group(0), (int(parts["year"]), month_number, int(parts["day"]))))
    return found


def unsupported_values(answer: str, evidence: str) -> list[str]:
    """List version numbers and dates the answer states that appear nowhere in the evidence.

    A small model fills gaps with plausible numbers, so a stated value must be found in what was gathered.
    """
    prose = _URL.sub(" ", CODE_BLOCK.sub(" ", answer))
    known_versions = set(_VERSION.findall(evidence))
    known_dates = {date for _, date in _dates(evidence)}
    values = [version for version in _VERSION.findall(prose) if version not in known_versions]
    values.extend(written for written, date in _dates(prose) if date not in known_dates)
    return list(dict.fromkeys(values))


def action_report_problems(report: str, action_log: list[tuple[str, dict[str, Any], str]]) -> list[str]:
    """List the places where the report disagrees with what the file and test tools really did."""
    folded = report.casefold()
    mentions_failure = bool(_FAILURE_WORD.search(report))
    problems = []
    for name, arguments, result in action_log:
        failed = result.startswith(("Tool error", "Tests failed", "Tests timed out"))
        if name == "write_file":
            path = str(arguments.get("path", ""))
            if not path:
                continue
            if Path(path).name.casefold() not in folded:
                outcome = "failed" if failed else "was made"
                problems.append(f"The change to {path} {outcome}, but the report does not mention it.")
            elif failed and not mentions_failure:
                problems.append(f"Writing {path} failed ({result[:200]}); say plainly that this change was not made.")
        elif name == "run_tests":
            if failed and not mentions_failure:
                problems.append(f"The test run did not pass ({result.splitlines()[0]}); the report must say so.")
            elif "test" not in folded:
                problems.append(f"The tests were run ({result.splitlines()[0]}); the report must give the result.")
    return problems + unbacked_claims(report, action_log)


def unbacked_claims(report: str, action_log: list[tuple[str, dict[str, Any], str]]) -> list[str]:
    """List the changes and passing tests a report claims that no recorded action backs up."""
    problems = []
    wrote_a_file = any(
        name == "write_file" and not result.startswith("Tool error") for name, _, result in action_log
    )
    if not wrote_a_file and _claims(_CLAIMED_CHANGE, report):
        problems.append("No file was written, so the report must not say that anything was changed.")
    tests_passed = any(name == "run_tests" and result.startswith("Tests passed") for name, _, result in action_log)
    if not tests_passed and _claims(_CLAIMED_PASSING_TESTS, report):
        problems.append("No test run passed, so the report must not say that the tests pass.")
    return problems
