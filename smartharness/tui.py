import argparse
from threading import Event
from pathlib import Path
from typing import Any

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    Checkbox,
    Footer,
    Header,
    Input,
    Label,
    Markdown,
    Static,
    TabbedContent,
    TabPane,
    TextArea,
)

from .pipeline import execute_pipeline
from .settings import DEFAULT_SETTINGS_PATH, load_settings, validate_settings


STAGE_LABELS = (
    "Stage 1/7: Identifying the task and constraints",
    "Stage 2/7: Preparing an answer plan",
    "Stage 3/7: Searching and using local files when needed",
    "Stage 4/7: Reviewing the plan and tool evidence",
    "Stage 5/7: Drafting the response",
    "Stage 6/7: Critiquing the draft",
    "Stage 7/7: Revising the response",
)
STAGE_TAB_TITLES = ("Task", "Plan", "Tools", "Review", "Draft", "Critique", "Revise")


class ClarificationScreen(ModalScreen[str]):
    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(self, question: str) -> None:
        super().__init__()
        self.question = question

    def compose(self) -> ComposeResult:
        with Vertical(id="clarification-dialog"):
            yield Static("CLARIFICATION", classes="eyebrow")
            yield Static(self.question, id="clarification-question")
            yield Input(placeholder="Type an answer, or leave blank to continue", id="clarification-answer")
            with Horizontal(classes="button-row"):
                yield Button("Continue", id="clarification-submit", variant="primary")
                yield Button("Skip", id="clarification-skip")

    def on_mount(self) -> None:
        self.query_one("#clarification-answer", Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "clarification-submit":
            self.dismiss(self.query_one("#clarification-answer", Input).value)
        elif event.button.id == "clarification-skip":
            self.dismiss("")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "clarification-answer":
            self.dismiss(event.value)

    def action_cancel(self) -> None:
        self.dismiss("")


class SmartHarnessApp(App[None]):
    TITLE = "SmartHarness"
    SUB_TITLE = "LOCAL MODEL WORKBENCH"
    BINDINGS = [
        ("ctrl+enter", "run_prompt", "Run prompt"),
        ("ctrl+q", "quit", "Quit"),
    ]
    CSS = """
    Screen {
        background: #101715;
        color: #e4ebe4;
    }
    Header {
        background: #17221e;
        color: #e4ebe4;
    }
    Footer {
        background: #17221e;
        color: #a3b5a9;
    }
    #workspace {
        height: 1fr;
        padding: 1 2;
    }
    #sidebar {
        width: 34;
        min-width: 30;
        padding: 0 2 1 0;
        border-right: solid #34473d;
    }
    #content {
        width: 1fr;
        padding: 0 0 0 2;
    }
    .eyebrow {
        height: 1;
        color: #e5b85c;
        text-style: bold;
    }
    .field-label {
        height: 1;
        margin-top: 1;
        color: #9caf9f;
    }
    Input {
        height: 3;
        border: tall #34473d;
        background: #141d19;
    }
    Input:focus, TextArea:focus {
        border: tall #e5b85c;
    }
    #numeric-row {
        height: 5;
        margin-top: 1;
    }
    .numeric-field {
        width: 1fr;
        margin-right: 1;
    }
    .numeric-field Input {
        width: 1fr;
    }
    Checkbox {
        margin-top: 1;
        color: #c5d0c7;
    }
    #stage-heading {
        margin-top: 2;
        margin-bottom: 1;
    }
    .stage-row {
        height: 2;
        color: #83968a;
    }
    #status {
        height: 2;
        margin-top: 1;
        color: #e5b85c;
    }
    #prompt-label, #answer-label {
        height: 1;
        margin-bottom: 1;
        color: #9caf9f;
        text-style: bold;
    }
    #prompt {
        height: 1fr;
        min-height: 7;
        border: tall #34473d;
        background: #141d19;
    }
    #actions {
        height: 3;
        margin: 1 0;
    }
    Button {
        margin-right: 1;
        min-width: 12;
    }
    #phase-tabs {
        height: 1fr;
        min-height: 7;
        border: tall #34473d;
        background: #141d19;
    }
    .stage-output-scroll {
        height: 1fr;
    }
    .stage-output {
        padding: 1 2;
    }
    #clarification-dialog {
        width: 70;
        max-width: 90%;
        height: auto;
        max-height: 80%;
        padding: 1 2 2 2;
        border: tall #e5b85c;
        background: #17221e;
    }
    #clarification-question {
        height: auto;
        margin: 1 0;
    }
    .button-row {
        height: 3;
        margin-top: 1;
    }
    """

    def __init__(
        self,
        settings: dict[str, Any],
        initial_prompt: str = "",
    ) -> None:
        super().__init__()
        self.settings = settings.copy()
        self.initial_prompt = initial_prompt
        self._request_running = False
        self._last_answer = ""
        self._stage_output_buffers = [""] * len(STAGE_LABELS)
        self._pending_stage_output = [[] for _ in STAGE_LABELS]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="workspace"):
            with VerticalScroll(id="sidebar"):
                yield Static("MODEL CONFIGURATION", classes="eyebrow")
                yield Label("GGUF model path", classes="field-label")
                yield Input(value=self.settings["model_path"], id="model-path")
                with Horizontal(id="numeric-row-one"):
                    for label, key in (("Context", "context-size"), ("GPU layers", "gpu-layers")):
                        with Vertical(classes="numeric-field"):
                            yield Label(label, classes="field-label")
                            value = self.settings["context_size"] if key == "context-size" else self.settings["gpu_layers"]
                            yield Input(value=str(value), id=key)
                with Horizontal(id="numeric-row-two"):
                    for label, key in (("Max tokens", "max-tokens"), ("Temperature", "temperature")):
                        with Vertical(classes="numeric-field"):
                            yield Label(label, classes="field-label")
                            value = self.settings["max_tokens"] if key == "max-tokens" else self.settings["temperature"]
                            yield Input(value=str(value), id=key)
                yield Label("Filesystem root", classes="field-label")
                yield Input(value=self.settings["filesystem_root"], id="filesystem-root")
                yield Checkbox(
                    "Allow model to run project tests",
                    value=self.settings["enable_test_execution"],
                    id="enable-test-execution",
                )
                yield Static("PIPELINE", classes="eyebrow", id="stage-heading")
                for index, label in enumerate(STAGE_LABELS, start=1):
                    yield Static(f"WAIT  {label}", classes="stage-row", id=f"stage-{index}")
                yield Static("Ready", id="status")
            with Vertical(id="content"):
                yield Static("YOUR REQUEST", classes="eyebrow", id="prompt-label")
                yield TextArea(
                    self.initial_prompt,
                    show_line_numbers=False,
                    id="prompt",
                )
                with Horizontal(id="actions"):
                    yield Button("Run  Ctrl+Enter", id="run", variant="primary")
                    yield Button("Clear", id="clear")
                    yield Button("Copy answer", id="copy", disabled=True)
                yield Static("PHASE OUTPUT", classes="eyebrow", id="answer-label")
                with TabbedContent(initial="final", id="phase-tabs"):
                    for index, title in enumerate(STAGE_TAB_TITLES, start=1):
                        with TabPane(f"{index} {title}", id=f"stage-{index}"):
                            with VerticalScroll(classes="stage-output-scroll"):
                                yield Markdown(
                                    "_Waiting for this phase..._",
                                    classes="stage-output",
                                    id=f"stage-output-{index}",
                                )
                    with TabPane("Final", id="final"):
                        with VerticalScroll(classes="stage-output-scroll"):
                            yield Markdown(
                                "Your final response will appear here.",
                                classes="stage-output",
                                id="final-output",
                            )
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#prompt", TextArea).focus()
        self.set_interval(0.15, self._flush_stage_output)

    def action_run_prompt(self) -> None:
        self._start_run()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "run":
            self._start_run()
        elif event.button.id == "clear":
            self.query_one("#prompt", TextArea).text = ""
            self.query_one("#final-output", Markdown).update("Your final response will appear here.")
            self.query_one("#copy", Button).disabled = True
            self._last_answer = ""
            self._reset_stages()
            self.query_one("#status", Static).update("Ready")
        elif event.button.id == "copy":
            if self._last_answer:
                self.copy_to_clipboard(self._last_answer)
                self.notify("Answer copied to clipboard.", title="SmartHarness")

    def _start_run(self) -> None:
        if self._request_running:
            return
        prompt = self.query_one("#prompt", TextArea).text.strip()
        if not prompt:
            self.notify("Enter a prompt before running.", title="Prompt required", severity="warning")
            self.query_one("#prompt", TextArea).focus()
            return

        try:
            settings = self._collect_settings()
        except ValueError as error:
            self.notify(str(error), title="Invalid settings", severity="error")
            return

        self._reset_stages()
        self.query_one("#final-output", Markdown).update("_Working on your request..._")
        self.query_one("#copy", Button).disabled = True
        self.query_one("#run", Button).disabled = True
        self.query_one("#status", Static).update("Starting local model...")
        self._request_running = True
        self.run_pipeline(prompt, settings)

    def _collect_settings(self) -> dict[str, Any]:
        settings = self.settings.copy()
        settings.update(
            {
                "model_path": self.query_one("#model-path", Input).value,
                "context_size": self._int_setting("context-size"),
                "gpu_layers": self._int_setting("gpu-layers"),
                "max_tokens": self._int_setting("max-tokens"),
                "temperature": self._float_setting("temperature"),
                "filesystem_root": self.query_one("#filesystem-root", Input).value,
                "enable_test_execution": self.query_one("#enable-test-execution", Checkbox).value,
            }
        )
        return validate_settings(settings)

    def _int_setting(self, selector: str) -> int:
        value = self.query_one(f"#{selector}", Input).value
        try:
            return int(value)
        except ValueError as error:
            raise ValueError(f"{selector.replace('-', ' ')} must be an integer.") from error

    def _float_setting(self, selector: str) -> float:
        value = self.query_one(f"#{selector}", Input).value
        try:
            return float(value)
        except ValueError as error:
            raise ValueError("temperature must be a number.") from error

    def _reset_stages(self) -> None:
        for index, label in enumerate(STAGE_LABELS, start=1):
            self.query_one(f"#stage-{index}", Static).update(f"WAIT  {label}")
            self._stage_output_buffers[index - 1] = ""
            self._pending_stage_output[index - 1].clear()
            self.query_one(f"#stage-output-{index}", Markdown).update("_Waiting for this phase..._")
        self.query_one("#phase-tabs", TabbedContent).active = "final"

    def _append_stage_output(self, label: str, token: str) -> None:
        try:
            index = STAGE_LABELS.index(label)
        except ValueError:
            return
        self._pending_stage_output[index].append(token)

    def _flush_stage_output(self) -> None:
        for index, pending in enumerate(self._pending_stage_output):
            if not pending:
                continue
            self._stage_output_buffers[index] += "".join(pending)
            pending.clear()
            self.query_one(f"#stage-output-{index + 1}", Markdown).update(
                self._stage_output_buffers[index]
            )

    def _update_stage(self, label: str) -> None:
        self._flush_stage_output()
        if label == "Loading model":
            self.query_one("#status", Static).update("Loading local model...")
            return
        try:
            active = STAGE_LABELS.index(label)
        except ValueError:
            self.query_one("#status", Static).update(label)
            return
        for index, stage_label in enumerate(STAGE_LABELS):
            state = "DONE" if index < active else "NOW " if index == active else "WAIT"
            self.query_one(f"#stage-{index + 1}", Static).update(f"{state}  {stage_label}")
        self.query_one("#phase-tabs", TabbedContent).active = f"stage-{active + 1}"
        self.query_one("#status", Static).update(f"Stage {active + 1} of 7")

    def _finish_run(self, result: str) -> None:
        self._flush_stage_output()
        self._request_running = False
        self._last_answer = result
        self.query_one("#final-output", Markdown).update(result)
        self.query_one("#phase-tabs", TabbedContent).active = "final"
        self.query_one("#copy", Button).disabled = False
        self.query_one("#run", Button).disabled = False
        for index, label in enumerate(STAGE_LABELS, start=1):
            self.query_one(f"#stage-{index}", Static).update(f"DONE  {label}")
        self.query_one("#status", Static).update("Complete")

    def _fail_run(self, message: str) -> None:
        self._flush_stage_output()
        self._request_running = False
        self.query_one("#final-output", Markdown).update(f"**Run failed**\n\n{message}")
        self.query_one("#phase-tabs", TabbedContent).active = "final"
        self.query_one("#run", Button).disabled = False
        self.query_one("#status", Static).update("Run failed")
        self.notify(message, title="SmartHarness error", severity="error", timeout=8)

    def _request_clarification(self, question: str) -> str:
        completed = Event()
        answer: dict[str, str] = {}

        def show_dialog() -> None:
            def on_dismiss(value: str | None) -> None:
                answer["value"] = value or ""
                completed.set()

            self.push_screen(ClarificationScreen(question), on_dismiss)

        self.call_from_thread(show_dialog)
        completed.wait()
        return answer.get("value", "")

    @work(thread=True, exclusive=True)
    def run_pipeline(self, prompt: str, settings: dict[str, Any]) -> None:
        try:
            result = execute_pipeline(
                prompt,
                model_path=settings["model_path"],
                context_size=settings["context_size"],
                gpu_layers=settings["gpu_layers"],
                max_tokens=settings["max_tokens"],
                temperature=settings["temperature"],
                filesystem_root=settings["filesystem_root"],
                max_tool_calls=settings["max_tool_calls"],
                max_search_results=settings["max_search_results"],
                enable_test_execution=settings["enable_test_execution"],
                mcp_servers=settings["mcp_servers"],
                show_thinking=False,
                clarification_callback=self._request_clarification,
                progress_callback=lambda label: self.call_from_thread(self._update_stage, label),
                stage_output_callback=lambda label, token: self.call_from_thread(
                    self._append_stage_output, label, token
                ),
            )
        except Exception as error:
            self.call_from_thread(self._fail_run, str(error))
        else:
            self.call_from_thread(self._finish_run, result)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open the SmartHarness terminal interface.")
    local_settings_path = Path.cwd() / "settings.json"
    parser.add_argument(
        "--settings",
        default=str(local_settings_path if local_settings_path.is_file() else DEFAULT_SETTINGS_PATH),
        help="Path to the JSON settings file.",
    )
    args = parser.parse_args(argv)
    try:
        settings = load_settings(args.settings)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    SmartHarnessApp(settings).run()
    return 0