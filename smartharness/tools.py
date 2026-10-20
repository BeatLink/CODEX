import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any


MAX_FILE_BYTES = 100_000
MAX_TOOL_OUTPUT_CHARS = 12_000
MAX_DIRECTORY_ENTRIES = 100
TEST_TIMEOUT_SECONDS = 120
SENSITIVE_NAMES = {".env", "credentials", "id_rsa", "id_ed25519", "private_key", "secrets"}

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the public web for information relevant to the request.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 10},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List entries in a directory under the configured filesystem root.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a UTF-8 text file under the configured filesystem root.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "minLength": 1}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or replace a UTF-8 text file under the configured filesystem root. Does not delete files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        },
    },
]

RUN_TESTS_DEFINITION = {
    "type": "function",
    "function": {
        "name": "run_tests",
        "description": "Run Python unittest discovery under the configured filesystem root after making code changes.",
        "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
}


class Toolbox:
    def __init__(
        self,
        filesystem_root: str | Path,
        max_search_results: int = 5,
        enable_test_execution: bool = False,
        search_callback: Callable[[str, list[dict[str, str]]], None] | None = None,
    ):
        self.root = Path(filesystem_root).expanduser().resolve()
        if not self.root.is_dir():
            raise ValueError(f"Filesystem root is not a directory: {self.root}")
        if (
            isinstance(max_search_results, bool)
            or not isinstance(max_search_results, int)
            or not 1 <= max_search_results <= 10
        ):
            raise ValueError("max_search_results must be between 1 and 10.")
        if not isinstance(enable_test_execution, bool):
            raise ValueError("enable_test_execution must be a boolean.")
        self.max_search_results = max_search_results
        self.enable_test_execution = enable_test_execution
        self.search_callback = search_callback
        self.used_tools: set[str] = set()
        self.tool_definitions = [*TOOL_DEFINITIONS]
        if enable_test_execution:
            self.tool_definitions.append(RUN_TESTS_DEFINITION)

    def call(self, name: str, arguments: Any) -> str:
        if not isinstance(arguments, dict):
            return "Tool error: arguments must be a JSON object."
        handlers = {
            "web_search": self._web_search,
            "list_directory": self._list_directory,
            "read_file": self._read_file,
            "write_file": self._write_file,
        }
        handler = handlers.get(name)
        if name == "run_tests" and self.enable_test_execution:
            handler = self._run_tests
        if handler is None:
            return f"Tool error: unknown tool '{name}'."
        try:
            result = handler(arguments)
        except Exception as error:
            return f"Tool error: {type(error).__name__}: {error}"[:MAX_TOOL_OUTPUT_CHARS]
        if not isinstance(result, str):
            result = json.dumps(result, ensure_ascii=False)
        if not result.startswith("Tool error:"):
            self.used_tools.add(name)
        return result[:MAX_TOOL_OUTPUT_CHARS]

    def _web_search(self, arguments: dict[str, Any]) -> str:
        self._check_arguments(arguments, {"query"}, {"max_results"})
        query = arguments["query"]
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string.")
        requested = arguments.get("max_results", self.max_search_results)
        if isinstance(requested, bool) or not isinstance(requested, int) or not 1 <= requested <= 10:
            raise ValueError("max_results must be an integer from 1 to 10.")

        try:
            from ddgs import DDGS
        except ImportError as error:
            raise RuntimeError("Web search requires DDGS; install the project dependencies.") from error

        results = DDGS().text(
            query.strip(),
            max_results=min(requested, self.max_search_results),
        )
        formatted = [
            {
                "title": result.get("title", ""),
                "url": result.get("href", result.get("url", "")),
                "snippet": result.get("body", result.get("snippet", ""))[:1500],
            }
            for result in results
        ]
        if self.search_callback is not None:
            self.search_callback(query.strip(), formatted)
        return json.dumps(formatted, ensure_ascii=False)

    def _resolve_path(self, relative_path: str) -> Path:
        if not isinstance(relative_path, str) or not relative_path.strip():
            raise ValueError("path must be a non-empty relative path.")
        candidate_path = Path(relative_path)
        if candidate_path.is_absolute():
            raise ValueError("absolute paths are not allowed; use a path under the configured root.")
        resolved = (self.root / candidate_path).resolve()
        try:
            resolved.relative_to(self.root)
        except ValueError as error:
            raise ValueError("path escapes the configured filesystem root.") from error
        return resolved

    def _list_directory(self, arguments: dict[str, Any]) -> str:
        self._check_arguments(arguments, set(), {"path"})
        directory = self._resolve_path(arguments.get("path", "."))
        self._reject_sensitive_path(directory)
        if not directory.is_dir():
            raise ValueError("path is not a directory.")
        entries = []
        for entry in sorted(directory.iterdir(), key=lambda item: item.name)[:MAX_DIRECTORY_ENTRIES]:
            if self._is_sensitive_path(entry):
                continue
            if entry.is_symlink():
                entry_type = "symlink"
            elif entry.is_dir():
                entry_type = "directory"
            elif entry.is_file():
                entry_type = "file"
            else:
                entry_type = "other"
            entries.append({"name": entry.name, "type": entry_type})
        return json.dumps(entries, ensure_ascii=False)

    def _read_file(self, arguments: dict[str, Any]) -> str:
        self._check_arguments(arguments, {"path"}, set())
        path = self._resolve_path(arguments["path"])
        self._reject_sensitive_path(path)
        if not path.is_file():
            raise ValueError("path is not a file.")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"file exceeds the {MAX_FILE_BYTES}-byte read limit.")
        content = path.read_text(encoding="utf-8")
        if len(content) > MAX_TOOL_OUTPUT_CHARS:
            return content[:MAX_TOOL_OUTPUT_CHARS] + "\n[Output truncated]"
        return content

    def _write_file(self, arguments: dict[str, Any]) -> str:
        self._check_arguments(arguments, {"path", "content"}, set())
        path = self._resolve_path(arguments["path"])
        self._reject_sensitive_path(path)
        content = arguments["content"]
        if not isinstance(content, str):
            raise ValueError("content must be a string.")
        if len(content.encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError(f"file exceeds the {MAX_FILE_BYTES}-byte write limit.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path = self._resolve_path(arguments["path"])
        path.write_text(content, encoding="utf-8")
        return f"Wrote {len(content.encode('utf-8'))} bytes to {arguments['path']}."

    def _run_tests(self, arguments: dict[str, Any]) -> str:
        self._check_arguments(arguments, set(), set())
        start_dir = self.root / "tests" if (self.root / "tests").is_dir() else self.root
        try:
            result = subprocess.run(
                [sys.executable, "-m", "unittest", "discover", "-s", str(start_dir)],
                cwd=self.root,
                capture_output=True,
                text=True,
                timeout=TEST_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            output = error.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            return f"Tests timed out after {TEST_TIMEOUT_SECONDS} seconds.\n{output}"[
                :MAX_TOOL_OUTPUT_CHARS
            ]

        output = "\n".join(part for part in (result.stdout, result.stderr) if part)
        status = "passed" if result.returncode == 0 else f"failed (exit {result.returncode})"
        return f"Tests {status}.\n{output}"[:MAX_TOOL_OUTPUT_CHARS]

    @staticmethod
    def _is_sensitive_path(path: Path) -> bool:
        for part in path.parts:
            name = part.casefold()
            if name in SENSITIVE_NAMES or name.startswith("credentials."):
                return True
            if name.startswith(".env.") and name != ".env.example":
                return True
            if Path(name).suffix in {".pem", ".key", ".p12", ".pfx"}:
                return True
        return False

    @classmethod
    def _reject_sensitive_path(cls, path: Path) -> None:
        if cls._is_sensitive_path(path):
            raise ValueError("access to likely credential or secret files is blocked.")

    @staticmethod
    def _check_arguments(
        arguments: dict[str, Any], required: set[str], optional: set[str]
    ) -> None:
        keys = set(arguments)
        missing = required - keys
        unknown = keys - required - optional
        if missing:
            raise ValueError(f"missing argument(s): {', '.join(sorted(missing))}.")
        if unknown:
            raise ValueError(f"unknown argument(s): {', '.join(sorted(unknown))}.")