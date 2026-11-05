"""A system tray icon with a menu, over the StatusNotifierItem and dbusmenu D-Bus interfaces (GTK 4 has no tray API)."""

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import gi

from gi.repository import Gio, GLib  # noqa: E402

WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
ITEM_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"
ITEM_INTERFACE = "org.kde.StatusNotifierItem"
MENU_INTERFACE = "com.canonical.dbusmenu"

ITEM_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg type="s"/></signal>
  </interface>
</node>
"""

MENU_XML = """
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/>
      <arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/>
    </method>
    <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
    <method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/></method>
    <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
  </interface>
</node>
"""


@dataclass
class MenuItem:
    """One menu entry; no label makes a separator, and a checked value of True or False makes it a check box."""

    label: str | None
    action: Callable[[], None] | None = None
    checked: bool | None = None
    enabled: bool = True


class Tray:
    """A tray icon whose menu is rebuilt from `items` whenever `refresh` is called."""

    def __init__(
        self,
        title: str,
        icon_name: str,
        items: Callable[[], list[MenuItem]],
        on_activate: Callable[[], None],
        on_registered_changed: Callable[[bool], None] | None = None,
    ) -> None:
        self.title = title
        self.icon_name = icon_name
        self.tooltip = title
        self.registered = False
        self._items = items
        self._on_activate = on_activate
        self._on_registered_changed = on_registered_changed
        self._current: list[MenuItem] = []
        self._revision = 0
        self._connection: Gio.DBusConnection | None = None
        self._watch: int | None = None
        self._owned_name: int | None = None

    # ==========================================================================
    # Registration
    # ==========================================================================

    def start(self) -> None:
        """Show the icon whenever a tray host is running, and again if the host restarts."""
        self._connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        item_info = Gio.DBusNodeInfo.new_for_xml(ITEM_XML).interfaces[0]
        menu_info = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
        self._connection.register_object(ITEM_PATH, item_info, self._item_method, self._item_property, None)
        self._connection.register_object(MENU_PATH, menu_info, self._menu_method, self._menu_property, None)
        self._current = self._items()
        service = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self._owned_name = Gio.bus_own_name_on_connection(self._connection, service, Gio.BusNameOwnerFlags.NONE, None, None)
        self._service = service
        self._watch = Gio.bus_watch_name_on_connection(
            self._connection, WATCHER_NAME, Gio.BusNameWatcherFlags.NONE, self._watcher_appeared, self._watcher_vanished
        )

    def stop(self) -> None:
        if self._watch is not None:
            Gio.bus_unwatch_name(self._watch)
            self._watch = None
        if self._owned_name is not None:
            Gio.bus_unown_name(self._owned_name)
            self._owned_name = None
        self._set_registered(False)

    def _watcher_appeared(self, connection: Gio.DBusConnection, _name: str, _owner: str) -> None:
        connection.call(
            WATCHER_NAME,
            WATCHER_PATH,
            WATCHER_NAME,
            "RegisterStatusNotifierItem",
            GLib.Variant("(s)", (self._service,)),
            None,
            Gio.DBusCallFlags.NONE,
            -1,
            None,
            self._registration_finished,
        )

    def _registration_finished(self, connection: Gio.DBusConnection, result: Gio.AsyncResult) -> None:
        try:
            connection.call_finish(result)
        except GLib.Error:
            self._set_registered(False)
            return
        self._set_registered(True)

    def _watcher_vanished(self, _connection: Gio.DBusConnection, _name: str) -> None:
        self._set_registered(False)

    def _set_registered(self, registered: bool) -> None:
        if registered == self.registered:
            return
        self.registered = registered
        if self._on_registered_changed is not None:
            self._on_registered_changed(registered)

    # ==========================================================================
    # Updating
    # ==========================================================================

    def refresh(self, tooltip: str | None = None) -> None:
        """Rebuild the menu, and optionally the tooltip, after what they show has changed."""
        self._current = self._items()
        self._revision += 1
        if tooltip is not None:
            self.tooltip = tooltip
        if self._connection is None:
            return
        self._connection.emit_signal(None, MENU_PATH, MENU_INTERFACE, "LayoutUpdated", GLib.Variant("(ui)", (self._revision, 0)))
        self._connection.emit_signal(None, ITEM_PATH, ITEM_INTERFACE, "NewToolTip", None)

    # ==========================================================================
    # StatusNotifierItem
    # ==========================================================================

    def _item_property(self, _connection: Any, _sender: str, _path: str, _interface: str, name: str) -> GLib.Variant | None:
        values = {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", "codex"),
            "Title": GLib.Variant("s", self.title),
            "Status": GLib.Variant("s", "Active"),
            "WindowId": GLib.Variant("i", 0),
            "IconName": GLib.Variant("s", self.icon_name),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", ("", [], self.title, self.tooltip)),
            "ItemIsMenu": GLib.Variant("b", False),
            "Menu": GLib.Variant("o", MENU_PATH),
        }
        return values.get(name)

    def _item_method(self, _connection: Any, _sender: str, _path: str, _interface: str, method: str, _parameters: Any, invocation: Gio.DBusMethodInvocation) -> None:
        if method in ("Activate", "SecondaryActivate"):
            self._on_activate()
        invocation.return_value(None)

    # ==========================================================================
    # dbusmenu
    # ==========================================================================

    def layout(self) -> GLib.Variant:
        """The menu as the (id, properties, children) tree that dbusmenu clients ask for; the root has id 0."""
        children = [GLib.Variant("v", self._entry(index, item)) for index, item in enumerate(self._current, start=1)]
        return GLib.Variant("(ia{sv}av)", (0, {"children-display": GLib.Variant("s", "submenu")}, children))

    def _entry(self, identifier: int, item: MenuItem) -> GLib.Variant:
        return GLib.Variant("(ia{sv}av)", (identifier, self._properties(item), []))

    @staticmethod
    def _properties(item: MenuItem) -> dict[str, GLib.Variant]:
        if item.label is None:
            return {"type": GLib.Variant("s", "separator")}
        properties = {
            "label": GLib.Variant("s", item.label),
            "enabled": GLib.Variant("b", item.enabled and item.action is not None),
        }
        if item.checked is not None:
            properties["toggle-type"] = GLib.Variant("s", "checkmark")
            properties["toggle-state"] = GLib.Variant("i", 1 if item.checked else 0)
        return properties

    def choose(self, identifier: int) -> None:
        """Run the action of the menu entry with this id."""
        if 1 <= identifier <= len(self._current):
            action = self._current[identifier - 1].action
            if action is not None:
                action()

    def _menu_property(self, _connection: Any, _sender: str, _path: str, _interface: str, name: str) -> GLib.Variant | None:
        values = {
            "Version": GLib.Variant("u", 3),
            "TextDirection": GLib.Variant("s", "ltr"),
            "Status": GLib.Variant("s", "normal"),
            "IconThemePath": GLib.Variant("as", []),
        }
        return values.get(name)

    def _menu_method(self, _connection: Any, _sender: str, _path: str, _interface: str, method: str, parameters: GLib.Variant, invocation: Gio.DBusMethodInvocation) -> None:
        if method == "GetLayout":
            invocation.return_value(GLib.Variant.new_tuple(GLib.Variant("u", self._revision), self.layout()))
        elif method == "GetGroupProperties":
            identifiers = parameters.unpack()[0] or range(len(self._current) + 1)
            entries = [
                (identifier, self._properties(self._current[identifier - 1]))
                for identifier in identifiers
                if 1 <= identifier <= len(self._current)
            ]
            invocation.return_value(GLib.Variant("(a(ia{sv}))", (entries,)))
        elif method == "GetProperty":
            identifier, name = parameters.unpack()
            properties = self._properties(self._current[identifier - 1]) if 1 <= identifier <= len(self._current) else {}
            invocation.return_value(GLib.Variant("(v)", (properties.get(name, GLib.Variant("s", "")),)))
        elif method == "Event":
            identifier, event, _data, _timestamp = parameters.unpack()
            if event == "clicked":
                self.choose(identifier)
            invocation.return_value(None)
        elif method == "EventGroup":
            for identifier, event, _data, _timestamp in parameters.unpack()[0]:
                if event == "clicked":
                    self.choose(identifier)
            invocation.return_value(GLib.Variant("(ai)", ([],)))
        elif method == "AboutToShow":
            self._current = self._items()
            invocation.return_value(GLib.Variant("(b)", (False,)))
        elif method == "AboutToShowGroup":
            self._current = self._items()
            invocation.return_value(GLib.Variant("(aiai)", ([], [])))
        else:
            invocation.return_value(None)
