import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

# Common words that would match almost any stored snippet, so they never count as a search term.
_SEARCH_STOPWORDS = frozenset(
    """
    a about all also an and any are as at be been but by can could do does for from had has
    have how i if in into is it its me my no not of on or our please should so some tell than
    that the their them then there these they this to up us was we what when where which who
    why will with would you your
    explain find latest look online recent research search show source verify web
    """.split()
)


# Schema migrations in order; a database at version N has run the first N of them.
_MIGRATIONS = (
    """
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
    """,
    """
    ALTER TABLE topics ADD COLUMN summary TEXT NOT NULL DEFAULT '';
    ALTER TABLE topics ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE topics ADD COLUMN last_used_at REAL;
    UPDATE topics SET summary = COALESCE((
        SELECT s.summary FROM sources s WHERE s.topic_id = topics.id AND s.summary != ''
        ORDER BY s.retrieved_at DESC LIMIT 1
    ), '');
    UPDATE sources SET summary = '' WHERE topic_id IS NOT NULL;
    DELETE FROM knowledge_search;
    INSERT INTO knowledge_search(rowid, title, body, url)
        SELECT id, title, snippet || ' ' || summary, url FROM sources;
    CREATE TABLE facts (
        id INTEGER PRIMARY KEY,
        topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        statement TEXT NOT NULL,
        source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        created_at REAL NOT NULL,
        last_used_at REAL,
        use_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(topic_id, statement)
    );
    CREATE TABLE user_memory (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        statement TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at REAL NOT NULL,
        last_used_at REAL,
        use_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE episodes (
        id INTEGER PRIMARY KEY,
        prompt TEXT NOT NULL,
        task_type TEXT NOT NULL,
        checklist TEXT NOT NULL DEFAULT '',
        answer TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        processed_at REAL
    );
    CREATE VIRTUAL TABLE memory_search USING fts5(
        body, kind UNINDEXED, item_id UNINDEXED, tokenize='unicode61'
    );
    """,
)

MEMORY_KINDS = ("fact", "episode")
USER_MEMORY_KINDS = ("preference", "project", "correction")


def _search_terms(query: str) -> list[str]:
    return list(dict.fromkeys(
        term for term in re.findall(r"\w{2,}", query.casefold())
        if term not in _SEARCH_STOPWORDS
    ))[:12]


def _match_expression(terms: list[str]) -> str:
    return " OR ".join('"' + term.replace('"', '""') + '"' for term in terms)


def _shares_half_the_terms(terms: list[str], text: str) -> bool:
    """A stored item counts as relevant only when it shares at least half of the query's terms."""
    words = set(re.findall(r"\w{2,}", text.casefold()))
    return sum(term in words for term in terms) >= (len(terms) + 1) // 2


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
            if schema_version > len(_MIGRATIONS):
                raise RuntimeError(f"Knowledge database schema {schema_version} is newer than this application.")
            connection.execute("PRAGMA journal_mode = WAL")
            for target_version, migration in enumerate(_MIGRATIONS[schema_version:], start=schema_version + 1):
                # Each migration and its version bump commit together, so a crash never leaves half a schema.
                connection.executescript(f"BEGIN;\n{migration}\nPRAGMA user_version = {target_version};\nCOMMIT;")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, factory=_ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def add_topic(self, name: str, parent: str | None = None, priority: int | None = None) -> int:
        """Create a topic, or update it; a parent or priority left out keeps its stored value."""
        name = self._clean_text(name, "topic", 200)
        with self._connect() as connection:
            parent_id = self._topic_id(connection, parent) if parent else None
            connection.execute(
                "INSERT INTO topics(name, parent_id, priority) VALUES (?, ?, COALESCE(?, 0)) "
                "ON CONFLICT(name) DO UPDATE SET parent_id = COALESCE(excluded.parent_id, parent_id), "
                "priority = COALESCE(?, priority)",
                (name, parent_id, priority, priority),
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

    def enqueue_topic(self, name: str, priority: int | None = None, max_pending: int = 100) -> int:
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
                connection.execute(
                    "INSERT INTO sources(url, title, snippet, query, topic_id, "
                    "retrieved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(url) DO UPDATE SET title = excluded.title, "
                    "snippet = excluded.snippet, "
                    "query = excluded.query, topic_id = excluded.topic_id, "
                    "retrieved_at = excluded.retrieved_at, expires_at = excluded.expires_at",
                    (url, title, snippet, query[:500], topic_id, now, now + ttl_seconds),
                )
                source = connection.execute(
                    "SELECT id, summary FROM sources WHERE url = ?", (url,)
                ).fetchone()
                source_id = source["id"]
                connection.execute("DELETE FROM knowledge_search WHERE rowid = ?", (source_id,))
                connection.execute(
                    "INSERT INTO knowledge_search(rowid, title, body, url) VALUES (?, ?, ?, ?)",
                    (source_id, title, f"{snippet} {source['summary']}", url),
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
                    "UPDATE topics SET last_researched_at = ?, "
                    "summary = CASE WHEN ? != '' THEN ? ELSE summary END WHERE id = ?",
                    (now, summary, summary[:4000], topic_id),
                )
        return stored

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        terms = _search_terms(query)
        if not terms:
            return []
        expression = _match_expression(terms)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT s.title, s.url, s.snippet, "
                "CASE WHEN s.summary != '' THEN s.summary ELSE COALESCE(t.summary, '') END AS summary, "
                "s.query, s.retrieved_at, "
                "t.name AS topic FROM knowledge_search k JOIN sources s ON s.id = k.rowid "
                "LEFT JOIN topics t ON t.id = s.topic_id "
                "WHERE knowledge_search MATCH ? AND s.expires_at >= ? "
                "ORDER BY rank LIMIT ?",
                (expression, time.time(), limit * 4),
            ).fetchall()
        matching_rows = [
            dict(row) for row in rows
            if _shares_half_the_terms(
                terms, " ".join(str(row[column] or "") for column in ("title", "url", "snippet", "summary", "query"))
            )
        ]
        return matching_rows[:limit]

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

    # ==========================================================================
    # Facts, user memory, and episodes
    # ==========================================================================

    def add_fact(
        self,
        topic: str,
        statement: str,
        source_url: str | None = None,
        confidence: float = 0.5,
    ) -> int:
        """Store one atomic fact under a topic; a repeated fact keeps its highest confidence."""
        statement = " ".join(self._clean_text(statement, "fact", 500).split())
        confidence = min(1.0, max(0.0, float(confidence)))
        topic_id = self.add_topic(topic)
        with self._connect() as connection:
            source_id = None
            if source_url:
                row = connection.execute("SELECT id FROM sources WHERE url = ?", (source_url,)).fetchone()
                source_id = row["id"] if row else None
            connection.execute(
                "INSERT INTO facts(topic_id, statement, source_id, confidence, created_at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(topic_id, statement) DO UPDATE SET "
                "confidence = MAX(confidence, excluded.confidence), "
                "source_id = COALESCE(excluded.source_id, source_id), status = 'active'",
                (topic_id, statement, source_id, confidence, time.time()),
            )
            fact_id = connection.execute(
                "SELECT id FROM facts WHERE topic_id = ? AND statement = ?", (topic_id, statement)
            ).fetchone()["id"]
            self._index_memory(connection, "fact", fact_id, statement)
            return int(fact_id)

    def facts(self, topic_id: int | None = None, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT f.id, f.statement, f.confidence, f.status, f.use_count, f.created_at, "
                "t.name AS topic, s.url AS source_url FROM facts f "
                "JOIN topics t ON t.id = f.topic_id LEFT JOIN sources s ON s.id = f.source_id "
                "WHERE (? IS NULL OR f.topic_id = ?) ORDER BY f.created_at DESC LIMIT ?",
                (topic_id, topic_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def set_topic_summary(self, topic: str, summary: str) -> None:
        topic_id = self.add_topic(topic)
        with self._connect() as connection:
            connection.execute("UPDATE topics SET summary = ? WHERE id = ?", (summary.strip()[:4000], topic_id))

    def add_user_memory(self, kind: str, statement: str) -> int:
        """Remember a durable fact about the user: a preference, a project, or a correction."""
        if kind not in USER_MEMORY_KINDS:
            raise ValueError(f"kind must be one of: {', '.join(USER_MEMORY_KINDS)}.")
        statement = " ".join(self._clean_text(statement, "memory", 500).split())
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO user_memory(kind, statement, created_at) VALUES (?, ?, ?) "
                "ON CONFLICT(statement) DO UPDATE SET kind = excluded.kind",
                (kind, statement, time.time()),
            )
            return int(connection.execute(
                "SELECT id FROM user_memory WHERE statement = ? COLLATE NOCASE", (statement,)
            ).fetchone()["id"])

    def user_memories(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, kind, statement, created_at, use_count FROM user_memory "
                "ORDER BY use_count DESC, created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def record_episode(self, prompt: str, task_type: str, checklist: str, answer: str, outcome: str) -> int:
        """Remember one finished request so later requests and the background worker can learn from it."""
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO episodes(prompt, task_type, checklist, answer, outcome, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (prompt[:4000], task_type, checklist[:4000], answer[:4000], outcome[:500], time.time()),
            )
            episode_id = int(cursor.lastrowid)
            self._index_memory(connection, "episode", episode_id, f"{prompt[:4000]} {checklist[:4000]}")
            return episode_id

    def episodes(self, unprocessed_only: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, prompt, task_type, checklist, answer, outcome, created_at, processed_at "
                "FROM episodes WHERE (? = 0 OR processed_at IS NULL) ORDER BY created_at DESC LIMIT ?",
                (int(unprocessed_only), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_episode_processed(self, episode_id: int) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE episodes SET processed_at = ? WHERE id = ?", (time.time(), episode_id))

    def recall(self, query: str, limit: int = 5) -> dict[str, list[dict[str, Any]]]:
        """Return what memory holds for a request: user memory, matching facts, and similar past episodes."""
        recalled: dict[str, list[dict[str, Any]]] = {
            "user": self.user_memories(limit=10),
            "facts": [],
            "episodes": [],
        }
        terms = _search_terms(query)
        now = time.time()
        with self._connect() as connection:
            if terms:
                rows = connection.execute(
                    "SELECT m.kind, m.item_id, m.body FROM memory_search m "
                    "WHERE memory_search MATCH ? ORDER BY rank LIMIT ?",
                    (_match_expression(terms), limit * 8),
                ).fetchall()
                for row in rows:
                    if not _shares_half_the_terms(terms, row["body"]):
                        continue
                    if row["kind"] == "fact" and len(recalled["facts"]) < limit:
                        fact = connection.execute(
                            "SELECT f.id, f.statement, f.confidence, f.topic_id, t.name AS topic, "
                            "s.url AS source_url FROM facts f JOIN topics t ON t.id = f.topic_id "
                            "LEFT JOIN sources s ON s.id = f.source_id "
                            "WHERE f.id = ? AND f.status = 'active'",
                            (row["item_id"],),
                        ).fetchone()
                        if fact:
                            recalled["facts"].append(dict(fact))
                    elif row["kind"] == "episode" and len(recalled["episodes"]) < min(limit, 3):
                        episode = connection.execute(
                            "SELECT id, prompt, task_type, outcome, created_at FROM episodes WHERE id = ?",
                            (row["item_id"],),
                        ).fetchone()
                        if episode:
                            recalled["episodes"].append(dict(episode))
            # Usage counts let the background worker refresh and keep what is actually used.
            connection.executemany(
                "UPDATE facts SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
                [(now, fact["id"]) for fact in recalled["facts"]],
            )
            connection.executemany(
                "UPDATE topics SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
                [(now, topic_id) for topic_id in {fact["topic_id"] for fact in recalled["facts"]}],
            )
            connection.executemany(
                "UPDATE user_memory SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
                [(now, memory["id"]) for memory in recalled["user"]],
            )
        return recalled

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

    @staticmethod
    def _index_memory(connection: sqlite3.Connection, kind: str, item_id: int, body: str) -> None:
        connection.execute("DELETE FROM memory_search WHERE kind = ? AND item_id = ?", (kind, item_id))
        connection.execute(
            "INSERT INTO memory_search(body, kind, item_id) VALUES (?, ?, ?)", (body, kind, item_id)
        )

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