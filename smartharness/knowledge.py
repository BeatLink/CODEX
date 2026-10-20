import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class KnowledgeStore:
    def __init__(self, database_path: str | Path):
        self.path = Path(database_path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            schema_version = connection.execute("PRAGMA user_version").fetchone()[0]
            if schema_version > 1:
                raise RuntimeError(f"Knowledge database schema {schema_version} is newer than this application.")
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS topics (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    parent_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
                    priority INTEGER NOT NULL DEFAULT 0,
                    last_researched_at REAL
                );
                CREATE TABLE IF NOT EXISTS sources (
                    id INTEGER PRIMARY KEY,
                    url TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL DEFAULT '',
                    snippet TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    query TEXT NOT NULL DEFAULT '',
                    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
                    retrieved_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(
                    title, body, url, tokenize='unicode61'
                );
                CREATE TABLE IF NOT EXISTS research_queue (
                    id INTEGER PRIMARY KEY,
                    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'pending',
                    requested_at REAL NOT NULL,
                    started_at REAL,
                    finished_at REAL,
                    error TEXT NOT NULL DEFAULT ''
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_pending_job_per_topic
                    ON research_queue(topic_id) WHERE status = 'pending';
                CREATE TABLE IF NOT EXISTS graph_nodes (
                    id INTEGER PRIMARY KEY,
                    kind TEXT NOT NULL,
                    label TEXT NOT NULL,
                    UNIQUE(kind, label)
                );
                CREATE TABLE IF NOT EXISTS graph_edges (
                    id INTEGER PRIMARY KEY,
                    source_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
                    relation TEXT NOT NULL,
                    target_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
                    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
                    UNIQUE(source_node_id, relation, target_node_id, source_id)
                );
                """
            )
            if schema_version < 1:
                connection.execute("PRAGMA user_version = 1")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, factory=_ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def add_topic(self, name: str, parent: str | None = None, priority: int = 0) -> int:
        name = self._clean_text(name, "topic", 200)
        with self._connect() as connection:
            parent_id = self._topic_id(connection, parent) if parent else None
            connection.execute(
                "INSERT INTO topics(name, parent_id, priority) VALUES (?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET parent_id = excluded.parent_id, "
                "priority = excluded.priority",
                (name, parent_id, priority),
            )
            topic_id = connection.execute(
                "SELECT id FROM topics WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()["id"]
            node_id = self._node_id(connection, "topic", name)
            if parent:
                parent_node_id = self._node_id(connection, "topic", parent)
                connection.execute(
                    "INSERT OR IGNORE INTO graph_edges "
                    "(source_node_id, relation, target_node_id) VALUES (?, 'contains', ?)",
                    (parent_node_id, node_id),
                )
            return int(topic_id)

    def enqueue_topic(self, name: str, priority: int = 0, max_pending: int = 100) -> int:
        topic_id = self.add_topic(name, priority=priority)
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT id FROM research_queue WHERE topic_id = ? AND status = 'pending'",
                (topic_id,),
            ).fetchone()
            if existing:
                return int(existing["id"])
            pending_count = connection.execute(
                "SELECT COUNT(*) FROM research_queue WHERE status = 'pending'"
            ).fetchone()[0]
            if pending_count >= max_pending:
                raise ValueError(f"Background research queue is full ({max_pending} pending jobs).")
            connection.execute(
                "INSERT OR IGNORE INTO research_queue(topic_id, requested_at) VALUES (?, ?)",
                (topic_id, time.time()),
            )
            row = connection.execute(
                "SELECT id FROM research_queue WHERE topic_id = ? AND status = 'pending'",
                (topic_id,),
            ).fetchone()
            return int(row["id"]) if row else 0

    def claim_job(self) -> dict[str, Any] | None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT q.id, t.id AS topic_id, t.name FROM research_queue q "
                "JOIN topics t ON t.id = q.topic_id WHERE q.status = 'pending' "
                "ORDER BY t.priority DESC, q.requested_at, q.id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE research_queue SET status = 'running', started_at = ? WHERE id = ?",
                (time.time(), row["id"]),
            )
            return dict(row)

    def enqueue_due_topics(self, refresh_interval_hours: int, max_pending: int = 100) -> int:
        cutoff = time.time() - refresh_interval_hours * 3600
        with self._connect() as connection:
            pending_count = connection.execute(
                "SELECT COUNT(*) FROM research_queue WHERE status = 'pending'"
            ).fetchone()[0]
            available_slots = max(0, max_pending - pending_count)
            if available_slots == 0:
                return 0
            topic_ids = connection.execute(
                "SELECT id FROM topics t WHERE EXISTS "
                "(SELECT 1 FROM sources s WHERE s.topic_id = t.id) "
                "AND (t.last_researched_at IS NULL OR t.last_researched_at <= ?) "
                "AND NOT EXISTS (SELECT 1 FROM research_queue q WHERE q.topic_id = t.id "
                "AND q.status = 'pending') ORDER BY t.priority DESC, t.name LIMIT ?",
                (cutoff, available_slots),
            ).fetchall()
            connection.executemany(
                "INSERT OR IGNORE INTO research_queue(topic_id, requested_at) VALUES (?, ?)",
                [(row["id"], time.time()) for row in topic_ids],
            )
        return len(topic_ids)

    def finish_job(self, job_id: int, error: str = "") -> None:
        status = "failed" if error else "done"
        with self._connect() as connection:
            connection.execute(
                "UPDATE research_queue SET status = ?, finished_at = ?, error = ? WHERE id = ?",
                (status, time.time(), error[:1000], job_id),
            )

    def defer_job(self, job_id: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE research_queue SET status = 'pending', started_at = NULL, "
                "finished_at = NULL, error = '' WHERE id = ?",
                (job_id,),
            )

    def store_search_results(
        self,
        query: str,
        results: list[dict[str, str]],
        topic: str | None = None,
        ttl_seconds: int = 604800,
        summary: str = "",
    ) -> int:
        topic_id = self.add_topic(topic) if topic else None
        now = time.time()
        stored = 0
        with self._connect() as connection:
            for result in results:
                url = result.get("url", "").strip()
                if not url.startswith(("https://", "http://")):
                    continue
                title = result.get("title", "")[:500]
                snippet = result.get("snippet", "")[:4000]
                item_summary = summary[:4000]
                connection.execute(
                    "INSERT INTO sources(url, title, snippet, summary, query, topic_id, "
                    "retrieved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(url) DO UPDATE SET title = excluded.title, "
                    "snippet = excluded.snippet, summary = excluded.summary, "
                    "query = excluded.query, topic_id = excluded.topic_id, "
                    "retrieved_at = excluded.retrieved_at, expires_at = excluded.expires_at",
                    (url, title, snippet, item_summary, query[:500], topic_id, now, now + ttl_seconds),
                )
                source_id = connection.execute(
                    "SELECT id FROM sources WHERE url = ?", (url,)
                ).fetchone()["id"]
                connection.execute("DELETE FROM knowledge_search WHERE rowid = ?", (source_id,))
                connection.execute(
                    "INSERT INTO knowledge_search(rowid, title, body, url) VALUES (?, ?, ?, ?)",
                    (source_id, title, f"{snippet} {item_summary}", url),
                )
                if topic:
                    topic_node = self._node_id(connection, "topic", topic)
                    source_node = self._node_id(connection, "source", url)
                    connection.execute(
                        "INSERT OR IGNORE INTO graph_edges "
                        "(source_node_id, relation, target_node_id, source_id) "
                        "VALUES (?, 'supported_by', ?, ?)",
                        (topic_node, source_node, source_id),
                    )
                stored += 1
            if topic_id is not None:
                connection.execute(
                    "UPDATE topics SET last_researched_at = ? WHERE id = ?",
                    (now, topic_id),
                )
        return stored

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        terms = re.findall(r"[\w]{2,}", query.casefold())[:12]
        if not terms:
            return []
        expression = " OR ".join('"' + term.replace('"', '""') + '"' for term in terms)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT s.title, s.url, s.snippet, s.summary, s.query, s.retrieved_at, "
                "t.name AS topic FROM knowledge_search k JOIN sources s ON s.id = k.rowid "
                "LEFT JOIN topics t ON t.id = s.topic_id "
                "WHERE knowledge_search MATCH ? AND s.expires_at >= ? "
                "ORDER BY rank LIMIT ?",
                (expression, time.time(), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def topics(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT t.id, t.name, t.parent_id, p.name AS parent, t.priority, "
                "t.last_researched_at, COUNT(s.id) AS source_count "
                "FROM topics t LEFT JOIN topics p ON p.id = t.parent_id "
                "LEFT JOIN sources s ON s.topic_id = t.id "
                "GROUP BY t.id ORDER BY p.name, t.name"
            ).fetchall()
        return [dict(row) for row in rows]

    def sources(self, topic_id: int | None = None, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT s.id, s.title, s.url, s.snippet, s.summary, s.query, "
                "s.retrieved_at, s.expires_at, t.name AS topic FROM sources s "
                "LEFT JOIN topics t ON t.id = s.topic_id "
                "WHERE (? IS NULL OR s.topic_id = ?) ORDER BY s.retrieved_at DESC LIMIT ?",
                (topic_id, topic_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def graph(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT a.kind AS source_kind, a.label AS source, e.relation, "
                "b.kind AS target_kind, b.label AS target, s.url AS evidence_url "
                "FROM graph_edges e JOIN graph_nodes a ON a.id = e.source_node_id "
                "JOIN graph_nodes b ON b.id = e.target_node_id "
                "LEFT JOIN sources s ON s.id = e.source_id "
                "ORDER BY a.label, e.relation"
            ).fetchall()
        return [dict(row) for row in rows]

    def add_relationship(
        self,
        source: str,
        relation: str,
        target: str,
        source_url: str | None = None,
    ) -> None:
        source = self._clean_text(source, "source entity", 200)
        relation = self._clean_text(relation, "relationship", 100)
        target = self._clean_text(target, "target entity", 200)
        with self._connect() as connection:
            source_id = self._node_id(connection, "entity", source)
            target_id = self._node_id(connection, "entity", target)
            evidence_id = None
            if source_url:
                row = connection.execute(
                    "SELECT id FROM sources WHERE url = ?", (source_url,)
                ).fetchone()
                if row is None:
                    raise ValueError("source_url must refer to a stored source.")
                evidence_id = row["id"]
            connection.execute(
                "INSERT OR IGNORE INTO graph_edges "
                "(source_node_id, relation, target_node_id, source_id) VALUES (?, ?, ?, ?)",
                (source_id, relation, target_id, evidence_id),
            )

    def queue_status(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT q.id, t.name AS topic, q.status, q.requested_at, q.error "
                "FROM research_queue q JOIN topics t ON t.id = q.topic_id "
                "ORDER BY q.requested_at DESC LIMIT 100"
            ).fetchall()
        return [dict(row) for row in rows]

    def export_source_json(self, source: dict[str, Any]) -> str:
        return json.dumps(source, ensure_ascii=False, indent=2)

    @staticmethod
    def _clean_text(value: str, name: str, maximum: int) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string.")
        return value.strip()[:maximum]

    @classmethod
    def _topic_id(cls, connection: sqlite3.Connection, name: str) -> int:
        name = cls._clean_text(name, "topic", 200)
        connection.execute("INSERT OR IGNORE INTO topics(name) VALUES (?)", (name,))
        return int(
            connection.execute(
                "SELECT id FROM topics WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()["id"]
        )

    @staticmethod
    def _node_id(connection: sqlite3.Connection, kind: str, label: str) -> int:
        connection.execute(
            "INSERT OR IGNORE INTO graph_nodes(kind, label) VALUES (?, ?)", (kind, label)
        )
        return int(
            connection.execute(
                "SELECT id FROM graph_nodes WHERE kind = ? AND label = ?", (kind, label)
            ).fetchone()["id"]
        )