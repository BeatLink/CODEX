import argparse
from datetime import datetime
from threading import Event
from threading import Lock
from pathlib import Path
from typing import Any

from textual import work
from textual.app import App, ComposeResult
from textual.css.query import NoMatches
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
    Tree,
)

from .pipeline import execute_pipeline
from .background import research_one_topic
from .knowledge import KnowledgeStore
from .settings import DEFAULT_SETTINGS_PATH, load_settings, save_settings, validate_settings


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
    #main-tabs, #workbench, #background-page, #knowledge-page {
        height: 1fr;
    }
    #background-output, #knowledge-detail, #knowledge-graph {
        height: 1fr;
        min-height: 8;
        border: tall #34473d;
        background: #141d19;
        padding: 1;
    }
    #knowledge-tree {
        width: 1fr;
        min-width: 24;
        border: tall #34473d;
        background: #141d19;
    }
    #knowledge-detail {
        width: 2fr;
    }
    #knowledge-graph {
        height: 10;
    }
    #background-settings, #knowledge-search-row, #topic-row, #knowledge-browser {
        height: auto;
        min-height: 3;
        margin-bottom: 1;
    }
    .compact-input {
        width: 1fr;
        margin-right: 1;
    }
    #background-status, #background-queue {
        height: auto;
        min-height: 2;
        margin-bottom: 1;
        color: #e5b85c;
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
        settings_path: str | Path | None = None,
    ) -> None:
        super().__init__()
        self.settings = settings.copy()
        self.initial_prompt = initial_prompt
        self.settings_path = Path(settings_path).expanduser() if settings_path else None
        self._request_running = False
        self._last_answer = ""
        self._stage_output_buffers = [""] * len(STAGE_LABELS)
        self._background_output = ""
        self._background_status_text = "Idle"
        self._queue_text = "No research jobs"
        self._pending_background_tokens: list[str] = []
        self._knowledge_topics: list[dict[str, Any]] = []
        self._knowledge_sources: list[dict[str, Any]] = []
        self._knowledge_graph: list[dict[str, Any]] = []
        self._worker_stop = Event()
        self._worker_wakeup = Event()
        self._background_run_requested = Event()
        self._model_lock = Lock()
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
            with TabbedContent(id="main-tabs"):
                with TabPane("Workbench", id="workbench"):
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
                with TabPane("Background", id="background-page"):
                    with VerticalScroll():
                        yield Static("BACKGROUND RESEARCH", classes="eyebrow")
                        yield Static("Idle", id="background-status")
                        with Horizontal(id="background-settings"):
                            yield Checkbox(
                                "Enable idle research",
                                value=self.settings["background_research_enabled"],
                                id="background-enabled",
                            )
                            yield Input(
                                value=str(self.settings["background_poll_interval_seconds"]),
                                placeholder="Poll seconds",
                                classes="compact-input",
                                id="background-poll-seconds",
                            )
                            yield Input(
                                value=str(self.settings["background_refresh_interval_hours"]),
                                placeholder="Refresh hours",
                                classes="compact-input",
                                id="background-refresh-hours",
                            )
                            yield Input(
                                value=str(self.settings["background_max_tokens"]),
                                placeholder="Max tokens",
                                classes="compact-input",
                                id="background-max-tokens",
                            )
                            yield Input(
                                value=str(self.settings["background_max_pending_jobs"]),
                                placeholder="Queue cap",
                                classes="compact-input",
                                id="background-queue-cap",
                            )
                        yield Label("SQLite database", classes="field-label")
                        yield Input(value=self.settings["knowledge_db_path"], id="knowledge-db-path")
                        with Horizontal(classes="button-row"):
                            yield Button("Apply", id="apply-background", variant="primary")
                            yield Button("Save settings", id="save-settings")
                        with Horizontal(id="topic-row"):
                            yield Input(placeholder="Research topic", id="research-topic")
                            yield Input(value="0", placeholder="Priority", id="research-priority")
                            yield Button("Queue topic", id="queue-topic")
                        with Horizontal(classes="button-row"):
                            yield Button("Research now", id="research-now", variant="primary")
                        yield Static("QUEUE", classes="eyebrow")
                        yield Static("No research jobs", id="background-queue")
                        yield Static("MODEL OUTPUT", classes="eyebrow")
                        yield Markdown("_Waiting for background work..._", id="background-output")
                with TabPane("Knowledge", id="knowledge-page"):
                    with Vertical(id="knowledge-page-content"):
                        yield Static("KNOWLEDGE STORE", classes="eyebrow")
                        with Horizontal(id="knowledge-search-row"):
                            yield Input(placeholder="Search stored evidence", id="knowledge-search")
                            yield Button("Search", id="search-knowledge")
                            yield Button("Refresh", id="refresh-knowledge")
                        with Horizontal(id="knowledge-browser"):
                            yield Tree("Topics", id="knowledge-tree")
                            yield Markdown("Select a topic or search stored evidence.", id="knowledge-detail")
                        yield Static("GRAPH RELATIONSHIPS", classes="eyebrow")
                        yield Markdown("_No graph relationships yet._", id="knowledge-graph")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#prompt", TextArea).focus()
        self.set_interval(0.15, self._flush_stage_output)
        self._refresh_knowledge()
        self._refresh_queue()
        self.run_background_worker()

    def on_unmount(self) -> None:
        self._worker_stop.set()
        self._worker_wakeup.set()

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
        elif event.button.id == "apply-background":
            self._apply_background_settings()
        elif event.button.id == "save-settings":
            self._save_settings()
        elif event.button.id == "queue-topic":
            self._queue_topic()
        elif event.button.id == "research-now":
            self._trigger_background_research()
        elif event.button.id == "search-knowledge":
            self._refresh_knowledge(query=self.query_one("#knowledge-search", Input).value)
        elif event.button.id == "refresh-knowledge":
            self._refresh_knowledge()

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
        self.settings = settings
        self._worker_wakeup.set()
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
                "knowledge_db_path": self.query_one("#knowledge-db-path", Input).value,
                "background_research_enabled": self.query_one("#background-enabled", Checkbox).value,
                "background_poll_interval_seconds": self._int_setting("background-poll-seconds"),
                "background_refresh_interval_hours": self._int_setting("background-refresh-hours"),
                "background_max_tokens": self._int_setting("background-max-tokens"),
                "background_max_pending_jobs": self._int_setting("background-queue-cap"),
            }
        )
        return validate_settings(settings)

    def _apply_background_settings(self) -> bool:
        try:
            self.settings = self._collect_settings()
        except ValueError as error:
            self.notify(str(error), title="Invalid settings", severity="error")
            return False
        self._worker_wakeup.set()
        status = "Waiting for prompt-free time" if self.settings["background_research_enabled"] else "Paused"
        self.query_one("#background-status", Static).update(status)
        return True

    def _save_settings(self) -> None:
        if not self._apply_background_settings():
            return
        path = self.settings_path or DEFAULT_SETTINGS_PATH
        try:
            self.settings = save_settings(path, self.settings)
        except (OSError, ValueError) as error:
            self.notify(str(error), title="Could not save settings", severity="error")
            return
        self.notify(f"Settings saved to {path}.", title="SmartHarness")

    def _queue_topic(self) -> bool:
        topic = self.query_one("#research-topic", Input).value.strip()
        if not topic:
            self.notify("Enter a topic to research.", title="Topic required", severity="warning")
            return False
        try:
            priority = int(self.query_one("#research-priority", Input).value)
            settings = self._collect_settings()
            store = KnowledgeStore(settings["knowledge_db_path"])
            store.enqueue_topic(
                topic,
                priority=priority,
                max_pending=settings["background_max_pending_jobs"],
            )
        except (OSError, ValueError) as error:
            self.notify(str(error), title="Could not queue topic", severity="error")
            return False
        self.settings = settings
        self.query_one("#research-topic", Input).value = ""
        self._refresh_queue()
        self._worker_wakeup.set()
        return True

    def _trigger_background_research(self) -> None:
        topic = self.query_one("#research-topic", Input).value.strip()
        if topic and not self._queue_topic():
            return
        try:
            jobs = KnowledgeStore(self.settings["knowledge_db_path"]).queue_status()
        except (OSError, ValueError, KeyError) as error:
            self.notify(str(error), title="Could not start research", severity="error")
            return
        if not any(job["status"] == "pending" for job in jobs):
            self.notify("Queue a topic before starting research.", title="No pending research", severity="warning")
            return
        self._background_run_requested.set()
        self._worker_wakeup.set()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "knowledge-search":
            self._refresh_knowledge(query=event.value)

    def on_tabbed_content_tab_activated(self, event: TabbedContent.TabActivated) -> None:
        if event.tabbed_content.id == "main-tabs":
            if event.pane.id == "background-page":
                self._render_background_page()
            elif event.pane.id == "knowledge-page":
                self._refresh_knowledge()

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

    def _refresh_queue(self) -> None:
        try:
            jobs = KnowledgeStore(self.settings["knowledge_db_path"]).queue_status()
        except (OSError, ValueError, KeyError):
            jobs = []
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

    def _refresh_knowledge(self, query: str = "", topic_id: int | None = None) -> None:
        try:
            store = KnowledgeStore(self.settings["knowledge_db_path"])
            topics = store.topics()
            sources = store.search(query) if query.strip() else store.sources(topic_id, limit=30)
            graph = store.graph()
        except (OSError, ValueError, KeyError):
            return

        self._knowledge_topics = topics
        self._knowledge_sources = sources
        self._knowledge_graph = graph
        try:
            self._render_knowledge()
        except NoMatches:
            pass

    def _render_knowledge(self) -> None:
        topics = self._knowledge_topics
        sources = self._knowledge_sources
        graph = self._knowledge_graph
        tree = self.query_one("#knowledge-tree", Tree)
        tree.root.remove_children()
        by_id = {topic["id"]: topic for topic in topics}
        children: dict[int | None, list[dict[str, Any]]] = {}
        for topic in topics:
            children.setdefault(topic["parent_id"], []).append(topic)

        def add_children(parent_node: Any, parent_id: int | None, visited: set[int]) -> None:
            for topic in children.get(parent_id, []):
                if topic["id"] in visited:
                    continue
                visited.add(topic["id"])
                node = parent_node.add(
                    f"{topic['name']}  ({topic['source_count']})", data=topic["id"]
                )
                add_children(node, topic["id"], visited)

        visited: set[int] = set()
        add_children(tree.root, None, visited)
        for topic_id_orphan, topic in by_id.items():
            if topic_id_orphan not in visited:
                node = tree.root.add(f"{topic['name']}  ({topic['source_count']})", data=topic_id_orphan)
                add_children(node, topic_id_orphan, visited)
        tree.root.expand()

        if sources:
            detail = []
            for source in sources:
                title = source.get("title") or source["url"]
                when = datetime.fromtimestamp(source["retrieved_at"]).strftime("%Y-%m-%d %H:%M")
                detail.append(
                    f"### [{title}]({source['url']})\n"
                    f"{source.get('topic') or 'Uncategorized'} | Retrieved {when}\n\n"
                    f"{source.get('snippet', '')}\n\n"
                    f"{source.get('summary', '')}"
                )
            self.query_one("#knowledge-detail", Markdown).update("\n\n---\n\n".join(detail))
        else:
            self.query_one("#knowledge-detail", Markdown).update("_No matching stored evidence._")

        edge_lines = [
            f"`{edge['source']}` -{edge['relation']}-> `{edge['target']}`"
            + (f" ([evidence]({edge['evidence_url']}))" if edge["evidence_url"] else "")
            for edge in graph[:50]
        ]
        self.query_one("#knowledge-graph", Markdown).update(
            "\n".join(edge_lines) if edge_lines else "_No graph relationships yet._"
        )

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        selected = event.node.data
        self._refresh_knowledge(topic_id=selected if isinstance(selected, int) else None)

    def _set_background_status(self, message: str) -> None:
        self._background_status_text = message
        if message.startswith("Searching:"):
            self._background_output = ""
            self._pending_background_tokens.clear()
        try:
            self.query_one("#background-status", Static).update(message)
        except NoMatches:
            pass
        try:
            if message.startswith("Searching:"):
                self.query_one("#background-output", Markdown).update("_Searching and summarizing..._")
        except NoMatches:
            pass

    def _render_background_page(self) -> None:
        self.query_one("#background-status", Static).update(self._background_status_text)
        self.query_one("#background-queue", Static).update(self._queue_text)
        self.query_one("#background-output", Markdown).update(
            self._background_output or "_Waiting for background work..._"
        )
        self._refresh_queue()

    def _append_background_token(self, token: str) -> None:
        self._pending_background_tokens.append(token)

    def _flush_background_output(self) -> None:
        if not self._pending_background_tokens:
            return
        self._background_output += "".join(self._pending_background_tokens)
        self._pending_background_tokens.clear()
        try:
            self.query_one("#background-output", Markdown).update(self._background_output)
        except NoMatches:
            pass

    @work(thread=True, exclusive=True)
    def run_background_worker(self) -> None:
        while not self._worker_stop.is_set():
            settings = self.settings.copy()
            manual_run_requested = self._background_run_requested.is_set()
            if not settings.get("background_research_enabled") and not manual_run_requested:
                self.call_from_thread(self._set_background_status, "Paused")
                wait_seconds = settings.get("background_poll_interval_seconds", 10)
            elif self._request_running:
                self.call_from_thread(self._set_background_status, "Foreground prompt active")
                wait_seconds = 1
            else:
                if manual_run_requested:
                    self._background_run_requested.clear()
                try:
                    store = KnowledgeStore(settings["knowledge_db_path"])
                    store.enqueue_due_topics(
                        settings["background_refresh_interval_hours"],
                        settings["background_max_pending_jobs"],
                    )
                    worked = research_one_topic(
                        settings,
                        on_progress=lambda message: self.call_from_thread(
                            self._set_background_status, message
                        ),
                        on_token=lambda token: self.call_from_thread(
                            self._append_background_token, token
                        ),
                        should_pause=lambda: self._request_running or self._worker_stop.is_set(),
                        model_lock=self._model_lock,
                    )
                    self.call_from_thread(self._flush_background_output)
                    self.call_from_thread(self._refresh_queue)
                    if worked:
                        self.call_from_thread(self._refresh_knowledge)
                        wait_seconds = 0.2
                    else:
                        self.call_from_thread(self._set_background_status, "Idle")
                        wait_seconds = settings["background_poll_interval_seconds"]
                except Exception as error:
                    self.call_from_thread(self._set_background_status, f"Worker error: {error}")
                    wait_seconds = settings.get("background_poll_interval_seconds", 10)
            self._worker_wakeup.wait(wait_seconds)
            self._worker_wakeup.clear()

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
        self._flush_background_output()

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
        self._worker_wakeup.set()

    def _fail_run(self, message: str) -> None:
        self._flush_stage_output()
        self._request_running = False
        self.query_one("#final-output", Markdown).update(f"**Run failed**\n\n{message}")
        self.query_one("#phase-tabs", TabbedContent).active = "final"
        self.query_one("#run", Button).disabled = False
        self.query_one("#status", Static).update("Run failed")
        self.notify(message, title="SmartHarness error", severity="error", timeout=8)
        self._worker_wakeup.set()

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
            with self._model_lock:
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
                    knowledge_db_path=settings["knowledge_db_path"],
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