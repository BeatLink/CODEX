import argparse
import re
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gtk, Pango  # noqa: E402

from .client import DISCONNECTED_EVENT, DaemonClient, DaemonError, connect_to_daemon  # noqa: E402
from .pipeline import MODE_PROGRESS_PREFIX, SKIPPED_PREFIX  # noqa: E402
from .settings import (  # noqa: E402
    MODE_CHOICES,
    default_settings_path,
    load_settings,
    mcp_servers_from_json,
    mcp_servers_to_json,
    validate_settings,
)
from .stages import (  # noqa: E402
    STAGE_LABELS,
    STAGE_TAB_TITLES,
    TASK_STEP_PREFIX,
    task_detail_markdown,
    task_tree_lines,
)


APPLICATION_ID = "org.smartharness.SmartHarness"
PHASE_WAITING_TEXT = "Waiting for this phase..."
PHASE_SKIPPED_TEXT = "Skipped: this request does not need this phase."
FINAL_WAITING_TEXT = "Your final response will appear here."
MODE_NAMES = {"auto": "Auto mode", "answer": "Answer mode", "draft": "Draft mode", "execute": "Execute mode"}
STEPS_WAITING_TEXT = "Each step of each task will appear here as it runs."
TASK_DETAIL_WAITING_TEXT = "Choose a task in the tree to see what it asks for and its result."
BACKGROUND_WAITING_TEXT = "Waiting for background work..."
OUTPUT_FLUSH_MILLISECONDS = 150
NOTICE_SECONDS = 8

# Each number field: (label, setting, lowest, highest, step, decimal places).
MODEL_NUMBER_FIELDS = (
    ("Context size", "context_size", 1, 1048576, 256, 0),
    ("GPU layers", "gpu_layers", -1, 1000, 1, 0),
    ("Max tokens", "max_tokens", 1, 1048576, 64, 0),
    ("Temperature", "temperature", 0, 5, 0.05, 2),
)
TREE_NUMBER_FIELDS = (
    ("Max task depth", "max_task_depth", 0, 6, 1, 0),
    ("Max tasks", "max_task_nodes", 1, 60, 1, 0),
)
TOOL_NUMBER_FIELDS = (
    ("Max tool calls", "max_tool_calls", 1, 10, 1, 0),
    ("Max search results", "max_search_results", 1, 10, 1, 0),
)
BACKGROUND_NUMBER_FIELDS = (
    ("Poll seconds", "background_poll_interval_seconds", 1, 3600, 1, 0),
    ("Refresh hours", "background_refresh_interval_hours", 1, 8760, 1, 0),
    ("Max tokens", "background_max_tokens", 32, 4096, 32, 0),
    ("Queue cap", "background_max_pending_jobs", 1, 1000, 1, 0),
    ("Prune after days", "background_prune_after_days", 1, 3650, 1, 0),
)
BACKGROUND_MODEL_NUMBER_FIELDS = (
    ("Context size (0 uses the main one)", "background_context_size", 0, 1048576, 256, 0),
    ("GPU layers", "background_gpu_layers", -1, 1000, 1, 0),
)
PATH_FIELDS = (
    ("GGUF model path", "model_path"),
    ("Filesystem root", "filesystem_root"),
    ("SQLite database", "knowledge_db_path"),
    ("Embedding GGUF model (empty searches by words only)", "embedding_model_path"),
    ("Background GGUF model (empty uses the main model)", "background_model_path"),
)
SWITCH_FIELDS = (
    ("Allow the model to create and replace files", "allow_file_writes"),
    ("Allow the model to run project tests", "enable_test_execution"),
)


# ==============================================================================
# Markdown rendering
# ==============================================================================

_INLINE_MARKDOWN = re.compile(
    r"(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))"
)
_HEADING = re.compile(r"(#{1,6})\s+(.*)")
_LIST_ITEM = re.compile(r"(\s*)([-*+]|\d+[.)])\s+(.*)")
_RULE = re.compile(r"\s*([-*_])(\s*\1){2,}\s*")
LINK_TAG_PREFIX = "link:"
LINK_SCHEMES = ("http://", "https://")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


def add_markdown_tags(buffer: Gtk.TextBuffer) -> None:
    buffer.create_tag("heading1", weight=Pango.Weight.BOLD, scale=1.5, pixels_above_lines=12)
    buffer.create_tag("heading2", weight=Pango.Weight.BOLD, scale=1.3, pixels_above_lines=10)
    buffer.create_tag("heading3", weight=Pango.Weight.BOLD, scale=1.1, pixels_above_lines=8)
    buffer.create_tag("bold", weight=Pango.Weight.BOLD)
    buffer.create_tag("italic", style=Pango.Style.ITALIC)
    buffer.create_tag("code", family="monospace")
    buffer.create_tag("code-block", family="monospace", left_margin=28, wrap_mode=Gtk.WrapMode.NONE)
    buffer.create_tag("list-item", left_margin=28, indent=-14)
    buffer.create_tag("quote", left_margin=28, style=Pango.Style.ITALIC)


def render_markdown(buffer: Gtk.TextBuffer, text: str) -> None:
    """Show common Markdown with text styles; anything else stays as written."""
    buffer.set_text("")
    in_code_block = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            _insert(buffer, line + "\n", "code-block")
            continue
        heading = _HEADING.fullmatch(line)
        list_item = _LIST_ITEM.fullmatch(line)
        if heading:
            _insert_inline(buffer, heading.group(2), f"heading{min(len(heading.group(1)), 3)}")
        elif _RULE.fullmatch(line):
            pass
        elif list_item:
            marker = "•" if list_item.group(2) in "-*+" else list_item.group(2)
            _insert_inline(buffer, f"{marker} {list_item.group(3)}", "list-item")
        elif line.startswith(">"):
            _insert_inline(buffer, line[1:].lstrip(), "quote")
        else:
            _insert_inline(buffer, line)
        _insert(buffer, "\n")


def _insert_inline(buffer: Gtk.TextBuffer, text: str, *line_tags: str) -> None:
    for part in _INLINE_MARKDOWN.split(text):
        if not part:
            continue
        link = _LINK.fullmatch(part)
        if link and link.group(2).startswith(LINK_SCHEMES):
            _insert(buffer, link.group(1), *line_tags, _link_tag(buffer, link.group(2)))
        elif link:
            _insert(buffer, f"{link.group(1)} ({link.group(2)})", *line_tags)
        elif part.startswith("**") and part.endswith("**") and len(part) > 4:
            _insert(buffer, part[2:-2], *line_tags, "bold")
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            _insert(buffer, part[1:-1], *line_tags, "code")
        elif part[0] in "*_" and part[-1] == part[0] and len(part) > 2:
            _insert(buffer, part[1:-1], *line_tags, "italic")
        else:
            _insert(buffer, part, *line_tags)


def _link_tag(buffer: Gtk.TextBuffer, url: str) -> str:
    # Each link gets its own tag named after its URL, so a click can find where it leads.
    name = LINK_TAG_PREFIX + url
    if buffer.get_tag_table().lookup(name) is None:
        buffer.create_tag(name, underline=Pango.Underline.SINGLE)
    return name


def link_at(view: Gtk.TextView, x: float, y: float) -> str | None:
    buffer_x, buffer_y = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, int(x), int(y))
    found, position = view.get_iter_at_location(buffer_x, buffer_y)
    if not found:
        return None
    for tag in position.get_tags():
        if tag.props.name and tag.props.name.startswith(LINK_TAG_PREFIX):
            return tag.props.name.removeprefix(LINK_TAG_PREFIX)
    return None


def _insert(buffer: Gtk.TextBuffer, text: str, *tags: str) -> None:
    if tags:
        buffer.insert_with_tags_by_name(buffer.get_end_iter(), text, *tags)
    else:
        buffer.insert(buffer.get_end_iter(), text)


# ==============================================================================
# Widgets
# ==============================================================================


class OutputView:
    """A read-only text view that keeps the newest text in sight unless the reader has scrolled up."""

    def __init__(self, text: str = "", monospace: bool = False) -> None:
        self.view = Gtk.TextView(
            editable=False,
            cursor_visible=False,
            monospace=monospace,
            wrap_mode=Gtk.WrapMode.WORD_CHAR,
            left_margin=12,
            right_margin=12,
            top_margin=12,
            bottom_margin=12,
        )
        add_markdown_tags(self.view.get_buffer())
        self.view.get_buffer().set_text(text)
        self.widget = Gtk.ScrolledWindow(child=self.view, hexpand=True, vexpand=True)
        self.widget.add_css_class("frame")
        self.following = True
        adjustment = self.widget.get_vadjustment()
        adjustment.connect("value-changed", self._on_scrolled)
        adjustment.connect("notify::upper", self._on_grown)
        click = Gtk.GestureClick()
        click.connect("released", self._on_clicked)
        self.view.add_controller(click)
        motion = Gtk.EventControllerMotion()
        motion.connect("motion", self._on_pointer_moved)
        self.view.add_controller(motion)

    @property
    def text(self) -> str:
        buffer = self.view.get_buffer()
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False)

    def set_text(self, text: str) -> None:
        self.view.get_buffer().set_text(text)

    def append(self, text: str) -> None:
        _insert(self.view.get_buffer(), text)

    def set_markdown(self, text: str) -> None:
        render_markdown(self.view.get_buffer(), text)

    def _on_clicked(self, _gesture: Gtk.GestureClick, _presses: int, x: float, y: float) -> None:
        # A drag that selected text is not a click on a link.
        if self.view.get_buffer().get_has_selection():
            return
        url = link_at(self.view, x, y)
        if url is not None:
            Gtk.UriLauncher.new(url).launch(self.view.get_root(), None, None, None)

    def _on_pointer_moved(self, _controller: Gtk.EventControllerMotion, x: float, y: float) -> None:
        self.view.set_cursor_from_name("pointer" if link_at(self.view, x, y) else "text")

    def _on_scrolled(self, adjustment: Gtk.Adjustment) -> None:
        self.following = adjustment.get_value() >= adjustment.get_upper() - adjustment.get_page_size() - 1

    def _on_grown(self, adjustment: Gtk.Adjustment, _parameter: Any) -> None:
        if self.following:
            adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())


def section_heading(text: str) -> Gtk.Label:
    label = Gtk.Label(xalign=0, margin_top=18, margin_bottom=6)
    label.set_markup(f"<b>{GLib.markup_escape_text(text)}</b>")
    return label


def field_label(text: str) -> Gtk.Label:
    label = Gtk.Label(label=text, xalign=0)
    label.add_css_class("dim-label")
    return label


class PhaseRow(Gtk.ListBoxRow):
    def __init__(self, page_name: str, state: Gtk.Label, title: str) -> None:
        super().__init__()
        self.page_name = page_name
        self.title = title
        box = Gtk.Box(spacing=8, margin_top=4, margin_bottom=4, margin_start=4, margin_end=4)
        box.append(state)
        box.append(Gtk.Label(label=title, xalign=0, wrap=True, hexpand=True))
        self.set_child(box)


class TaskRow(Gtk.ListBoxRow):
    def __init__(self, task_id: str, line: str) -> None:
        super().__init__()
        self.task_id = task_id
        label = Gtk.Label(label=line, xalign=0, wrap=True, margin_top=2, margin_bottom=2, margin_start=4, margin_end=4)
        label.add_css_class("monospace")
        self.set_child(label)


class TopicRow(Gtk.ListBoxRow):
    def __init__(self, text: str, topic_id: int | None, depth: int) -> None:
        super().__init__()
        self.topic_id = topic_id
        self.set_child(
            Gtk.Label(
                label=text,
                xalign=0,
                ellipsize=Pango.EllipsizeMode.END,
                margin_top=4,
                margin_bottom=4,
                margin_start=8 + depth * 16,
                margin_end=8,
            )
        )


class ClarificationDialog(Gtk.Window):
    """Asks the user the pipeline's clarification question; closing it counts as skipping."""

    def __init__(self, parent: Gtk.Window, question: str, on_answer: Callable[[str], None]) -> None:
        super().__init__(title="Clarification", transient_for=parent, modal=True, default_width=520)
        self._on_answer = on_answer
        self._answered = False
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin_top=18, margin_bottom=18, margin_start=18, margin_end=18)
        box.append(Gtk.Label(label=question, xalign=0, wrap=True, selectable=True))
        box.append(field_label("Your response"))
        self.answer = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR, top_margin=6, bottom_margin=6, left_margin=6, right_margin=6)
        answer_scroller = Gtk.ScrolledWindow(child=self.answer, min_content_height=90)
        answer_scroller.add_css_class("frame")
        box.append(answer_scroller)
        buttons = Gtk.Box(spacing=6, halign=Gtk.Align.END)
        skip = Gtk.Button(label="Skip")
        skip.connect("clicked", lambda _button: self._finish(""))
        submit = Gtk.Button(label="Continue")
        submit.add_css_class("suggested-action")
        submit.connect("clicked", lambda _button: self._finish(self._answer_text()))
        buttons.append(skip)
        buttons.append(submit)
        box.append(buttons)
        self.set_child(box)
        self.connect("close-request", self._on_close_request)
        self.answer.grab_focus()

    def _answer_text(self) -> str:
        buffer = self.answer.get_buffer()
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False).strip()

    def _finish(self, answer: str) -> None:
        if not self._answered:
            self._answered = True
            self._on_answer(answer)
        self.destroy()

    def _on_close_request(self, _window: Gtk.Window) -> bool:
        self._finish("")
        return False


# ==============================================================================
# Main window
# ==============================================================================


class SmartHarnessWindow(Gtk.ApplicationWindow):
    def __init__(
        self,
        application: Gtk.Application,
        settings: dict[str, Any],
        settings_path: str | Path | None = None,
        settings_overrides: dict[str, Any] | None = None,
        client: DaemonClient | None = None,
    ) -> None:
        super().__init__(application=application, title="SmartHarness", default_width=1200, default_height=820)
        self.settings = settings.copy()
        self.settings_path = Path(settings_path).expanduser() if settings_path else None
        self.settings_overrides = settings_overrides or {}
        self.client = client
        if client is not None:
            client.on_event = self._receive_daemon_event
        self._run_id: int | None = None
        self._request_running = False
        self._last_answer = ""
        self._active_stage: int | None = None
        self._run_mode = ""
        self._skipped_stages: set[int] = set()
        self._follow_stages = True
        self._showing_phase_programmatically = False
        self._pending_stage_output: list[list[str]] = [[] for _ in STAGE_LABELS]
        self._stage_output_started = [False] * len(STAGE_LABELS)
        self._runner = self.settings["runner"]
        self._unfinished_runs: list[dict[str, Any]] = []
        self._task_nodes: list[dict[str, Any]] = []
        self._chosen_task_id: str | None = None
        self._rebuilding_task_list = False
        self._pending_steps_output: list[str] = []
        self._steps_output_started = False
        self._last_step_label = ""
        self._pending_background_tokens: list[str] = []
        self._updating_background_switch = False
        self._knowledge_query = ""
        self._knowledge_topic_id: int | None = None
        self._knowledge_topics: list[dict[str, Any]] = []
        self._knowledge_sources: list[dict[str, Any]] = []
        self._knowledge_graph: list[dict[str, Any]] = []
        self._notice_timeout: int | None = None

        self.pages = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE, vexpand=True)
        self.pages.add_titled(self._build_workbench_page(), "workbench", "Workbench")
        self.pages.add_titled(self._build_background_page(), "background", "Background")
        self.pages.add_titled(self._build_options_page(), "options", "Options")
        self.pages.add_titled(self._build_knowledge_page(), "knowledge", "Knowledge")
        self.pages.connect("notify::visible-child-name", self._on_page_changed)

        header = Gtk.HeaderBar()
        header.set_title_widget(Gtk.StackSwitcher(stack=self.pages))
        self.set_titlebar(header)

        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        content.append(self._build_notice_bar())
        content.append(self.pages)
        self.set_child(content)

        shortcuts = Gtk.ShortcutController(scope=Gtk.ShortcutScope.GLOBAL)
        run_action = Gtk.CallbackAction.new(lambda *_arguments: self._start_run() or True)
        for trigger in ("<Control>r", "<Control>Return"):
            shortcuts.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string(trigger), run_action))
        self.add_controller(shortcuts)

        self.connect("close-request", self._on_close_request)
        GLib.timeout_add(OUTPUT_FLUSH_MILLISECONDS, self._flush_output)
        self.status.set_label("Connecting to the daemon...")
        threading.Thread(target=self._connect_daemon, name="daemon-connect", daemon=True).start()

    # ==========================================================================
    # Layout
    # ==========================================================================

    def _build_notice_bar(self) -> Gtk.Revealer:
        self.notice_label = Gtk.Label(xalign=0, hexpand=True, wrap=True, selectable=True)
        close = Gtk.Button(icon_name="window-close-symbolic")
        close.add_css_class("flat")
        close.connect("clicked", lambda _button: self.notice.set_reveal_child(False))
        bar = Gtk.Box(spacing=12, margin_top=6, margin_bottom=6, margin_start=12, margin_end=6)
        bar.append(self.notice_label)
        bar.append(close)
        self.notice = Gtk.Revealer(child=bar, reveal_child=False)
        return self.notice

    def _build_workbench_page(self) -> Gtk.Widget:
        sidebar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, margin_top=12, margin_bottom=12, margin_start=12, margin_end=12)
        self.sidebar_title = section_heading("Pipeline")
        sidebar.append(self.sidebar_title)
        # Each row shows a stage's state, and choosing it shows that stage's output.
        self.phase_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.phase_list.connect("row-selected", self._on_phase_selected)
        self.stage_states: list[Gtk.Label] = []
        for index, label in enumerate(STAGE_LABELS, start=1):
            state = Gtk.Label(label="WAIT", width_chars=5, xalign=0)
            state.add_css_class("monospace")
            self.stage_states.append(state)
            self.phase_list.append(PhaseRow(f"phase-{index}", state, label.split(": ", 1)[1]))
        self.phase_list.append(PhaseRow("steps", Gtk.Label(label="", width_chars=5, xalign=0), "Steps"))
        final_state = Gtk.Label(label="", width_chars=5, xalign=0)
        self.phase_list.append(PhaseRow("final", final_state, "Final answer"))
        sidebar.append(self.phase_list)
        # Each row is one task; choosing it shows that task's deliverable, state, and result.
        self.task_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE, margin_top=12)
        self.task_list.connect("row-selected", self._on_task_selected)
        sidebar.append(self.task_list)
        self.status = Gtk.Label(label="Ready", xalign=0, wrap=True, margin_top=12)
        sidebar.append(self.status)

        self.prompt = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR, top_margin=8, bottom_margin=8, left_margin=8, right_margin=8)
        prompt_scroller = Gtk.ScrolledWindow(child=self.prompt, vexpand=True, min_content_height=120)
        prompt_scroller.add_css_class("frame")
        self.mode_dropdown = Gtk.DropDown.new_from_strings([MODE_NAMES[mode] for mode in MODE_CHOICES])
        self.mode_dropdown.set_selected(MODE_CHOICES.index(self.settings["mode"]))
        self.mode_dropdown.set_tooltip_text("Answer a question, draft writing or a plan, or execute file changes")
        self.run_button = Gtk.Button(label="Run")
        self.run_button.set_tooltip_text("Run the request (Ctrl+R)")
        self.run_button.add_css_class("suggested-action")
        self.run_button.connect("clicked", lambda _button: self._start_run())
        self.cancel_button = Gtk.Button(label="Cancel", sensitive=False)
        self.cancel_button.connect("clicked", lambda _button: self._cancel_run())
        self.clear_button = Gtk.Button(label="Clear")
        self.clear_button.connect("clicked", lambda _button: self._clear_workbench())
        self.copy_button = Gtk.Button(label="Copy answer", sensitive=False)
        self.copy_button.connect("clicked", lambda _button: self._copy_answer())
        actions = Gtk.Box(spacing=6)
        actions.append(self.mode_dropdown)
        for button in (self.run_button, self.cancel_button, self.clear_button, self.copy_button):
            actions.append(button)
        request = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin_bottom=6)
        request.append(section_heading("Your request"))
        request.append(prompt_scroller)
        request.append(actions)
        request.append(self._build_resume_bar())

        self.phase_pages = Gtk.Stack(vexpand=True)
        self.stage_outputs: list[OutputView] = []
        for index, title in enumerate(STAGE_TAB_TITLES, start=1):
            output = OutputView(PHASE_WAITING_TEXT)
            self.stage_outputs.append(output)
            self.phase_pages.add_titled(output.widget, f"phase-{index}", f"{index} {title}")
        self.steps_output = OutputView(STEPS_WAITING_TEXT)
        self.phase_pages.add_titled(self.steps_output.widget, "steps", "Steps")
        self.task_detail = OutputView(TASK_DETAIL_WAITING_TEXT)
        self.phase_pages.add_titled(self.task_detail.widget, "task", "Task")
        self.final_output = OutputView(FINAL_WAITING_TEXT)
        self.phase_pages.add_titled(self.final_output.widget, "final", "Final")
        self.phase_title = section_heading("Final answer")
        output = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        output.append(self.phase_title)
        output.append(self.phase_pages)

        work_area = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL, start_child=request, end_child=output, position=240)
        work_area.set_margin_top(12)
        work_area.set_margin_bottom(12)
        work_area.set_margin_end(12)
        self._show_runner(self._runner)
        self._show_phase("final")
        sidebar_scroller = Gtk.ScrolledWindow(child=sidebar, hscrollbar_policy=Gtk.PolicyType.NEVER)
        return Gtk.Paned(start_child=sidebar_scroller, end_child=work_area, position=300, shrink_start_child=False)

    def _build_resume_bar(self) -> Gtk.Widget:
        """A row offering to resume the newest task tree run that a crash, restart, or cancel left unfinished."""
        self.resume_label = Gtk.Label(xalign=0, hexpand=True, wrap=True)
        self.resume_button = Gtk.Button(label="Resume")
        self.resume_button.add_css_class("suggested-action")
        self.resume_button.connect("clicked", lambda _button: self._resume_run())
        self.discard_button = Gtk.Button(label="Discard")
        self.discard_button.connect("clicked", lambda _button: self._discard_run())
        self.resume_bar = Gtk.Box(spacing=6, visible=False)
        for widget in (self.resume_label, self.resume_button, self.discard_button):
            self.resume_bar.append(widget)
        return self.resume_bar

    def _build_background_page(self) -> Gtk.Widget:
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin_top=12, margin_bottom=12, margin_start=12, margin_end=12)
        page.append(section_heading("Background research"))
        self.background_status = Gtk.Label(label="Idle", xalign=0, wrap=True)
        page.append(self.background_status)
        enabled_row = Gtk.Box(spacing=12, margin_top=6)
        self.background_switch = Gtk.Switch(active=self.settings["background_research_enabled"], valign=Gtk.Align.CENTER)
        self.background_switch.connect("notify::active", self._on_background_switch)
        enabled_row.append(self.background_switch)
        enabled_row.append(Gtk.Label(label="Enable idle research", xalign=0))
        page.append(enabled_row)

        topic_row = Gtk.Box(spacing=6, margin_top=6)
        self.research_topic = Gtk.Entry(placeholder_text="Topic to research", hexpand=True)
        self.research_topic.connect("activate", lambda _entry: self._queue_topic())
        self.research_priority = Gtk.SpinButton.new_with_range(-1000, 1000, 1)
        self.research_priority.set_value(0)
        self.research_priority.set_tooltip_text("Priority")
        queue_button = Gtk.Button(label="Queue topic")
        queue_button.connect("clicked", lambda _button: self._queue_topic())
        research_button = Gtk.Button(label="Research now")
        research_button.add_css_class("suggested-action")
        research_button.connect("clicked", lambda _button: self._trigger_background_research())
        topic_row.append(self.research_topic)
        topic_row.append(field_label("Priority"))
        topic_row.append(self.research_priority)
        topic_row.append(queue_button)
        topic_row.append(research_button)
        page.append(topic_row)

        page.append(section_heading("Queue"))
        self.queue_label = Gtk.Label(label="No research jobs", xalign=0, yalign=0, selectable=True, wrap=True)
        self.queue_label.add_css_class("monospace")
        queue_scroller = Gtk.ScrolledWindow(child=self.queue_label, min_content_height=120, max_content_height=220, propagate_natural_height=True)
        page.append(queue_scroller)
        page.append(section_heading("Model output"))
        self.background_output = OutputView(BACKGROUND_WAITING_TEXT)
        page.append(self.background_output.widget)
        return page

    def _build_options_page(self) -> Gtk.Widget:
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin_top=12, margin_bottom=12, margin_start=12, margin_end=12)
        self.path_entries: dict[str, Gtk.Entry] = {}
        self.number_fields: dict[str, Gtk.SpinButton] = {}
        self.switches: dict[str, Gtk.Switch] = {}

        page.append(section_heading("Model"))
        page.append(self._path_field("model_path"))
        page.append(self._number_grid(MODEL_NUMBER_FIELDS))
        page.append(section_heading("Folder access"))
        page.append(self._path_field("filesystem_root"))
        for label, name in SWITCH_FIELDS:
            row = Gtk.Box(spacing=12, margin_top=6)
            self.switches[name] = Gtk.Switch(active=self.settings[name], valign=Gtk.Align.CENTER)
            row.append(self.switches[name])
            row.append(Gtk.Label(label=label, xalign=0))
            page.append(row)
        page.append(section_heading("How requests run"))
        row = Gtk.Box(spacing=12, margin_top=6)
        self.tree_switch = Gtk.Switch(active=self.settings["runner"] == "tree", valign=Gtk.Align.CENTER)
        row.append(self.tree_switch)
        row.append(Gtk.Label(label="Work requests as a task tree (off runs the fixed eight-stage pipeline)", xalign=0, wrap=True))
        page.append(row)
        page.append(self._number_grid(TREE_NUMBER_FIELDS))
        page.append(section_heading("Tool limits"))
        page.append(self._number_grid(TOOL_NUMBER_FIELDS))
        page.append(section_heading("Background research"))
        page.append(self._number_grid(BACKGROUND_NUMBER_FIELDS))
        page.append(self._path_field("knowledge_db_path"))
        page.append(self._path_field("embedding_model_path"))
        page.append(self._path_field("background_model_path"))
        page.append(self._number_grid(BACKGROUND_MODEL_NUMBER_FIELDS))
        page.append(section_heading("MCP servers"))
        page.append(field_label("A JSON list of servers; see the README for the fields each one needs."))
        self.mcp_servers = Gtk.TextView(monospace=True, wrap_mode=Gtk.WrapMode.WORD_CHAR, top_margin=8, bottom_margin=8, left_margin=8, right_margin=8)
        self.mcp_servers.get_buffer().set_text(mcp_servers_to_json(self.settings["mcp_servers"]))
        mcp_scroller = Gtk.ScrolledWindow(child=self.mcp_servers, min_content_height=160)
        mcp_scroller.add_css_class("frame")
        page.append(mcp_scroller)

        buttons = Gtk.Box(spacing=6, margin_top=18)
        apply_button = Gtk.Button(label="Apply")
        apply_button.add_css_class("suggested-action")
        apply_button.connect("clicked", lambda _button: self._apply_settings())
        save_button = Gtk.Button(label="Save settings")
        save_button.connect("clicked", lambda _button: self._save_settings())
        auto_size_button = Gtk.Button(label="Auto size")
        auto_size_button.connect("clicked", lambda _button: self._auto_size())
        buttons.append(apply_button)
        buttons.append(save_button)
        buttons.append(auto_size_button)
        page.append(buttons)
        return Gtk.ScrolledWindow(child=page, hscrollbar_policy=Gtk.PolicyType.NEVER)

    def _path_field(self, name: str) -> Gtk.Widget:
        label = dict((setting, text) for text, setting in PATH_FIELDS)[name]
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, margin_top=6)
        box.append(field_label(label))
        self.path_entries[name] = Gtk.Entry(text=self.settings[name], hexpand=True)
        box.append(self.path_entries[name])
        return box

    def _number_grid(self, fields: tuple[tuple[str, str, float, float, float, int], ...]) -> Gtk.Widget:
        grid = Gtk.Grid(column_spacing=12, row_spacing=4, column_homogeneous=True, margin_top=6)
        for position, (label, name, lowest, highest, step, digits) in enumerate(fields):
            column, row = position % 2, (position // 2) * 2
            spin = Gtk.SpinButton.new_with_range(lowest, highest, step)
            spin.set_digits(digits)
            spin.set_value(self.settings[name])
            self.number_fields[name] = spin
            grid.attach(field_label(label), column, row, 1, 1)
            grid.attach(spin, column, row + 1, 1, 1)
        return grid

    def _build_knowledge_page(self) -> Gtk.Widget:
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin_top=12, margin_bottom=12, margin_start=12, margin_end=12)
        page.append(section_heading("Knowledge store"))
        search_row = Gtk.Box(spacing=6)
        self.knowledge_search = Gtk.SearchEntry(placeholder_text="Search stored evidence", hexpand=True)
        self.knowledge_search.connect("activate", lambda entry: self._search_knowledge(entry.get_text()))
        search_button = Gtk.Button(label="Search")
        search_button.connect("clicked", lambda _button: self._search_knowledge(self.knowledge_search.get_text()))
        refresh_button = Gtk.Button(label="Refresh")
        refresh_button.connect("clicked", lambda _button: self._refresh_knowledge())
        search_row.append(self.knowledge_search)
        search_row.append(search_button)
        search_row.append(refresh_button)
        page.append(search_row)

        self.topic_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.topic_list.connect("row-activated", self._on_topic_activated)
        topic_scroller = Gtk.ScrolledWindow(child=self.topic_list, hscrollbar_policy=Gtk.PolicyType.NEVER)
        topic_scroller.add_css_class("frame")
        self.knowledge_detail = OutputView("Select a topic or search stored evidence.")
        browser = Gtk.Paned(start_child=topic_scroller, end_child=self.knowledge_detail.widget, position=320, vexpand=True)
        page.append(browser)
        page.append(section_heading("Graph relationships"))
        self.knowledge_graph = OutputView("No graph relationships yet.")
        self.knowledge_graph.widget.set_vexpand(False)
        self.knowledge_graph.widget.set_size_request(-1, 160)
        page.append(self.knowledge_graph.widget)
        return page

    # ==========================================================================
    # Window events
    # ==========================================================================

    def _on_close_request(self, _window: Gtk.Window) -> bool:
        if self.client is not None:
            self.client.on_event = None
            self.client.close()
        return False

    def _on_page_changed(self, stack: Gtk.Stack, _parameter: Any) -> None:
        if stack.get_visible_child_name() == "background":
            self._refresh_queue()
        elif stack.get_visible_child_name() == "knowledge":
            self._refresh_knowledge()

    def _on_phase_selected(self, _list: Gtk.ListBox, row: "PhaseRow | None") -> None:
        if row is None:
            return
        if not self._rebuilding_task_list:
            # A stage or step page replaces the task view, so no task stays chosen.
            self._rebuilding_task_list = True
            self.task_list.unselect_all()
            self._rebuilding_task_list = False
        self.phase_pages.set_visible_child_name(row.page_name)
        self.phase_title.set_markup(f"<b>{GLib.markup_escape_text(row.title)}</b>")
        if not self._showing_phase_programmatically and self._request_running:
            self._follow_stages = False

    def notify_user(self, message: str) -> None:
        self.notice_label.set_label(message)
        self.notice.set_reveal_child(True)
        if self._notice_timeout is not None:
            GLib.source_remove(self._notice_timeout)
        self._notice_timeout = GLib.timeout_add_seconds(NOTICE_SECONDS, self._hide_notice)

    def _hide_notice(self) -> bool:
        self._notice_timeout = None
        self.notice.set_reveal_child(False)
        return False

    # ==========================================================================
    # Daemon connection
    # ==========================================================================

    def _connect_daemon(self) -> None:
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
            GLib.idle_add(self._show_daemon_error, str(error))
            return
        GLib.idle_add(self._show_daemon_status, status)

    def _show_daemon_error(self, message: str) -> None:
        self.status.set_label("Daemon unavailable")
        self.notify_user(message)

    def _show_daemon_status(self, status: dict[str, Any]) -> None:
        self._show_settings(status["settings"])
        background = status["background"]
        self.background_output.set_text(background["output"] or BACKGROUND_WAITING_TEXT)
        self._set_background_status(background["status"])
        run = status["run"]
        if run is None:
            self.status.set_label("Ready")
        else:
            # Another interface started this run, so show its progress so far.
            self._begin_run(run["run_id"], run["runner"])
            if run["runner"] == "tree":
                self._show_task_tree(run["tree"])
                for label, text in run["outputs"].items():
                    self._append_stage_output(label, text)
                if run["progress"]:
                    self._update_stage(run["progress"][-1])
            else:
                for label in run["progress"]:
                    self._update_stage(label)
                for label, text in run["outputs"].items():
                    self._append_stage_output(label, text)
        self._show_unfinished_runs(status["unfinished_runs"])
        self._refresh_knowledge()
        self._refresh_queue()

    def _receive_daemon_event(self, event: str, data: dict[str, Any]) -> None:
        GLib.idle_add(self._handle_daemon_event, event, data)

    def _handle_daemon_event(self, event: str, data: dict[str, Any]) -> None:
        if event == "run.started":
            if not self._request_running or self._run_id is None:
                self._begin_run(data["run_id"], data.get("runner", "pipeline"))
        elif event == "run.tree":
            self._show_task_tree(data["nodes"])
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
            self._stop_run("Run cancelled.", "STOP", "Cancelled")
        elif event == "background.status":
            self._set_background_status(data["message"])
        elif event == "background.token":
            self._pending_background_tokens.append(data["token"])
        elif event == "queue.changed":
            self._refresh_queue()
        elif event == "runs.changed":
            self._call_daemon("unfinished_runs", self._show_unfinished_runs)
        elif event == "knowledge.changed":
            self._refresh_knowledge()
        elif event == "settings.changed":
            self.settings = data["settings"]
            self._set_background_switch(self.settings["background_research_enabled"])
        elif event == DISCONNECTED_EVENT:
            if self._request_running:
                self._fail_run("The daemon closed the connection.")
            self._show_daemon_error("Lost the connection to the SmartHarness daemon.")

    def _call_daemon(
        self,
        method: str,
        on_result: Callable[[Any], None] | None = None,
        on_error: Callable[[str], None] | None = None,
        **params: Any,
    ) -> None:
        """Call the daemon on a worker thread and hand the reply back to the interface thread."""
        client = self.client
        if client is None:
            self.notify_user("Not connected to the daemon yet.")
            if on_error is not None:
                on_error("Not connected to the daemon yet.")
            return

        def call() -> None:
            try:
                result = client.call(method, **params)
            except DaemonError as error:
                GLib.idle_add(self.notify_user, str(error))
                if on_error is not None:
                    GLib.idle_add(on_error, str(error))
                return
            if on_result is not None:
                GLib.idle_add(on_result, result)

        threading.Thread(target=call, name=f"daemon-{method}", daemon=True).start()

    # ==========================================================================
    # Settings
    # ==========================================================================

    def _collect_settings(self) -> dict[str, Any]:
        settings = self.settings.copy()
        for name, entry in self.path_entries.items():
            settings[name] = entry.get_text()
        for name, spin in self.number_fields.items():
            settings[name] = spin.get_value() if spin.get_digits() else spin.get_value_as_int()
        for name, switch in self.switches.items():
            settings[name] = switch.get_active()
        settings["background_research_enabled"] = self.background_switch.get_active()
        settings["runner"] = "tree" if self.tree_switch.get_active() else "pipeline"
        buffer = self.mcp_servers.get_buffer()
        settings["mcp_servers"] = mcp_servers_from_json(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False))
        settings["mode"] = MODE_CHOICES[self.mode_dropdown.get_selected()]
        return validate_settings(settings)

    def _show_settings(self, settings: dict[str, Any]) -> None:
        self.settings = settings.copy()
        for name, entry in self.path_entries.items():
            entry.set_text(settings[name])
        for name, spin in self.number_fields.items():
            spin.set_value(settings[name])
        for name, switch in self.switches.items():
            switch.set_active(settings[name])
        self.tree_switch.set_active(settings["runner"] == "tree")
        self.mcp_servers.get_buffer().set_text(mcp_servers_to_json(settings["mcp_servers"]))
        self._set_background_switch(settings["background_research_enabled"])
        self.mode_dropdown.set_selected(MODE_CHOICES.index(settings["mode"]))
        if not self._request_running:
            self._show_runner(settings["runner"])

    def _apply_settings(self) -> None:
        try:
            settings = self._collect_settings()
        except ValueError as error:
            self.notify_user(f"Invalid settings: {error}")
            return
        self._call_daemon("apply_settings", self._show_settings, settings=settings)

    def _save_settings(self) -> None:
        try:
            settings = self._collect_settings()
        except ValueError as error:
            self.notify_user(f"Invalid settings: {error}")
            return

        def saved(result: dict[str, Any]) -> None:
            self._show_settings(result["settings"])
            self.notify_user(f"Settings saved to {result['path']}.")

        self._call_daemon("save_settings", saved, settings=settings)

    def _auto_size(self) -> None:
        """Fill the context and token limits from the model file and free memory, ready to apply or save."""

        def fill(choice: dict[str, Any]) -> None:
            for name in ("context_size", "max_tokens", "background_max_tokens", "background_context_size"):
                self.number_fields[name].set_value(choice[name])
            self.notify_user(
                f"{choice['explanation']}. Context {choice['context_size']}, max tokens {choice['max_tokens']},"
                f" background context {choice['background_context_size']},"
                f" background max tokens {choice['background_max_tokens']}. Apply or save to use them."
            )

        self._call_daemon(
            "auto_size",
            fill,
            model_path=self.path_entries["model_path"].get_text().strip(),
            gpu_layers=self.number_fields["gpu_layers"].get_value_as_int(),
            background_model_path=self.path_entries["background_model_path"].get_text().strip(),
            background_gpu_layers=self.number_fields["background_gpu_layers"].get_value_as_int(),
        )

    def _set_background_switch(self, active: bool) -> None:
        self._updating_background_switch = True
        self.background_switch.set_active(active)
        self._updating_background_switch = False

    def _on_background_switch(self, switch: Gtk.Switch, _parameter: Any) -> None:
        if self._updating_background_switch:
            return
        self._call_daemon("set_background_enabled", enabled=switch.get_active())

    # ==========================================================================
    # Foreground run
    # ==========================================================================

    def _prompt_text(self) -> str:
        buffer = self.prompt.get_buffer()
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False).strip()

    def _start_run(self) -> None:
        if self._request_running:
            return
        prompt = self._prompt_text()
        if not prompt:
            self.notify_user("Enter a prompt before running.")
            self.prompt.grab_focus()
            return
        try:
            settings = self._collect_settings()
        except ValueError as error:
            self.notify_user(f"Invalid settings: {error}")
            return
        self._begin_run(None, settings["runner"])

        def started(result: dict[str, Any]) -> None:
            self._run_id = result["run_id"]

        def failed(_message: str) -> None:
            self._stop_run("The request could not start.", "WAIT", "Ready")

        def applied(_settings: dict[str, Any]) -> None:
            self.settings = settings
            self._call_daemon("run", started, failed, prompt=prompt, settings=settings)

        self._call_daemon("apply_settings", applied, failed, settings=settings)

    def _begin_run(self, run_id: int | None, runner: str) -> None:
        self._run_id = run_id
        self._show_runner(runner)
        self._reset_stages()
        self.final_output.set_text("Working on your request...")
        self.status.set_label("Starting local model...")
        self._set_running(True)

    def _show_unfinished_runs(self, runs: list[dict[str, Any]]) -> None:
        self._unfinished_runs = runs
        self.resume_bar.set_visible(bool(runs) and not self._request_running)
        if runs:
            run = runs[0]
            prompt = " ".join(run["prompt"].split())
            self.resume_label.set_label(
                f"Unfinished: {prompt[:80]}{'…' if len(prompt) > 80 else ''}"
                f" ({run['tasks_done']} of {run['tasks_total']} tasks done)"
            )

    def _resume_run(self) -> None:
        if self._request_running or not self._unfinished_runs:
            return
        run = self._unfinished_runs[0]
        self.prompt.get_buffer().set_text(run["prompt"])
        self._begin_run(None, "tree")

        def started(result: dict[str, Any]) -> None:
            self._run_id = result["run_id"]

        def failed(_message: str) -> None:
            self._stop_run("The request could not resume.", "WAIT", "Ready")

        self._call_daemon("resume_run", started, failed, run_id=run["id"])

    def _discard_run(self) -> None:
        if not self._unfinished_runs:
            return
        remaining = self._unfinished_runs[1:]
        self._call_daemon(
            "discard_run", lambda _result: self._show_unfinished_runs(remaining), run_id=self._unfinished_runs[0]["id"]
        )

    def _set_running(self, running: bool) -> None:
        self._request_running = running
        self.resume_bar.set_visible(bool(self._unfinished_runs) and not running)
        self.run_button.set_sensitive(not running)
        self.clear_button.set_sensitive(not running)
        self.cancel_button.set_sensitive(running)
        self.copy_button.set_sensitive(not running and bool(self._last_answer))

    def _cancel_run(self) -> None:
        if not self._request_running:
            return
        self._call_daemon("cancel", run_id=self._run_id)
        self.cancel_button.set_sensitive(False)
        self.status.set_label("Cancelling...")

    def _clear_workbench(self) -> None:
        if self._request_running:
            return
        self.prompt.get_buffer().set_text("")
        self.final_output.set_text(FINAL_WAITING_TEXT)
        self._last_answer = ""
        self.copy_button.set_sensitive(False)
        self._reset_stages()
        self.status.set_label("Ready")

    def _copy_answer(self) -> None:
        if self._last_answer:
            self.get_clipboard().set(self._last_answer)
            self.notify_user("Copied the answer.")

    def _show_phase(self, name: str) -> None:
        row = next(row for row in self._phase_rows() if row.page_name == name)
        self._showing_phase_programmatically = True
        self.phase_list.select_row(row)
        self._showing_phase_programmatically = False

    def _task_rows(self) -> list["TaskRow"]:
        rows = []
        child = self.task_list.get_first_child()
        while child is not None:
            rows.append(child)
            child = child.get_next_sibling()
        return rows

    def _phase_rows(self) -> list["PhaseRow"]:
        rows = []
        child = self.phase_list.get_first_child()
        while child is not None:
            rows.append(child)
            child = child.get_next_sibling()
        return rows

    def _show_runner(self, runner: str) -> None:
        """Show the eight stages for a pipeline run, or the task tree and its steps for a tree run."""
        self._runner = runner
        tree_mode = runner == "tree"
        title = "Task tree" if tree_mode else "Pipeline"
        self.sidebar_title.set_markup(f"<b>{GLib.markup_escape_text(title)}</b>")
        for row in self._phase_rows():
            if row.page_name.startswith("phase-"):
                row.set_visible(not tree_mode)
            elif row.page_name == "steps":
                row.set_visible(tree_mode)
        self.task_list.set_visible(tree_mode)

    def _show_task_tree(self, nodes: list[dict[str, Any]]) -> None:
        self._task_nodes = nodes
        # Rows are rebuilt on every change, so the chosen task is selected again without counting as a new pick.
        self._rebuilding_task_list = True
        self.task_list.remove_all()
        for node, line in zip(nodes, task_tree_lines(nodes)):
            row = TaskRow(node["id"], line)
            self.task_list.append(row)
            if node["id"] == self._chosen_task_id:
                self.task_list.select_row(row)
        self._rebuilding_task_list = False
        self._show_task_detail()

    def _show_task_detail(self) -> None:
        node = next((node for node in self._task_nodes if node["id"] == self._chosen_task_id), None)
        if node is None:
            self.task_detail.set_text(TASK_DETAIL_WAITING_TEXT)
        else:
            self.task_detail.set_markdown(task_detail_markdown(node))

    def _on_task_selected(self, _list: Gtk.ListBox, row: "TaskRow | None") -> None:
        if row is None or self._rebuilding_task_list:
            return
        self._chosen_task_id = row.task_id
        self._show_task_detail()
        self._rebuilding_task_list = True
        self.phase_list.unselect_all()
        self._rebuilding_task_list = False
        self.phase_pages.set_visible_child_name("task")
        self.phase_title.set_markup(f"<b>Task {GLib.markup_escape_text(row.task_id)}</b>")
        # Choosing a task is the user's own pick, so the view stops following the running step.
        if self._request_running:
            self._follow_stages = False

    def _note_step(self, label: str) -> None:
        """Start a new heading in the steps view whenever the step changes."""
        if label != self._last_step_label:
            self._last_step_label = label
            self._pending_steps_output.append(f"\n\n▸ {label}\n\n")

    def _set_stage_state(self, index: int, state: str) -> None:
        self.stage_states[index].set_label(state)

    def _reset_stages(self) -> None:
        self._active_stage = None
        self._run_mode = ""
        self._skipped_stages.clear()
        self._follow_stages = True
        for index, output in enumerate(self.stage_outputs):
            self._set_stage_state(index, "WAIT")
            self._pending_stage_output[index].clear()
            output.set_text(PHASE_WAITING_TEXT)
            self._stage_output_started[index] = False
        self._pending_steps_output.clear()
        self._steps_output_started = False
        self._last_step_label = ""
        self.steps_output.set_text(STEPS_WAITING_TEXT)
        self._chosen_task_id = None
        self._show_task_tree([])
        self._show_phase("final")

    def _append_stage_output(self, label: str, token: str) -> None:
        if label.startswith(TASK_STEP_PREFIX):
            self._note_step(label)
            self._pending_steps_output.append(token)
        elif label in STAGE_LABELS:
            self._pending_stage_output[STAGE_LABELS.index(label)].append(token)

    def _flush_output(self) -> bool:
        for index, pending in enumerate(self._pending_stage_output):
            if not pending:
                continue
            output = self.stage_outputs[index]
            if not self._stage_output_started[index]:
                output.set_text("")
                self._stage_output_started[index] = True
            output.append("".join(pending))
            pending.clear()
        if self._pending_steps_output:
            text = "".join(self._pending_steps_output)
            self._pending_steps_output.clear()
            if not self._steps_output_started:
                self.steps_output.set_text("")
                self._steps_output_started = True
                text = text.lstrip()
            self.steps_output.append(text)
        if self._pending_background_tokens:
            self.background_output.append("".join(self._pending_background_tokens))
            self._pending_background_tokens.clear()
        return True

    def _update_stage(self, label: str) -> None:
        if label.startswith(TASK_STEP_PREFIX):
            self._note_step(label)
        self._flush_output()
        if label == "Loading model":
            self.status.set_label("Loading local model...")
            return
        if label.startswith(MODE_PROGRESS_PREFIX):
            self._run_mode = f"{MODE_NAMES[label.removeprefix(MODE_PROGRESS_PREFIX)]} · "
        if label.startswith(TASK_STEP_PREFIX):
            self.status.set_label(label)
            if self._follow_stages:
                self._show_phase("steps")
            return
        if label.startswith(SKIPPED_PREFIX) and label.removeprefix(SKIPPED_PREFIX) in STAGE_LABELS:
            skipped = STAGE_LABELS.index(label.removeprefix(SKIPPED_PREFIX))
            self._skipped_stages.add(skipped)
            self._set_stage_state(skipped, "SKIP")
            self.stage_outputs[skipped].set_text(PHASE_SKIPPED_TEXT)
            return
        if label not in STAGE_LABELS:
            self.status.set_label(label)
            return
        active = STAGE_LABELS.index(label)
        self._active_stage = active
        for index in range(len(STAGE_LABELS)):
            if index not in self._skipped_stages:
                self._set_stage_state(index, "DONE" if index < active else "NOW" if index == active else "WAIT")
        if self._follow_stages:
            self._show_phase(f"phase-{active + 1}")
        self.status.set_label(f"{self._run_mode}Stage {active + 1} of {len(STAGE_LABELS)}")

    def _finish_run(self, result: str) -> None:
        self._flush_output()
        self._last_answer = result
        self._set_running(False)
        self.final_output.set_markdown(result)
        self._show_phase("final")
        for index in range(len(STAGE_LABELS)):
            self._set_stage_state(index, "SKIP" if index in self._skipped_stages else "DONE")
        self.status.set_label("Complete")

    def _stop_run(self, final_text: str, stage_state: str, status: str) -> None:
        self._flush_output()
        self._set_running(False)
        self.final_output.set_text(final_text)
        self._show_phase("final")
        if self._active_stage is not None:
            self._set_stage_state(self._active_stage, stage_state)
        self.status.set_label(status)

    def _fail_run(self, message: str) -> None:
        self._stop_run(f"Run failed\n\n{message}", "FAIL", "Run failed")
        self.notify_user(message)

    def _request_clarification(self, run_id: int, clarification_id: int, question: str) -> None:
        def answer(text: str) -> None:
            self._call_daemon(
                "answer_clarification",
                run_id=run_id,
                clarification_id=clarification_id,
                answer=text,
            )

        ClarificationDialog(self, question, answer).present()

    # ==========================================================================
    # Background research
    # ==========================================================================

    def _queue_topic(self, then: Callable[[], None] | None = None) -> None:
        topic = self.research_topic.get_text().strip()
        if not topic:
            self.notify_user("Enter a topic to research.")
            return

        def queued(_result: dict[str, Any]) -> None:
            self.research_topic.set_text("")
            if then is not None:
                then()

        self._call_daemon("queue_topic", queued, topic=topic, priority=self.research_priority.get_value_as_int())

    def _trigger_background_research(self) -> None:
        research = lambda: self._call_daemon("research_now")  # noqa: E731
        if self.research_topic.get_text().strip():
            self._queue_topic(then=research)
        else:
            research()

    def _refresh_queue(self) -> None:
        if self.client is not None:
            self._call_daemon("queue_status", self._show_queue)

    def _show_queue(self, jobs: list[dict[str, Any]]) -> None:
        if not jobs:
            self.queue_label.set_label("No research jobs")
            return
        self.queue_label.set_label(
            "\n".join(
                f"{job['status'].upper():8} {job['topic']}" + (f"  ({job['error']})" if job["error"] else "")
                for job in jobs[:20]
            )
        )

    def _set_background_status(self, message: str) -> None:
        self.background_status.set_label(message)
        if message.startswith("Searching:"):
            self._pending_background_tokens.clear()
            self.background_output.set_text("")

    # ==========================================================================
    # Knowledge browser
    # ==========================================================================

    def _search_knowledge(self, query: str) -> None:
        self._knowledge_query = query.strip()
        self._knowledge_topic_id = None
        self._refresh_knowledge()

    def _refresh_knowledge(self) -> None:
        if self.client is not None:
            self._call_daemon(
                "knowledge",
                self._show_knowledge,
                query=self._knowledge_query,
                topic_id=self._knowledge_topic_id,
            )

    def _on_topic_activated(self, _list: Gtk.ListBox, row: TopicRow) -> None:
        self._knowledge_query = ""
        self.knowledge_search.set_text("")
        self._knowledge_topic_id = row.topic_id
        self._refresh_knowledge()

    def _show_knowledge(self, knowledge: dict[str, Any]) -> None:
        self._knowledge_topics = knowledge["topics"]
        self._knowledge_sources = knowledge["sources"]
        self._knowledge_graph = knowledge["graph"]
        self._render_topics()
        self._render_sources()
        self._render_graph()

    def _render_topics(self) -> None:
        children: dict[int | None, list[dict[str, Any]]] = {}
        for topic in self._knowledge_topics:
            children.setdefault(topic["parent_id"], []).append(topic)
        ordered: list[tuple[dict[str, Any], int]] = []
        visited: set[int] = set()

        def add(topic: dict[str, Any], depth: int) -> None:
            visited.add(topic["id"])
            ordered.append((topic, depth))
            for child in children.get(topic["id"], []):
                if child["id"] not in visited:
                    add(child, depth + 1)

        for topic in children.get(None, []):
            add(topic, 0)
        for topic in self._knowledge_topics:
            if topic["id"] not in visited:
                add(topic, 0)

        self.topic_list.remove_all()
        self._add_topic_row("All topics", None, 0)
        for topic, depth in ordered:
            self._add_topic_row(f"{topic['name']}  ({topic['source_count']})", topic["id"], depth)

    def _add_topic_row(self, text: str, topic_id: int | None, depth: int) -> None:
        row = TopicRow(text, topic_id, depth)
        self.topic_list.append(row)
        if topic_id == self._knowledge_topic_id and not self._knowledge_query:
            self.topic_list.select_row(row)

    def _render_sources(self) -> None:
        if not self._knowledge_sources:
            self.knowledge_detail.set_text("No matching stored evidence.")
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
        self.knowledge_detail.set_markdown("\n\n---\n\n".join(entries))

    def _render_graph(self) -> None:
        lines = [
            f"{edge['source']} -{edge['relation']}-> {edge['target']}"
            + (f"  ({edge['evidence_url']})" if edge["evidence_url"] else "")
            for edge in self._knowledge_graph[:50]
        ]
        self.knowledge_graph.set_text("\n".join(lines) if lines else "No graph relationships yet.")


# ==============================================================================
# Application
# ==============================================================================


class SmartHarnessApplication(Gtk.Application):
    def __init__(self, settings: dict[str, Any], settings_path: str | Path | None = None) -> None:
        super().__init__(application_id=APPLICATION_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.settings = settings
        self.settings_path = settings_path
        self.window: SmartHarnessWindow | None = None

    def do_activate(self) -> None:
        if self.window is None:
            self.window = SmartHarnessWindow(self, self.settings, self.settings_path)
        self.window.present()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open the SmartHarness GTK interface.")
    parser.add_argument(
        "--settings",
        default=str(default_settings_path()),
        help="Path to the JSON settings file used when this starts the daemon.",
    )
    args = parser.parse_args(argv)
    try:
        settings = load_settings(args.settings)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    return SmartHarnessApplication(settings, args.settings).run([sys.argv[0]])


if __name__ == "__main__":
    raise SystemExit(main())
