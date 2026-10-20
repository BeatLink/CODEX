import argparse
from datetime import datetime
from pathlib import Path
from typing import Any

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.css.query import NoMatches
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.message import Message
from textual.screen import ModalScreen
from textual.theme import Theme
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
    Tabs,
    TextArea,
    Tree,
)

from .client import DISCONNECTED_EVENT, DaemonClient, DaemonError, connect_to_daemon
from .pipeline import SKIPPED_PREFIX
from .settings import default_settings_path, load_settings, validate_settings
from .stages import STAGE_LABELS, STAGE_TAB_TITLES


PHASE_WAITING_TEXT = "_Waiting for this phase..._"
PHASE_SKIPPED_TEXT = "_Skipped: this request does not need this phase._"
FINAL_WAITING_TEXT = "Your final response will appear here."
BACKGROUND_WAITING_TEXT = "_Waiting for background work..._"

# Colours come from the dark and light token sets in the Halon theme's tokens.json.
HALON_DARK_VARIABLES = {
    "field-border": "#64748b",
    "label-text": "#cbd5e1",
    "stage-text": "#94a3b8",
    "footer-foreground": "#ffffff",
}
HALON_DARK_THEME = Theme(
    name="halon-dark",
    primary="#60a5fa",
    accent="#60a5fa",
    foreground="#e2e8f0",
    background="#060b14",
    surface="#16213a",
    panel="#060b14",
    warning="#f59e0b",
    error="#f87171",
    success="#10b981",
    dark=True,
    variables=HALON_DARK_VARIABLES,
)
HALON_LIGHT_THEME = Theme(
    name="halon",
    primary="#2563eb",
    accent="#2563eb",
    foreground="#1a1a2e",
    background="#f1f5f9",
    surface="#ffffff",
    panel="#f1f5f9",
    warning="#f59e0b",
    error="#dc2626",
    success="#047857",
    dark=False,
    variables={
        "field-border": "#8792a3",
        "label-text": "#475569",
        "stage-text": "#64748b",
        "footer-foreground": "#475569",
    },
)


class DaemonEvent(Message):
    """An event from the daemon, posted from the client's reader thread."""

    def __init__(self, event: str, data: dict[str, Any]) -> None:
        super().__init__()
        self.event = event
        self.data = data


class FollowingScroll(VerticalScroll):
    following = True

    def watch_virtual_size(self) -> None:
        if self.following:
            self.scroll_end(animate=False)

    def watch_scroll_y(self, old_value: float, new_value: float) -> None:
        super().watch_scroll_y(old_value, new_value)
        self.following = new_value >= self.max_scroll_y - 1


class ClarificationScreen(ModalScreen[str]):
    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(self, question: str) -> None:
        super().__init__()
        self.question = question

    def compose(self) -> ComposeResult:
        with Vertical(id="clarification-dialog"):
            yield Static("CLARIFICATION", classes="eyebrow")
            yield Static(self.question, id="clarification-question")
            yield Label("Your response", classes="field-label")
            yield TextArea(
                soft_wrap=True,
                classes="wrapped-field",
                id="clarification-answer",
            )
            with Horizontal(classes="button-row"):
                yield Button("Continue", id="clarification-submit", variant="primary")
                yield Button("Skip", id="clarification-skip")

    def on_mount(self) -> None:
        self.query_one("#clarification-answer", TextArea).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "clarification-submit":
            self.dismiss(self.query_one("#clarification-answer", TextArea).text)
        elif event.button.id == "clarification-skip":
            self.dismiss("")

    def action_cancel(self) -> None:
        self.dismiss("")


class SmartHarnessApp(App[None]):
    TITLE = "SmartHarness"
    SUB_TITLE = "LOCAL MODEL WORKBENCH"
    BINDINGS = [
        ("ctrl+r", "run_prompt", "Run prompt"),
        Binding("ctrl+enter", "run_prompt", "Run prompt", show=False),
        ("ctrl+q", "quit", "Quit"),
    ]
    CSS = """
    Screen {
        background: $background;
        color: $foreground;
    }
    Header {
        background: $panel;
        color: $foreground;
    }
    Footer {
        background: $panel;
        color: $footer-foreground;
    }
    #workspace {
        height: 1fr;
        padding: 1 2;
    }
    #sidebar {
        width: 34;
        min-width: 30;
        padding: 0 2 1 0;
        border-right: solid $field-border;
    }
    #content {
        width: 1fr;
        padding: 0 0 0 2;
    }
    .eyebrow {
        height: 1;
        color: $primary;
        text-style: bold;
    }
    .section-heading {
        margin-top: 2;
    }
    .field-label {
        height: 1;
        margin-top: 1;
        color: $label-text;
    }
    Input {
        height: 3;
        border: tall $field-border;
        background: $surface;
    }
    Input:focus, TextArea:focus {
        border: tall $primary;
    }
    .wrapped-field {
        height: 3;
        min-height: 3;
        border: tall $field-border;
        background: $surface;
    }
    .numeric-row {
        height: auto;
    }
    .numeric-field {
        width: 1fr;
        height: auto;
        margin-right: 1;
    }
    .numeric-field Input {
        width: 1fr;
    }
    Checkbox {
        margin-top: 1;
        color: $foreground;
    }
    .stage-row {
        height: 2;
        color: $stage-text;
    }
    #status {
        height: 2;
        margin-top: 1;
        color: $primary;
    }
    #prompt-label {
        height: 1;
        margin-bottom: 1;
        color: $label-text;
        text-style: bold;
    }
    #prompt {
        height: 1fr;
        min-height: 7;
        border: tall $field-border;
        background: $surface;
    }
    #actions {
        height: 3;
        margin: 1 0;
    }
    Button {
        margin-right: 1;
        min-width: 12;
    }
    #main-tabs, #workbench, #workspace, #workbench-tabs, #request-pane, #output-pane {
        height: 1fr;
    }
    #background-page, #options-page, #knowledge-page {
        height: 1fr;
        padding: 1 2;
    }
    #phase-tabs {
        height: 1fr;
        min-height: 7;
        border: tall $field-border;
        background: $surface;
    }
    #background-output-scroll, #knowledge-detail-scroll, #knowledge-graph-scroll {
        border: tall $field-border;
        background: $surface;
        padding: 1;
    }
    #background-output-scroll {
        height: 1fr;
        min-height: 8;
    }
    #knowledge-browser {
        height: 1fr;
        min-height: 8;
        margin-bottom: 1;
    }
    #knowledge-tree {
        width: 1fr;
        min-width: 24;
        border: tall $field-border;
        background: $surface;
    }
    #knowledge-detail-scroll {
        width: 2fr;
        height: 1fr;
    }
    #knowledge-graph-scroll {
        height: 10;
    }
    #knowledge-search-row, #topic-row {
        height: auto;
        min-height: 3;
        margin-bottom: 1;
    }
    #knowledge-search, #research-topic {
        width: 1fr;
        margin-right: 1;
    }
    #research-priority-field {
        width: 14;
        height: auto;
        margin-right: 1;
    }
    #research-topic-field {
        width: 1fr;
        height: auto;
    }
    #topic-buttons {
        width: auto;
        height: 3;
        margin-top: 2;
    }
    #background-status, #background-queue {
        height: auto;
        min-height: 2;
        margin-bottom: 1;
        color: $primary;
    }
    .stage-output-scroll {
        height: 1fr;
    }
    .stage-output {
        padding: 1 2;
    }
    ClarificationScreen {
        align: center middle;
    }
    #clarification-dialog {
        width: 70;
        max-width: 90%;
        height: auto;
        max-height: 80%;
        padding: 1 2 2 2;
        border: tall $primary;
        background: $surface;
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
        settings_path: str | Path | None = None,
        settings_overrides: dict[str, Any] | None = None,
        client: DaemonClient | None = None,
    ) -> None:
        super().__init__()
        self.register_theme(HALON_DARK_THEME)
        self.register_theme(HALON_LIGHT_THEME)
        self.theme = HALON_DARK_THEME.name
        self.settings = settings.copy()
        self.initial_prompt = initial_prompt
        self.settings_path = Path(settings_path).expanduser() if settings_path else None
        self.settings_overrides = settings_overrides or {}
        self.client = client
        if client is not None:
            client.on_event = self._receive_daemon_event
        self._run_id: int | None = None
        self._request_running = False
        self._last_answer = ""
        self._active_stage: int | None = None
        self._skipped_stages: set[int] = set()
        self._follow_stages = True
        self._programmatic_phase_tabs: list[str] = []
        self._stage_output_buffers = [""] * len(STAGE_LABELS)
        self._pending_stage_output: list[list[str]] = [[] for _ in STAGE_LABELS]
        self._background_output = ""
        self._background_status_text = "Idle"
        self._queue_text = "No research jobs"
        self._pending_background_tokens: list[str] = []
        self._knowledge_query = ""
        self._knowledge_topic_id: int | None = None
        self._knowledge_topics: list[dict[str, Any]] = []
        self._knowledge_sources: list[dict[str, Any]] = []
        self._knowledge_graph: list[dict[str, Any]] = []
        self._knowledge_tree_signature: tuple[Any, ...] | None = None

    # ==========================================================================
    # Layout
    # ==========================================================================

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with TabbedContent(id="main-tabs"):
            with TabPane("Workbench", id="workbench"):
                yield from self._compose_workbench_page()
            with TabPane("Background", id="background-page"):
                yield from self._compose_background_page()
            with TabPane("Options", id="options-page"):
                yield from self._compose_options_page()
            with TabPane("Knowledge", id="knowledge-page"):
                yield from self._compose_knowledge_page()
        yield Footer()

    def _compose_workbench_page(self) -> ComposeResult:
        with Horizontal(id="workspace"):
            with VerticalScroll(id="sidebar"):
                yield Static("PIPELINE", classes="eyebrow")
                for index, label in enumerate(STAGE_LABELS, start=1):
                    yield Static(f"WAIT  {label}", classes="stage-row", id=f"stage-row-{index}")
                yield Static("Ready", id="status")
            with TabbedContent(initial="request-pane", id="workbench-tabs"):
                with TabPane("Request", id="request-pane"):
                    with Vertical(id="content"):
                        yield Static("YOUR REQUEST", classes="eyebrow", id="prompt-label")
                        yield TextArea(self.initial_prompt, show_line_numbers=False, id="prompt")
                        with Horizontal(id="actions"):
                            yield Button("Run  Ctrl+R", id="run", variant="primary")
                            yield Button("Cancel", id="cancel", disabled=True)
                            yield Button("Clear", id="clear")
                            yield Button("Copy answer", id="copy", disabled=True)
                with TabPane("Output", id="output-pane"):
                    with TabbedContent(initial="final", id="phase-tabs"):
                        for index, title in enumerate(STAGE_TAB_TITLES, start=1):
                            with TabPane(f"{index} {title}", id=f"phase-{index}"):
                                with FollowingScroll(classes="stage-output-scroll"):
                                    yield Markdown(
                                        PHASE_WAITING_TEXT,
                                        classes="stage-output",
                                        id=f"stage-output-{index}",
                                    )
                        with TabPane("Final", id="final"):
                            with FollowingScroll(classes="stage-output-scroll"):
                                yield Markdown(FINAL_WAITING_TEXT, classes="stage-output", id="final-output")

    def _compose_background_page(self) -> ComposeResult:
        with Vertical():
            yield Static("BACKGROUND RESEARCH", classes="eyebrow")
            yield Static("Idle", id="background-status")
            yield Checkbox(
                "Enable idle research",
                value=self.settings["background_research_enabled"],
                id="background-enabled",
            )
            with Horizontal(id="topic-row"):
                with Vertical(id="research-topic-field"):
                    yield Label("Research topic", classes="field-label")
                    yield Input(placeholder="Topic to research", id="research-topic")
                with Vertical(id="research-priority-field"):
                    yield Label("Priority", classes="field-label")
                    yield Input(value="0", id="research-priority")
                with Horizontal(id="topic-buttons"):
                    yield Button("Queue topic", id="queue-topic")
                    yield Button("Research now", id="research-now", variant="primary")
            yield Static("QUEUE", classes="eyebrow")
            yield Static("No research jobs", id="background-queue")
            yield Static("MODEL OUTPUT", classes="eyebrow")
            with FollowingScroll(id="background-output-scroll"):
                yield Markdown(BACKGROUND_WAITING_TEXT, id="background-output")

    def _compose_options_page(self) -> ComposeResult:
        with VerticalScroll():
            yield Static("MODEL", classes="eyebrow")
            yield Label("GGUF model path", classes="field-label")
            yield TextArea(
                self.settings["model_path"],
                soft_wrap=True,
                classes="wrapped-field",
                id="model-path",
            )
            yield from self._number_fields(
                ("Context", "context-size", "context_size"),
                ("GPU layers", "gpu-layers", "gpu_layers"),
                ("Max tokens", "max-tokens", "max_tokens"),
                ("Temperature", "temperature", "temperature"),
            )

            yield Static("FOLDER ACCESS", classes="eyebrow section-heading")
            yield Label("Filesystem root", classes="field-label")
            yield TextArea(
                self.settings["filesystem_root"],
                soft_wrap=True,
                classes="wrapped-field",
                id="filesystem-root",
            )
            yield Checkbox(
                "Allow model to create and replace files (read-only when off)",
                value=self.settings["allow_file_writes"],
                id="allow-file-writes",
            )
            yield Checkbox(
                "Allow model to run project tests",
                value=self.settings["enable_test_execution"],
                id="enable-test-execution",
            )

            yield Static("TOOL LIMITS", classes="eyebrow section-heading")
            yield from self._number_fields(
                ("Max tool calls (1-10)", "max-tool-calls", "max_tool_calls"),
                ("Max search results (1-10)", "max-search-results", "max_search_results"),
            )

            yield Static("BACKGROUND RESEARCH", classes="eyebrow section-heading")
            yield from self._number_fields(
                ("Poll seconds", "background-poll-seconds", "background_poll_interval_seconds"),
                ("Refresh hours", "background-refresh-hours", "background_refresh_interval_hours"),
                ("Max tokens", "background-max-tokens", "background_max_tokens"),
                ("Queue cap", "background-queue-cap", "background_max_pending_jobs"),
            )
            yield Label("SQLite database", classes="field-label")
            yield TextArea(
                self.settings["knowledge_db_path"],
                soft_wrap=True,
                classes="wrapped-field",
                id="knowledge-db-path",
            )

            with Horizontal(classes="button-row"):
                yield Button("Apply", id="apply-options", variant="primary")
                yield Button("Save settings", id="save-options")

    def _compose_knowledge_page(self) -> ComposeResult:
        with Vertical(id="knowledge-page-content"):
            yield Static("KNOWLEDGE STORE", classes="eyebrow")
            yield Label("Search stored evidence", classes="field-label")
            with Horizontal(id="knowledge-search-row"):
                yield Input(placeholder="Press Enter to search", id="knowledge-search")
                yield Button("Search", id="search-knowledge")
                yield Button("Refresh", id="refresh-knowledge")
            with Horizontal(id="knowledge-browser"):
                yield Tree("Topics", id="knowledge-tree")
                with VerticalScroll(id="knowledge-detail-scroll"):
                    yield Markdown("Select a topic or search stored evidence.", id="knowledge-detail")
            yield Static("GRAPH RELATIONSHIPS", classes="eyebrow")
            with VerticalScroll(id="knowledge-graph-scroll"):
                yield Markdown("_No graph relationships yet._", id="knowledge-graph")

    def _number_fields(self, *fields: tuple[str, str, str]) -> ComposeResult:
        for row_start in range(0, len(fields), 2):
            with Horizontal(classes="numeric-row"):
                for label, input_id, setting in fields[row_start : row_start + 2]:
                    with Vertical(classes="numeric-field"):
                        yield Label(label, classes="field-label")
                        yield Input(value=str(self.settings[setting]), id=input_id)

    # ==========================================================================
    # App lifecycle and events
    # ==========================================================================

    def get_theme_variable_defaults(self) -> dict[str, str]:
        return HALON_DARK_VARIABLES

    def on_mount(self) -> None:
        self.query_one("#prompt", TextArea).focus()
        self.set_interval(0.15, self._flush_stage_output)
        self.query_one("#status", Static).update("Connecting to the daemon...")
        self.connect_daemon()

    def on_unmount(self) -> None:
        if self.client is not None:
            self.client.on_event = None
            self.client.close()

    def action_run_prompt(self) -> None:
        self._start_run()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "run":
            self._start_run()
        elif event.button.id == "cancel":
            self._cancel_run()
        elif event.button.id == "clear":
            self._clear_workbench()
        elif event.button.id == "copy":
            self._copy_answer()
        elif event.button.id == "apply-options":
            self._apply_settings()
        elif event.button.id == "save-options":
            self._save_settings()
        elif event.button.id == "queue-topic":
            self._queue_topic()
        elif event.button.id == "research-now":
            self._trigger_background_research()
        elif event.button.id == "search-knowledge":
            self._search_knowledge(self.query_one("#knowledge-search", Input).value)
        elif event.button.id == "refresh-knowledge":
            self._refresh_knowledge()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "knowledge-search":
            self._search_knowledge(event.value)
        elif event.input.id in ("research-topic", "research-priority"):
            self._queue_topic()

    def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        if event.checkbox.id == "background-enabled" and event.value != self.settings["background_research_enabled"]:
            self.settings = {**self.settings, "background_research_enabled": event.value}
            self._call_daemon("set_background_enabled", enabled=event.value)

    def on_tabbed_content_tab_activated(self, event: TabbedContent.TabActivated) -> None:
        if event.tabbed_content.id == "main-tabs":
            if event.pane.id == "background-page":
                self._render_background_page()
            elif event.pane.id == "knowledge-page":
                self._refresh_knowledge()
        elif event.tabbed_content.id == "phase-tabs":
            if event.pane.id in self._programmatic_phase_tabs:
                self._programmatic_phase_tabs.remove(event.pane.id)
            elif self._request_running:
                self._follow_stages = False

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        selected = event.node.data
        self._knowledge_query = ""
        self._knowledge_topic_id = selected if isinstance(selected, int) else None
        self._refresh_knowledge()

    # ==========================================================================
    # Settings
    # ==========================================================================

    def _collect_settings(self) -> dict[str, Any]:
        settings = self.settings.copy()
        settings.update(
            {
                "model_path": self.query_one("#model-path", TextArea).text,
                "context_size": self._int_setting("context-size"),
                "gpu_layers": self._int_setting("gpu-layers"),
                "max_tokens": self._int_setting("max-tokens"),
                "temperature": self._float_setting("temperature"),
                "filesystem_root": self.query_one("#filesystem-root", TextArea).text,
                "allow_file_writes": self.query_one("#allow-file-writes", Checkbox).value,
                "enable_test_execution": self.query_one("#enable-test-execution", Checkbox).value,
                "max_tool_calls": self._int_setting("max-tool-calls"),
                "max_search_results": self._int_setting("max-search-results"),
                "knowledge_db_path": self.query_one("#knowledge-db-path", TextArea).text,
                "background_research_enabled": self.query_one("#background-enabled", Checkbox).value,
                "background_poll_interval_seconds": self._int_setting("background-poll-seconds"),
                "background_refresh_interval_hours": self._int_setting("background-refresh-hours"),
                "background_max_tokens": self._int_setting("background-max-tokens"),
                "background_max_pending_jobs": self._int_setting("background-queue-cap"),
            }
        )
        return validate_settings(settings)

    def _apply_settings(self) -> bool:
        try:
            settings = self._collect_settings()
        except ValueError as error:
            self.notify(str(error), title="Invalid settings", severity="error")
            return False
        applied = self._call_daemon("apply_settings", settings=settings)
        if applied is None:
            return False
        self.settings = applied
        return True

    def _save_settings(self) -> None:
        try:
            settings = self._collect_settings()
        except ValueError as error:
            self.notify(str(error), title="Invalid settings", severity="error")
            return
        saved = self._call_daemon("save_settings", settings=settings)
        if saved is None:
            return
        self.settings = saved["settings"]
        self.notify(f"Settings saved to {saved['path']}.", title="SmartHarness")

    def _show_settings(self, settings: dict[str, Any]) -> None:
        self.settings = settings.copy()
        for selector, name in (
            ("model-path", "model_path"),
            ("filesystem-root", "filesystem_root"),
            ("knowledge-db-path", "knowledge_db_path"),
        ):
            self.query_one(f"#{selector}", TextArea).text = settings[name]
        for selector, name in (
            ("context-size", "context_size"),
            ("gpu-layers", "gpu_layers"),
            ("max-tokens", "max_tokens"),
            ("temperature", "temperature"),
            ("max-tool-calls", "max_tool_calls"),
            ("max-search-results", "max_search_results"),
            ("background-poll-seconds", "background_poll_interval_seconds"),
            ("background-refresh-hours", "background_refresh_interval_hours"),
            ("background-max-tokens", "background_max_tokens"),
            ("background-queue-cap", "background_max_pending_jobs"),
        ):
            self.query_one(f"#{selector}", Input).value = str(settings[name])
        for selector, name in (
            ("allow-file-writes", "allow_file_writes"),
            ("enable-test-execution", "enable_test_execution"),
            ("background-enabled", "background_research_enabled"),
        ):
            self.query_one(f"#{selector}", Checkbox).value = settings[name]

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
            raise ValueError(f"{selector.replace('-', ' ')} must be a number.") from error

    # ==========================================================================
    # Daemon connection
    # ==========================================================================

    @work(thread=True, exclusive=True, group="connect")
    def connect_daemon(self) -> None:
        try:
            if self.client is None:
                self.client = connect_to_daemon(
                    settings_path=self.settings_path,
                    on_event=self._receive_daemon_event,
                )
            if self.settings_overrides:
                self.client.call("apply_settings", settings=self.settings_overrides)
            status = self.client.call("status")
        except (OSError, DaemonError) as error:
            self.call_from_thread(self._show_daemon_error, str(error))
            return
        self.call_from_thread(self._show_daemon_status, status)

    def _show_daemon_error(self, message: str) -> None:
        self.query_one("#status", Static).update("Daemon unavailable")
        self.notify(message, title="SmartHarness daemon", severity="error", timeout=10)

    def _show_daemon_status(self, status: dict[str, Any]) -> None:
        self._show_settings(status["settings"])
        background = status["background"]
        self._background_output = background["output"]
        self._set_background_status(background["status"])
        run = status["run"]
        if run is None:
            self.query_one("#status", Static).update("Ready")
        else:
            # Another interface started this run, so show its progress so far.
            self._begin_run(run["run_id"])
            for label in run["progress"]:
                self._update_stage(label)
            for label, text in run["outputs"].items():
                self._append_stage_output(label, text)
        self._refresh_knowledge()
        self._refresh_queue()

    def _receive_daemon_event(self, event: str, data: dict[str, Any]) -> None:
        # Posting never blocks, so the reader thread stays free to deliver replies.
        self.post_message(DaemonEvent(event, data))

    def on_daemon_event(self, message: DaemonEvent) -> None:
        event, data = message.event, message.data
        if event == "run.started":
            if not self._request_running or self._run_id is None:
                self._begin_run(data["run_id"])
        elif event == "run.progress":
            self._update_stage(data["label"])
        elif event == "run.token":
            self._append_stage_output(data["label"], data["token"])
        elif event == "run.clarification":
            self._request_clarification(data["run_id"], data["clarification_id"], data["question"])
        elif event == "run.finished":
            self._finish_run(data["result"])
        elif event == "run.failed":
            self._fail_run(data["message"])
        elif event == "run.cancelled":
            self._cancelled_run()
        elif event == "background.status":
            self._set_background_status(data["message"])
        elif event == "background.token":
            self._append_background_token(data["token"])
        elif event == "queue.changed":
            self._refresh_queue()
        elif event == "knowledge.changed":
            self._refresh_knowledge()
        elif event == "settings.changed":
            self.settings = data["settings"]
            self.query_one("#background-enabled", Checkbox).value = self.settings["background_research_enabled"]
        elif event == DISCONNECTED_EVENT:
            if self._request_running:
                self._fail_run("The daemon closed the connection.")
            self._show_daemon_error("Lost the connection to the SmartHarness daemon.")

    def _call_daemon(self, method: str, **params: Any) -> Any:
        """Call the daemon from the interface thread and report a failure; returns None when it fails."""
        if self.client is None:
            self.notify("Not connected to the daemon yet.", title="SmartHarness", severity="warning")
            return None
        try:
            return self.client.call(method, **params)
        except DaemonError as error:
            self.notify(str(error), title="SmartHarness daemon", severity="error")
            return None

    # ==========================================================================
    # Foreground run
    # ==========================================================================

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

        if self._call_daemon("apply_settings", settings=settings) is None:
            return
        self.settings = settings
        self._begin_run(None)
        started = self._call_daemon("run", prompt=prompt, settings=settings)
        if started is None:
            self._stop_run("_The request could not start._", "WAIT", "Ready")
            return
        self._run_id = started["run_id"]

    def _begin_run(self, run_id: int | None) -> None:
        self._run_id = run_id
        self._reset_stages()
        self.query_one("#final-output", Markdown).update("_Working on your request..._")
        self._show_output_pane()
        self.query_one("#status", Static).update("Starting local model...")
        self._set_running(True)

    def _set_running(self, running: bool) -> None:
        self._request_running = running
        self.query_one("#run", Button).disabled = running
        self.query_one("#clear", Button).disabled = running
        self.query_one("#cancel", Button).disabled = not running
        self.query_one("#copy", Button).disabled = running or not self._last_answer

    def _cancel_run(self) -> None:
        if not self._request_running:
            return
        self._call_daemon("cancel", run_id=self._run_id)
        self.query_one("#cancel", Button).disabled = True
        self.query_one("#status", Static).update("Cancelling...")

    def _clear_workbench(self) -> None:
        if self._request_running:
            return
        self.query_one("#prompt", TextArea).text = ""
        self.query_one("#final-output", Markdown).update(FINAL_WAITING_TEXT)
        self._last_answer = ""
        self.query_one("#copy", Button).disabled = True
        self._reset_stages()
        self.query_one("#status", Static).update("Ready")

    def _copy_answer(self) -> None:
        if not self._last_answer:
            return
        self.copy_to_clipboard(self._last_answer)
        self.notify(
            "Sent the answer to the terminal clipboard. Terminals without OSC 52 support ignore it.",
            title="SmartHarness",
        )

    def _show_output_pane(self) -> None:
        # Focus moves too, or Textual switches back to the tab holding the focused prompt.
        self.query_one("#workbench-tabs", TabbedContent).active = "output-pane"
        self.query_one("#phase-tabs", TabbedContent).query_one(Tabs).focus()

    def _show_phase_tab(self, pane_id: str) -> None:
        tabs = self.query_one("#phase-tabs", TabbedContent)
        if tabs.active != pane_id:
            self._programmatic_phase_tabs.append(pane_id)
            tabs.active = pane_id

    def _set_stage_row(self, index: int, state: str) -> None:
        self.query_one(f"#stage-row-{index + 1}", Static).update(f"{state}  {STAGE_LABELS[index]}")

    def _reset_stages(self) -> None:
        self._active_stage = None
        self._skipped_stages.clear()
        self._follow_stages = True
        for index in range(len(STAGE_LABELS)):
            self._set_stage_row(index, "WAIT")
            self._stage_output_buffers[index] = ""
            self._pending_stage_output[index].clear()
            self.query_one(f"#stage-output-{index + 1}", Markdown).update(PHASE_WAITING_TEXT)
        self._show_phase_tab("final")

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
            new_text = "".join(pending)
            pending.clear()
            output = self.query_one(f"#stage-output-{index + 1}", Markdown)
            self._write_markdown(output, new_text, append=bool(self._stage_output_buffers[index]))
            self._stage_output_buffers[index] += new_text
        self._flush_background_output()

    def _write_markdown(self, output: Markdown, text: str, append: bool) -> None:
        if append:
            output.append(text)
        else:
            output.update(text)

    def _update_stage(self, label: str) -> None:
        self._flush_stage_output()
        if label == "Loading model":
            self.query_one("#status", Static).update("Loading local model...")
            return
        if label.startswith(SKIPPED_PREFIX) and label.removeprefix(SKIPPED_PREFIX) in STAGE_LABELS:
            skipped = STAGE_LABELS.index(label.removeprefix(SKIPPED_PREFIX))
            self._skipped_stages.add(skipped)
            self._set_stage_row(skipped, "SKIP")
            self.query_one(f"#stage-output-{skipped + 1}", Markdown).update(PHASE_SKIPPED_TEXT)
            return
        try:
            active = STAGE_LABELS.index(label)
        except ValueError:
            self.query_one("#status", Static).update(label)
            return
        self._active_stage = active
        for index in range(len(STAGE_LABELS)):
            if index in self._skipped_stages:
                continue
            self._set_stage_row(index, "DONE" if index < active else "NOW " if index == active else "WAIT")
        if self._follow_stages:
            self._show_phase_tab(f"phase-{active + 1}")
        self.query_one("#status", Static).update(f"Stage {active + 1} of {len(STAGE_LABELS)}")

    def _finish_run(self, result: str) -> None:
        self._flush_stage_output()
        self._last_answer = result
        self._set_running(False)
        self.query_one("#final-output", Markdown).update(result)
        self._show_phase_tab("final")
        for index in range(len(STAGE_LABELS)):
            self._set_stage_row(index, "SKIP" if index in self._skipped_stages else "DONE")
        self.query_one("#status", Static).update("Complete")

    def _stop_run(self, final_text: str, stage_state: str, status: str) -> None:
        self._flush_stage_output()
        self._set_running(False)
        self.query_one("#final-output", Markdown).update(final_text)
        self._show_phase_tab("final")
        if self._active_stage is not None:
            self._set_stage_row(self._active_stage, stage_state)
        self.query_one("#status", Static).update(status)

    def _fail_run(self, message: str) -> None:
        self._stop_run(f"**Run failed**\n\n{message}", "FAIL", "Run failed")
        self.notify(message, title="SmartHarness error", severity="error", timeout=8)

    def _cancelled_run(self) -> None:
        self._stop_run("_Run cancelled._", "STOP", "Cancelled")

    def _request_clarification(self, run_id: int, clarification_id: int, question: str) -> None:
        def on_dismiss(value: str | None) -> None:
            self._call_daemon(
                "answer_clarification",
                run_id=run_id,
                clarification_id=clarification_id,
                answer=value or "",
            )

        self.push_screen(ClarificationScreen(question), on_dismiss)

    # ==========================================================================
    # Background research
    # ==========================================================================

    def _queue_topic(self) -> bool:
        topic = self.query_one("#research-topic", Input).value.strip()
        if not topic:
            self.notify("Enter a topic to research.", title="Topic required", severity="warning")
            return False
        try:
            priority = int(self.query_one("#research-priority", Input).value)
        except ValueError:
            self.notify("Priority must be an integer.", title="Could not queue topic", severity="error")
            return False
        if self._call_daemon("queue_topic", topic=topic, priority=priority) is None:
            return False
        self.query_one("#research-topic", Input).value = ""
        return True

    def _trigger_background_research(self) -> None:
        topic = self.query_one("#research-topic", Input).value.strip()
        if topic and not self._queue_topic():
            return
        self._call_daemon("research_now")

    @work(thread=True, exclusive=True, group="queue")
    def _refresh_queue(self) -> None:
        if self.client is None:
            return
        try:
            jobs = self.client.call("queue_status")
        except DaemonError:
            jobs = []
        self.call_from_thread(self._show_queue, jobs)

    def _show_queue(self, jobs: list[dict[str, Any]]) -> None:
        if not jobs:
            text = "No research jobs"
        else:
            text = "\n".join(
                f"{job['status'].upper():8} {job['topic']}"
                + (f"  ({job['error']})" if job["error"] else "")
                for job in jobs[:20]
            )
        self._queue_text = text
        try:
            self.query_one("#background-queue", Static).update(text)
        except NoMatches:
            pass

    def _set_background_status(self, message: str) -> None:
        self._background_status_text = message
        starting_search = message.startswith("Searching:")
        if starting_search:
            self._background_output = ""
            self._pending_background_tokens.clear()
        try:
            self.query_one("#background-status", Static).update(message)
            if starting_search:
                self.query_one("#background-output", Markdown).update("_Searching and summarizing..._")
        except NoMatches:
            pass

    def _render_background_page(self) -> None:
        self.query_one("#background-status", Static).update(self._background_status_text)
        self.query_one("#background-queue", Static).update(self._queue_text)
        self.query_one("#background-output", Markdown).update(self._background_output or BACKGROUND_WAITING_TEXT)
        self._refresh_queue()

    def _append_background_token(self, token: str) -> None:
        self._pending_background_tokens.append(token)

    def _flush_background_output(self) -> None:
        if not self._pending_background_tokens:
            return
        new_text = "".join(self._pending_background_tokens)
        self._pending_background_tokens.clear()
        try:
            output = self.query_one("#background-output", Markdown)
        except NoMatches:
            self._background_output += new_text
            return
        self._write_markdown(output, new_text, append=bool(self._background_output))
        self._background_output += new_text

    # ==========================================================================
    # Knowledge browser
    # ==========================================================================

    def _search_knowledge(self, query: str) -> None:
        self._knowledge_query = query.strip()
        self._knowledge_topic_id = None
        self._refresh_knowledge()

    def _refresh_knowledge(self) -> None:
        self.load_knowledge(self._knowledge_query, self._knowledge_topic_id)

    @work(thread=True, exclusive=True, group="knowledge")
    def load_knowledge(self, query: str, topic_id: int | None) -> None:
        if self.client is None:
            return
        try:
            knowledge = self.client.call("knowledge", query=query, topic_id=topic_id)
        except DaemonError:
            return
        self.call_from_thread(self._show_knowledge, knowledge["topics"], knowledge["sources"], knowledge["graph"])

    def _show_knowledge(
        self,
        topics: list[dict[str, Any]],
        sources: list[dict[str, Any]],
        graph: list[dict[str, Any]],
    ) -> None:
        self._knowledge_topics = topics
        self._knowledge_sources = sources
        self._knowledge_graph = graph
        try:
            self._render_knowledge_tree()
            self._render_knowledge_sources()
            self._render_knowledge_graph()
        except NoMatches:
            pass

    def _render_knowledge_tree(self) -> None:
        topics = self._knowledge_topics
        signature = tuple(
            (topic["id"], topic["parent_id"], topic["name"], topic["source_count"]) for topic in topics
        )
        if signature == self._knowledge_tree_signature:
            return
        self._knowledge_tree_signature = signature

        tree = self.query_one("#knowledge-tree", Tree)
        expanded_ids = self._expanded_topic_ids(tree.root)
        tree.root.remove_children()
        by_id = {topic["id"]: topic for topic in topics}
        children: dict[int | None, list[dict[str, Any]]] = {}
        for topic in topics:
            children.setdefault(topic["parent_id"], []).append(topic)

        def add_topic(parent_node: Any, topic: dict[str, Any], visited: set[int]) -> None:
            visited.add(topic["id"])
            node = parent_node.add(
                f"{topic['name']}  ({topic['source_count']})",
                data=topic["id"],
                expand=topic["id"] in expanded_ids,
            )
            for child in children.get(topic["id"], []):
                if child["id"] not in visited:
                    add_topic(node, child, visited)

        visited: set[int] = set()
        for topic in children.get(None, []):
            add_topic(tree.root, topic, visited)
        for topic_id, topic in by_id.items():
            if topic_id not in visited:
                add_topic(tree.root, topic, visited)
        tree.root.expand()

    def _expanded_topic_ids(self, node: Any) -> set[int]:
        expanded: set[int] = set()
        for child in node.children:
            if child.is_expanded and isinstance(child.data, int):
                expanded.add(child.data)
            expanded |= self._expanded_topic_ids(child)
        return expanded

    def _render_knowledge_sources(self) -> None:
        detail = self.query_one("#knowledge-detail", Markdown)
        if not self._knowledge_sources:
            detail.update("_No matching stored evidence._")
            return
        entries = []
        for source in self._knowledge_sources:
            title = source.get("title") or source["url"]
            when = datetime.fromtimestamp(source["retrieved_at"]).strftime("%Y-%m-%d %H:%M")
            entries.append(
                f"### [{title}]({source['url']})\n"
                f"{source.get('topic') or 'Uncategorized'} | Retrieved {when}\n\n"
                f"{source.get('snippet', '')}\n\n"
                f"{source.get('summary', '')}"
            )
        detail.update("\n\n---\n\n".join(entries))

    def _render_knowledge_graph(self) -> None:
        edge_lines = [
            f"`{edge['source']}` -{edge['relation']}-> `{edge['target']}`"
            + (f" ([evidence]({edge['evidence_url']}))" if edge["evidence_url"] else "")
            for edge in self._knowledge_graph[:50]
        ]
        self.query_one("#knowledge-graph", Markdown).update(
            "\n\n".join(edge_lines) if edge_lines else "_No graph relationships yet._"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open the SmartHarness terminal interface.")
    parser.add_argument(
        "--settings",
        default=str(default_settings_path()),
        help="Path to the JSON settings file.",
    )
    args = parser.parse_args(argv)
    try:
        settings = load_settings(args.settings)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    SmartHarnessApp(settings, settings_path=args.settings).run()
    return 0
