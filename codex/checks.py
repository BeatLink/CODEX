"""Checks on a written result that do not rely on the model."""

import ast
from datetime import date
import operator
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


# ==============================================================================
# Recomputing calculations
# ==============================================================================

_EQUALS_SIGNS = "=≈"
# Characters a written-out sum may hold: digits, operators, brackets, grouping commas, and currency signs.
_EQUATION_CHARACTERS = set("0123456789.,()+-*/^ £$€")
_OPERATOR_BETWEEN_NUMBERS = re.compile(r"[\d)]\s*[-+*/^]\s*[\d(]")
_CLAIMED_NUMBER = re.compile(r"\s*[£$€]?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])|-?\d+(?:\.\d+)?)")
_GROUPING_COMMA = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")
_LOOKS_LIKE_A_DATE = re.compile(r"\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}")
_ARITHMETIC_OPERATORS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Pow: operator.pow,
}
_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_WEEKDAY_BEFORE = re.compile(r"\b(" + "|".join(_WEEKDAYS) + r")\s*,?\s*(?:the\s+)?$", re.IGNORECASE)
_WEEKDAY_AFTER = re.compile(
    r"^\s*,?\s*(?:is|was|will be|would be|falls on|fell on|lands on)\s+(?:a\s+|on\s+a\s+)?(" + "|".join(_WEEKDAYS) + r")\b",
    re.IGNORECASE,
)


def _normalized_arithmetic(text: str) -> str:
    """Write the usual typographic operators as the plain ones Python reads."""
    text = text.replace("−", "-").replace("–", "-").replace("×", "*").replace("·", "*").replace("÷", "/")
    return re.sub(r"(?<=\d)\s*[xX]\s*(?=\d)", " * ", text)


def _evaluate(node: ast.AST) -> float:
    """Work out a parsed sum of numbers only, refusing names, calls, and huge powers."""
    if isinstance(node, ast.Expression):
        return _evaluate(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = _evaluate(node.operand)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.BinOp) and type(node.op) in _ARITHMETIC_OPERATORS:
        left, right = _evaluate(node.left), _evaluate(node.right)
        if isinstance(node.op, ast.Pow) and (abs(right) > 100 or abs(left) > 1e6):
            raise ValueError("The power is too large to work out.")
        return _ARITHMETIC_OPERATORS[type(node.op)](left, right)
    raise ValueError("Only numbers and arithmetic operators can be worked out.")


def _sum_before(text: str) -> tuple[str, float] | None:
    """Find the written-out sum that ends where the text ends, and work it out, or return None."""
    start = len(text)
    while start > 0 and text[start - 1] in _EQUATION_CHARACTERS:
        start -= 1
    words = text[start:].split()
    # Leading words such as a list number or an opening bracket are dropped until what is left reads as a sum.
    for first in range(len(words)):
        written = " ".join(words[first:]).strip()
        while written.startswith("(") and written.count("(") > written.count(")"):
            written = written[1:].strip()
        if not _OPERATOR_BETWEEN_NUMBERS.search(written) or _LOOKS_LIKE_A_DATE.search(written):
            continue
        plain = _GROUPING_COMMA.sub("", re.sub(r"[£$€]", "", written))
        if "," in plain:
            continue
        try:
            return written, float(_evaluate(ast.parse(plain.replace("^", "**"), mode="eval")))
        except (SyntaxError, ValueError, ZeroDivisionError, OverflowError):
            continue
    return None


def _claimed_number(text: str) -> tuple[str, float] | None:
    """Read the number written just after an equals sign, or return None when it is not a plain number."""
    match = _CLAIMED_NUMBER.match(text)
    if match is None:
        return None
    written, following = match.group(1), text[match.end():match.end() + 1]
    # A time, a fraction, a percentage, or a version number is not the plain result of a sum.
    if following and (following in ":/%" or (following == "." and text[match.end() + 1:match.end() + 2].isdigit())):
        return None
    return written, float(written.replace(",", ""))


def _weekday_problems(text: str) -> list[str]:
    """List the dates the text names with the wrong day of the week."""
    problems = []
    for pattern, fields in _DATE_FORMATS:
        for match in pattern.finditer(text):
            parts = dict(zip(fields, match.groups()))
            month = parts["month"]
            try:
                day = date(int(parts["year"]), int(month) if month.isdigit() else _MONTHS[month.casefold()], int(parts["day"]))
            except ValueError:
                continue
            named = _WEEKDAY_BEFORE.search(text[max(0, match.start() - 20):match.start()]) or _WEEKDAY_AFTER.match(
                text[match.end():match.end() + 30]
            )
            if named and named.group(1).casefold() != _WEEKDAYS[day.weekday()]:
                problems.append(
                    f"The result calls {match.group(0)} a {named.group(1).capitalize()}, but it is a"
                    f" {_WEEKDAYS[day.weekday()].capitalize()}."
                )
    return problems


def calculation_problems(text: str) -> list[str]:
    """List the written-out sums whose stated result is wrong, and the dates given the wrong weekday."""
    prose = _normalized_arithmetic(CODE_BLOCK.sub(" ", text))
    problems = []
    for index, sign in enumerate(prose):
        if sign not in _EQUALS_SIGNS:
            continue
        worked_out = _sum_before(prose[:index])
        claimed = _claimed_number(prose[index + 1:])
        if worked_out is None or claimed is None:
            continue
        (written_sum, value), (written_result, stated) = worked_out, claimed
        decimals = len(written_result.partition(".")[2])
        # A stated result may round the true value to the decimals it shows, and "≈" allows one more unit.
        allowed = 10 ** -decimals * (1 if sign == "≈" else 0.5) + 1e-9
        # A whole-number result of a division is read as the quotient, as in "787 / 60 = 13 hours and 7 minutes".
        quotient = "/" in written_sum and decimals == 0 and stated == int(value)
        if abs(value - stated) > allowed and not quotient:
            exact = f"{value:,.{max(decimals, 2)}f}".rstrip("0").rstrip(".") if value != int(value) else f"{int(value):,}"
            problems.append(f"The working states {written_sum} {sign} {written_result}, but it equals {exact}.")
    return problems + _weekday_problems(prose)
