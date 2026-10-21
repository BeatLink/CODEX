import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

from .embeddings import Embedder, pack

try:
    import sqlite_vec
except ImportError:
    sqlite_vec = None

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
    """
    ALTER TABLE episodes ADD COLUMN task_tree TEXT NOT NULL DEFAULT '';
    """,
    """
    ALTER TABLE topics ADD COLUMN placed_at REAL;
    ALTER TABLE user_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    CREATE TABLE consolidation_checks (
        kind TEXT NOT NULL,
        first_id INTEGER NOT NULL,
        second_id INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        checked_at REAL NOT NULL,
        PRIMARY KEY (kind, first_id, second_id)
    );
    """,
    """
    CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY,
        prompt TEXT NOT NULL,
        options TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        tasks_done INTEGER NOT NULL DEFAULT 0,
        tasks_total INTEGER NOT NULL DEFAULT 0,
        started_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    """,
    """
    CREATE TABLE embeddings (
        kind TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        body TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (kind, item_id)
    );
    """,
    """
    ALTER TABLE user_memory ADD COLUMN reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE user_memory ADD COLUMN origin TEXT NOT NULL DEFAULT 'learned';
    ALTER TABLE user_memory ADD COLUMN scope TEXT NOT NULL DEFAULT '';
    ALTER TABLE episodes ADD COLUMN scope TEXT NOT NULL DEFAULT '';
    """,
)

MEMORY_KINDS = ("fact", "episode")
# A task tree run is running until it ends; a run left running by a crash, or stopped, can be resumed.
TASK_RUN_STATUSES = ("running", "stopped", "finished", "discarded")
RESUMABLE_TASK_RUN_STATUSES = ("running", "stopped")
USER_MEMORY_KINDS = ("preference", "project", "correction", "reference")
# A memory the user stated outright is trusted over one the background worker learned.
USER_MEMORY_ORIGINS = ("learned", "user")
# User memories recalled for one request.
MAX_RECALLED_USER_MEMORIES = 10

# What consolidation compares: two topics, two facts under one topic, or two user memories.
CONSOLIDATION_KINDS = ("topic", "fact", "memory")

# Two items sharing at least this share of their words are compared by the model.
SIMILAR_OVERLAP = 0.5

# Facts this weak are pruned once they have gone unused for the configured number of days.
PRUNE_BELOW_CONFIDENCE = 0.5
# Eviction stops below this share of the size cap, so the next few runs do not each evict again.
EVICT_TO_SHARE_OF_CAP = 0.9
EVICT_BATCH_SIZE = 100

# A topic name longer than this reads as a query or a sentence rather than a title.
MAX_TOPIC_NAME_WORDS = 5
MAX_TOPIC_NAME_CHARS = 40


def _search_terms(query: str) -> list[str]:
    return list(dict.fromkeys(
        term for term in re.findall(r"\w{2,}", query.casefold())
        if term not in _SEARCH_STOPWORDS
    ))[:12]


def _match_expression(terms: list[str]) -> str:
    return " OR ".join('"' + term.replace('"', '""') + '"' for term in terms)


def _comparison_terms(text: str) -> frozenset[str]:
    """Return the meaningful words of a short text, with a plural 's' dropped, for comparing two items."""
    return frozenset(
        term[:-1] if len(term) > 3 and term.endswith("s") else term
        for term in re.findall(r"\w{2,}", text.casefold())
        if term not in _SEARCH_STOPWORDS
    )


def _overlap(first: frozenset[str], second: frozenset[str]) -> float:
    return len(first & second) / len(first | second) if first or second else 0.0


def _same_wording(statement: str) -> str:
    return " ".join(re.findall(r"\w+", statement.casefold()))


def _shared_term_count(terms: list[str], text: str) -> int:
    words = set(re.findall(r"\w{2,}", text.casefold()))
    return sum(term in words for term in terms)


def _shares_half_the_terms(terms: list[str], text: str) -> bool:
    """A stored item counts as relevant only when it shares at least half of the query's terms."""
    return _shared_term_count(terms, text) >= (len(terms) + 1) // 2


# A topic recalled this often, and used since it was last researched, is refreshed in half the time.
OFTEN_USED_TOPIC_COUNT = 5

# How long a stored search result is trusted before it should be looked up again.
SOURCE_TTL_SECONDS = 7 * 24 * 3600

# Graph relationships recalled beside the facts that name their entities.
MAX_RECALLED_RELATIONSHIPS = 5

# Cosine similarity a stored item needs to the query to count as related; unrelated text scores about 0.3.
FACT_SIMILARITY = 0.45
TOPIC_SIMILARITY = 0.5

# Cosine similarity at which two topics or two facts under one topic are worth comparing as duplicates;
# paraphrases scored 0.81 to 0.98 with Qwen3-Embedding-0.6B, and related but different texts about 0.55.
DUPLICATE_SIMILARITY = 0.75

# Reciprocal rank fusion's damping constant: higher values weigh the top ranks less.
FUSION_RANK_OFFSET = 60

# A remembered fact is one short sentence, so a long request can only ever share a few words with it.
RECALL_MIN_SHARED_TERMS = 3


def _fuse_rankings(*rankings: list[int]) -> list[int]:
    """Merge ranked lists of ids by reciprocal rank, so an item near the top of either comes first."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, item_id in enumerate(dict.fromkeys(ranking)):
            scores[item_id] = scores.get(item_id, 0.0) + 1.0 / (FUSION_RANK_OFFSET + rank)
    return sorted(scores, key=lambda item_id: -scores[item_id])


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class KnowledgeStore:
    def __init__(self, database_path: str | Path, embedder: Embedder | None = None):
        self.path = Path(database_path).expanduser()
        # Vectors are searched with sqlite-vec, so without it retrieval stays lexical.
        self.embedder = embedder if sqlite_vec is not None else None
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
        if sqlite_vec is not None:
            connection.enable_load_extension(True)
            sqlite_vec.load(connection)
            connection.enable_load_extension(False)
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
        """Queue topics whose research is old, refreshing often-used ones sooner and ahead of the rest."""
        cutoff = time.time() - refresh_interval_hours * 3600
        often_used_cutoff = time.time() - refresh_interval_hours * 1800
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
                "AND (t.last_researched_at IS NULL OR t.last_researched_at <= ? "
                "OR (t.use_count >= ? AND t.last_used_at > t.last_researched_at AND t.last_researched_at <= ?)) "
                "AND NOT EXISTS (SELECT 1 FROM research_queue q WHERE q.topic_id = t.id "
                "AND q.status = 'pending') "
                "ORDER BY t.priority DESC, COALESCE(t.last_used_at > t.last_researched_at, 0) DESC, "
                "t.use_count DESC, t.name LIMIT ?",
                (cutoff, OFTEN_USED_TOPIC_COUNT, often_used_cutoff, available_slots),
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
        ttl_seconds: int = SOURCE_TTL_SECONDS,
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
            previous = connection.execute(
                "SELECT id, status FROM facts WHERE topic_id = ? AND statement = ?", (topic_id, statement)
            ).fetchone()
            if previous and previous["status"] != "active":
                # A fact learned again after being set aside is compared afresh.
                self._forget_checks(connection, "fact", previous["id"])
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

    def has_facts(self, topic: str) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM facts f JOIN topics t ON t.id = f.topic_id "
                "WHERE t.name = ? AND f.status = 'active' LIMIT 1",
                (topic,),
            ).fetchone()
        return row is not None

    def set_topic_summary(self, topic: str, summary: str) -> None:
        topic_id = self.add_topic(topic)
        with self._connect() as connection:
            connection.execute("UPDATE topics SET summary = ? WHERE id = ?", (summary.strip()[:4000], topic_id))

    def set_source_summary(self, url: str, summary: str) -> None:
        """Store a summary of one fetched page on its source, and make it searchable."""
        with self._connect() as connection:
            row = connection.execute("SELECT id, title, snippet FROM sources WHERE url = ?", (url,)).fetchone()
            if row is None:
                return
            summary = summary.strip()[:4000]
            connection.execute("UPDATE sources SET summary = ? WHERE id = ?", (summary, row["id"]))
            connection.execute("DELETE FROM knowledge_search WHERE rowid = ?", (row["id"],))
            connection.execute(
                "INSERT INTO knowledge_search(rowid, title, body, url) VALUES (?, ?, ?, ?)",
                (row["id"], row["title"], f"{row['snippet']} {summary}", url),
            )

    def child_summaries(self, parent: str) -> list[tuple[str, str]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT c.name, c.summary FROM topics c JOIN topics p ON p.id = c.parent_id "
                "WHERE p.name = ? COLLATE NOCASE AND c.summary != '' ORDER BY c.use_count DESC, c.name",
                (parent,),
            ).fetchall()
        return [(row["name"], row["summary"]) for row in rows]

    def add_user_memory(
        self,
        kind: str,
        statement: str,
        reason: str = "",
        origin: str = "learned",
        scope: str = "",
    ) -> int:
        """Remember a durable fact about the user: a preference, a project, a correction, or a reference.

        The reason says why it holds, and a scope of a project folder keeps it to requests worked there.
        """
        if kind not in USER_MEMORY_KINDS:
            raise ValueError(f"kind must be one of: {', '.join(USER_MEMORY_KINDS)}.")
        if origin not in USER_MEMORY_ORIGINS:
            raise ValueError(f"origin must be one of: {', '.join(USER_MEMORY_ORIGINS)}.")
        statement = " ".join(self._clean_text(statement, "memory", 500).split())
        reason = " ".join(reason.split())[:500]
        with self._connect() as connection:
            previous = connection.execute(
                "SELECT id, status FROM user_memory WHERE statement = ? COLLATE NOCASE", (statement,)
            ).fetchone()
            if previous and previous["status"] != "active":
                self._forget_checks(connection, "memory", previous["id"])
            # Learning a memory again never takes away what the user said about it.
            connection.execute(
                "INSERT INTO user_memory(kind, statement, reason, origin, scope, created_at) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(statement) DO UPDATE SET kind = excluded.kind, status = 'active', "
                "reason = CASE WHEN excluded.reason != '' THEN excluded.reason ELSE user_memory.reason END, "
                "origin = CASE WHEN user_memory.origin = 'user' THEN 'user' ELSE excluded.origin END, "
                "scope = CASE WHEN user_memory.origin = 'user' AND excluded.origin != 'user' "
                "THEN user_memory.scope ELSE excluded.scope END",
                (kind, statement, reason, origin, scope, time.time()),
            )
            return int(connection.execute(
                "SELECT id FROM user_memory WHERE statement = ? COLLATE NOCASE", (statement,)
            ).fetchone()["id"])

    def user_memories(self, limit: int = 50, scope: str | None = None) -> list[dict[str, Any]]:
        """List active user memories, newest first; with a scope, only global ones and those of that project."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, kind, statement, reason, origin, scope, created_at, use_count FROM user_memory "
                "WHERE status = 'active' AND (? IS NULL OR scope IN ('', ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
                (scope, scope, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def relevant_user_memories(
        self, query: str, scope: str = "", limit: int = MAX_RECALLED_USER_MEMORIES
    ) -> list[dict[str, Any]]:
        """Return the user memories that matter most for a request.

        Memories sharing the most words with it come first, then those the user stated, then the newest,
        so a new memory is never crowded out by older ones that were recalled more often.
        """
        terms = _search_terms(query)
        memories = self.user_memories(limit=10_000, scope=scope)
        ranked = sorted(
            memories,
            key=lambda memory: (
                -_shared_term_count(terms, f"{memory['statement']} {memory['reason']}"),
                memory["origin"] != "user",
                -memory["created_at"],
                -memory["id"],
            ),
        )
        return ranked[:limit]

    def forget_user_memory(self, memory_id: int) -> bool:
        """Delete one user memory for good; return whether it existed."""
        with self._connect() as connection:
            deleted = connection.execute("DELETE FROM user_memory WHERE id = ?", (memory_id,)).rowcount
            self._forget_checks(connection, "memory", memory_id)
        return bool(deleted)

    def record_episode(
        self,
        prompt: str,
        task_type: str,
        checklist: str,
        answer: str,
        outcome: str,
        task_tree: str = "",
        scope: str = "",
    ) -> int:
        """Remember one finished request so later requests and the background worker can learn from it.

        The scope is the project folder the request was worked in, so what it shows about a project stays there.
        """
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO episodes(prompt, task_type, checklist, answer, outcome, task_tree, scope, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (prompt[:4000], task_type, checklist[:4000], answer[:4000], outcome[:500], task_tree, scope, time.time()),
            )
            episode_id = int(cursor.lastrowid)
            self._index_memory(connection, "episode", episode_id, f"{prompt[:4000]} {checklist[:4000]}")
            return episode_id

    def episodes(self, unprocessed_only: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, prompt, task_type, checklist, answer, outcome, task_tree, scope, created_at, processed_at "
                "FROM episodes WHERE (? = 0 OR processed_at IS NULL) ORDER BY created_at DESC LIMIT ?",
                (int(unprocessed_only), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def start_task_run(self, prompt: str, options: dict[str, Any]) -> int:
        """Open a checkpoint for a task tree run, holding what is needed to start it again."""
        now = time.time()
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO task_runs(prompt, options, started_at, updated_at) VALUES (?, ?, ?, ?)",
                (prompt, json.dumps(options), now, now),
            )
            return int(cursor.lastrowid)

    def save_task_run(self, run_id: int, state: dict[str, Any], tasks_done: int, tasks_total: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE task_runs SET state = ?, tasks_done = ?, tasks_total = ?, updated_at = ? WHERE id = ?",
                (json.dumps(state, ensure_ascii=False), tasks_done, tasks_total, time.time(), run_id),
            )

    def set_task_run_status(self, run_id: int, status: str) -> None:
        if status not in TASK_RUN_STATUSES:
            raise ValueError(f"Unknown task run status: {status}")
        with self._connect() as connection:
            connection.execute(
                "UPDATE task_runs SET status = ?, updated_at = ? WHERE id = ?", (status, time.time(), run_id)
            )

    def task_run(self, run_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM task_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            return None
        run = dict(row)
        run["options"] = json.loads(run["options"])
        run["state"] = json.loads(run["state"]) if run["state"] else None
        return run

    def unfinished_task_runs(self, limit: int = 10) -> list[dict[str, Any]]:
        """List task tree runs that can be resumed, newest first, without their saved state."""
        placeholders = ", ".join("?" for _ in RESUMABLE_TASK_RUN_STATUSES)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, prompt, status, tasks_done, tasks_total, started_at, updated_at FROM task_runs "
                f"WHERE status IN ({placeholders}) ORDER BY updated_at DESC LIMIT ?",
                (*RESUMABLE_TASK_RUN_STATUSES, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_episode_processed(self, episode_id: int) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE episodes SET processed_at = ? WHERE id = ?", (time.time(), episode_id))

    def recall(
        self, query: str, limit: int = 5, include_user: bool = True, scope: str = ""
    ) -> dict[str, list[dict[str, Any]]]:
        """Return what memory holds for a request: user memory, matching facts, and similar past episodes.

        An item matches when it shares half the query's terms, or three of them for a longer query,
        and the items sharing the most terms come first. User memory is limited to global memories and
        those of the scope's project.
        """
        recalled: dict[str, list[dict[str, Any]]] = {
            "user": self.relevant_user_memories(query, scope) if include_user else [],
            "facts": [],
            "episodes": [],
            "relationships": [],
        }
        terms = _search_terms(query)
        query_vector = self._query_vector(query)
        now = time.time()
        with self._connect() as connection:
            lexical_fact_ids = []
            if terms:
                rows = connection.execute(
                    "SELECT m.kind, m.item_id, m.body FROM memory_search m "
                    "WHERE memory_search MATCH ? ORDER BY rank LIMIT ?",
                    # Rows sharing too few terms are dropped below, so FTS5 is asked for plenty.
                    (_match_expression(terms), limit * 20),
                ).fetchall()
                needed = min(RECALL_MIN_SHARED_TERMS, (len(terms) + 1) // 2)
                counted = [(_shared_term_count(terms, row["body"]), row) for row in rows]
                # The sort is stable, so items sharing as many terms keep their FTS5 rank order.
                ranked = sorted((pair for pair in counted if pair[0] >= needed), key=lambda pair: -pair[0])
                for _, row in ranked:
                    if row["kind"] == "fact":
                        lexical_fact_ids.append(row["item_id"])
                    elif row["kind"] == "episode" and len(recalled["episodes"]) < min(limit, 3):
                        episode = connection.execute(
                            "SELECT id, prompt, task_type, outcome, created_at FROM episodes WHERE id = ?",
                            (row["item_id"],),
                        ).fetchone()
                        if episode:
                            recalled["episodes"].append(dict(episode))
            vector_fact_ids = self._similar_items(connection, "fact", query_vector, limit * 4, FACT_SIMILARITY)
            for fact_id in _fuse_rankings(lexical_fact_ids, vector_fact_ids):
                if len(recalled["facts"]) == limit:
                    break
                fact = self._recalled_fact(connection, fact_id, now)
                if fact:
                    recalled["facts"].append(fact)
            if len(recalled["facts"]) < limit:
                shown = {fact["id"] for fact in recalled["facts"]}
                branch_ids = self._branch_fact_ids(
                    connection, terms, shown, limit - len(recalled["facts"]), query_vector
                )
                for fact_id in branch_ids:
                    fact = self._recalled_fact(connection, fact_id, now)
                    if fact:
                        recalled["facts"].append(fact)
            recalled["relationships"] = self._relationships_named_in(
                connection, [fact["statement"] for fact in recalled["facts"]]
            )
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

    # ==========================================================================
    # Consolidation
    # ==========================================================================

    def tidy(self, prune_after_days: int, max_pending: int = 100, max_megabytes: int | None = None) -> dict[str, int]:
        """Make every change that needs no model: break parent loops, merge exact duplicates, research empty topics, prune stale facts, and evict to fit the size cap."""
        with self._connect() as connection:
            changes = {
                "parent loops broken": self._break_topic_loops(connection),
                "topics merged": self._merge_same_named_topics(connection),
                "facts merged": self._merge_same_worded_facts(connection),
                "empty topics queued for research": self._queue_empty_topics(connection, max_pending),
            }
            changes["facts pruned"] = connection.execute(
                "UPDATE facts SET status = 'pruned' WHERE status = 'active' AND use_count = 0 "
                "AND confidence < ? AND created_at < ?",
                (PRUNE_BELOW_CONFIDENCE, time.time() - prune_after_days * 86400),
            ).rowcount
            if max_megabytes is not None:
                changes["items evicted to fit the size cap"] = self._evict_to_fit(connection, max_megabytes * 1024 * 1024)
        return {name: count for name, count in changes.items() if count}

    # ==========================================================================
    # Keeping the store under its size cap
    # ==========================================================================

    @staticmethod
    def _live_bytes(connection: sqlite3.Connection) -> int:
        """Return the bytes the store's data uses, leaving out pages freed by earlier deletes."""
        page_count = connection.execute("PRAGMA page_count").fetchone()[0]
        free_pages = connection.execute("PRAGMA freelist_count").fetchone()[0]
        return (page_count - free_pages) * connection.execute("PRAGMA page_size").fetchone()[0]

    def _evict_to_fit(self, connection: sqlite3.Connection, max_bytes: int) -> int:
        """Delete the least valuable rows, least valuable kind first, until the store fits under its cap."""
        if self._live_bytes(connection) <= max_bytes:
            return 0
        target = int(max_bytes * EVICT_TO_SHARE_OF_CAP)
        placeholders = ", ".join("?" for _ in RESUMABLE_TASK_RUN_STATUSES)
        candidates = (
            ("fact", "SELECT id FROM facts WHERE status = 'pruned' ORDER BY created_at LIMIT ?", ()),
            (
                "task_run",
                f"SELECT id FROM task_runs WHERE status NOT IN ({placeholders}) ORDER BY updated_at LIMIT ?",
                RESUMABLE_TASK_RUN_STATUSES,
            ),
            ("episode", "SELECT id FROM episodes WHERE processed_at IS NOT NULL ORDER BY created_at LIMIT ?", ()),
            (
                "source",
                "SELECT id FROM sources WHERE expires_at < ? AND id NOT IN "
                "(SELECT source_id FROM facts WHERE source_id IS NOT NULL) ORDER BY retrieved_at LIMIT ?",
                (time.time(),),
            ),
            (
                "fact",
                "SELECT id FROM facts ORDER BY status = 'active', use_count, COALESCE(last_used_at, created_at) LIMIT ?",
                (),
            ),
        )
        evicted = 0
        for kind, query, parameters in candidates:
            while self._live_bytes(connection) > target:
                ids = [row[0] for row in connection.execute(query, (*parameters, EVICT_BATCH_SIZE))]
                if not ids:
                    break
                for item_id in ids:
                    self._delete_item(connection, kind, item_id)
                evicted += len(ids)
                # A full-text index only marks deleted rows, so it is merged for their pages to be freed.
                index = "knowledge_search" if kind == "source" else "memory_search"
                connection.execute(f"INSERT INTO {index}({index}) VALUES ('optimize')")
            if self._live_bytes(connection) <= target:
                break
        return evicted

    @staticmethod
    def _delete_item(connection: sqlite3.Connection, kind: str, item_id: int) -> None:
        """Delete one row together with its search entries, vector, and graph links."""
        if kind == "fact":
            connection.execute("DELETE FROM facts WHERE id = ?", (item_id,))
            connection.execute(
                "DELETE FROM consolidation_checks WHERE kind = 'fact' AND (first_id = ? OR second_id = ?)",
                (item_id, item_id),
            )
        elif kind == "episode":
            connection.execute("DELETE FROM episodes WHERE id = ?", (item_id,))
        elif kind == "task_run":
            connection.execute("DELETE FROM task_runs WHERE id = ?", (item_id,))
            return
        else:
            url = connection.execute("SELECT url FROM sources WHERE id = ?", (item_id,)).fetchone()[0]
            connection.execute("DELETE FROM knowledge_search WHERE rowid = ?", (item_id,))
            # Removing the source's node also removes every edge to it.
            connection.execute("DELETE FROM graph_nodes WHERE kind = 'source' AND label = ?", (url,))
            connection.execute("DELETE FROM sources WHERE id = ?", (item_id,))
            return
        connection.execute("DELETE FROM memory_search WHERE kind = ? AND item_id = ?", (kind, item_id))
        connection.execute("DELETE FROM embeddings WHERE kind = ? AND item_id = ?", (kind, item_id))

    def next_unchecked_pair(self, kind: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """Return the most alike pair of the given kind that the model has not compared yet."""
        if kind not in CONSOLIDATION_KINDS:
            raise ValueError(f"kind must be one of: {', '.join(CONSOLIDATION_KINDS)}.")
        with self._connect() as connection:
            checked = {
                (row["first_id"], row["second_id"])
                for row in connection.execute(
                    "SELECT first_id, second_id FROM consolidation_checks WHERE kind = ?", (kind,)
                )
            }
            if kind == "topic":
                rows = connection.execute("SELECT id, name, summary, parent_id, 0 AS grouping FROM topics").fetchall()
                text_column = "name"
            elif kind == "fact":
                rows = connection.execute(
                    "SELECT f.id, f.statement, f.confidence, f.topic_id AS grouping, t.name AS topic "
                    "FROM facts f JOIN topics t ON t.id = f.topic_id WHERE f.status = 'active'"
                ).fetchall()
                text_column = "statement"
            else:
                rows = connection.execute(
                    # A project's memories are compared only with that project's, so one project never sets aside another's.
                    "SELECT id, kind, statement, created_at, scope AS grouping FROM user_memory WHERE status = 'active'"
                ).fetchall()
                text_column = "statement"
        items = {row["id"]: dict(row) for row in rows}
        terms = {item_id: _comparison_terms(item[text_column]) for item_id, item in items.items()}
        # Only items sharing a word, in the same group, can be alike, so the index keeps this from comparing every pair.
        index: dict[tuple[int, str], list[int]] = {}
        for item_id in sorted(items):
            for term in terms[item_id]:
                index.setdefault((items[item_id]["grouping"], term), []).append(item_id)
        candidates = {}
        for item_ids in index.values():
            for position, first_id in enumerate(item_ids):
                for second_id in item_ids[position + 1:]:
                    if (first_id, second_id) in checked or (first_id, second_id) in candidates:
                        continue
                    first, second = items[first_id], items[second_id]
                    overlap = _overlap(terms[first_id], terms[second_id])
                    if kind == "topic":
                        if first["id"] == second["parent_id"] or second["id"] == first["parent_id"]:
                            continue
                        # A name inside another, such as SQLite in SQLite FTS5, may be the broader topic.
                        if terms[first_id] <= terms[second_id] or terms[second_id] <= terms[first_id]:
                            overlap = max(overlap, SIMILAR_OVERLAP)
                    if overlap >= SIMILAR_OVERLAP:
                        candidates[(first_id, second_id)] = overlap
        # Pairs worded differently but close in meaning are compared too.
        for first_id, second_id, similarity in self._similar_pairs(kind):
            if first_id in items and second_id in items and (first_id, second_id) not in checked:
                if kind == "topic" and (
                    first_id == items[second_id]["parent_id"] or second_id == items[first_id]["parent_id"]
                ):
                    continue
                candidates[(first_id, second_id)] = max(candidates.get((first_id, second_id), 0.0), similarity)
        if not candidates:
            return None
        first_id, second_id = min(candidates, key=lambda pair: (-candidates[pair], pair))
        return items[first_id], items[second_id]

    def _similar_pairs(self, kind: str) -> list[tuple[int, int, float]]:
        """Return pairs of topics, or of facts under one topic, whose vectors are close, lower id first."""
        if sqlite_vec is None or kind not in ("topic", "fact"):
            return []
        same_group = (
            "JOIN facts fa ON fa.id = a.item_id JOIN facts fb ON fb.id = b.item_id AND fb.topic_id = fa.topic_id "
            if kind == "fact" else ""
        )
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT a.item_id AS first_id, b.item_id AS second_id, "
                "1 - vec_distance_cosine(a.vector, b.vector) AS similarity "
                f"FROM embeddings a JOIN embeddings b ON b.kind = a.kind AND b.item_id > a.item_id "
                f"AND b.model = a.model AND length(b.vector) = length(a.vector) {same_group}"
                "WHERE a.kind = ? AND 1 - vec_distance_cosine(a.vector, b.vector) >= ?",
                (kind, DUPLICATE_SIMILARITY),
            ).fetchall()
        return [(row["first_id"], row["second_id"], row["similarity"]) for row in rows]

    def record_check(self, kind: str, first_id: int, second_id: int, verdict: str) -> None:
        first_id, second_id = sorted((first_id, second_id))
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO consolidation_checks(kind, first_id, second_id, verdict, checked_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (kind, first_id, second_id, verdict, time.time()),
            )

    def merge_topics(self, first_id: int, second_id: int) -> str:
        """Fold two topics that name one subject into the one with more behind it, returning its name."""
        with self._connect() as connection:
            keep_id, drop_id = self._rank_topics(connection, first_id, second_id)
            self._merge_topic_into(connection, keep_id, drop_id)
            return connection.execute("SELECT name FROM topics WHERE id = ?", (keep_id,)).fetchone()["name"]

    def adopt_topic(self, parent_id: int, child_id: int) -> bool:
        """File a topic under a broader one when that narrows where it sits now; return whether it moved."""
        with self._connect() as connection:
            child = connection.execute("SELECT parent_id FROM topics WHERE id = ?", (child_id,)).fetchone()
            if child is None or parent_id in self._descendant_ids(connection, child_id) | {child_id}:
                return False
            current_parent = child["parent_id"]
            if current_parent == parent_id:
                return False
            if current_parent is not None and current_parent not in self._ancestor_ids(connection, parent_id):
                return False
            self._set_parent(connection, child_id, parent_id)
            return True

    def set_topic_parent(self, topic_id: int, parent_id: int | None) -> bool:
        """Move a topic under another, or to the top level; return whether it moved."""
        with self._connect() as connection:
            row = connection.execute("SELECT parent_id FROM topics WHERE id = ?", (topic_id,)).fetchone()
            if row is None or row["parent_id"] == parent_id:
                return False
            if parent_id is not None and parent_id in self._descendant_ids(connection, topic_id) | {topic_id}:
                return False
            self._set_parent(connection, topic_id, parent_id)
            return True

    def next_topic_to_place(self, reviewed_before: float) -> dict[str, Any] | None:
        """Return the topic whose place in the tree has gone longest without review, if any is due."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT t.id, t.name, t.summary, t.parent_id, p.name AS parent, "
                "EXISTS (SELECT 1 FROM sources s WHERE s.topic_id = t.id) AS researched FROM topics t "
                "LEFT JOIN topics p ON p.id = t.parent_id "
                "WHERE t.placed_at IS NULL OR t.placed_at < ? "
                "ORDER BY t.placed_at IS NOT NULL, t.placed_at, t.use_count DESC, t.id LIMIT 1",
                (reviewed_before,),
            ).fetchone()
            if row is None:
                return None
            topic = dict(row)
            topic["children"] = [
                child["name"] for child in connection.execute(
                    "SELECT name FROM topics WHERE parent_id = ? ORDER BY name", (topic["id"],)
                )
            ]
            return topic

    def placement_candidates(self, topic_id: int, limit: int = 20) -> list[dict[str, Any]]:
        """Return the topics this one could sit under, the most related first, with the current parent kept in."""
        with self._connect() as connection:
            topic = connection.execute("SELECT name, summary, parent_id FROM topics WHERE id = ?", (topic_id,)).fetchone()
            if topic is None:
                return []
            excluded = self._descendant_ids(connection, topic_id) | {topic_id}
            rows = [
                dict(row) for row in connection.execute("SELECT id, name, summary, parent_id FROM topics")
                if row["id"] not in excluded
            ]
        terms = _comparison_terms(f"{topic['name']} {topic['summary']}")

        def rank(row: dict[str, Any]) -> tuple[bool, int, bool, str]:
            return (
                row["id"] != topic["parent_id"],
                -len(terms & _comparison_terms(row["name"])),
                row["parent_id"] is not None,
                row["name"].casefold(),
            )

        return sorted(rows, key=rank)[:limit]

    def next_topic_to_name(self) -> dict[str, Any] | None:
        """Return the most used topic named after its search query or too long for a title, with its best facts.

        Topics with neither a summary nor facts wait, since there is nothing yet to name them from.
        """
        with self._connect() as connection:
            row = connection.execute(
                "SELECT t.id, t.name, t.summary FROM topics t "
                "WHERE (EXISTS (SELECT 1 FROM sources s WHERE s.query = t.name COLLATE NOCASE) "
                "OR length(t.name) > ? OR length(t.name) - length(replace(t.name, ' ', '')) >= ?) "
                "AND NOT EXISTS (SELECT 1 FROM consolidation_checks c WHERE c.kind = 'name' AND c.first_id = t.id) "
                "AND (t.summary != '' OR EXISTS (SELECT 1 FROM facts f WHERE f.topic_id = t.id AND f.status = 'active')) "
                "ORDER BY t.use_count DESC, t.id LIMIT 1",
                (MAX_TOPIC_NAME_CHARS, MAX_TOPIC_NAME_WORDS),
            ).fetchone()
            if row is None:
                return None
            topic = dict(row)
            topic["facts"] = [
                fact["statement"] for fact in connection.execute(
                    "SELECT statement FROM facts WHERE topic_id = ? AND status = 'active' "
                    "ORDER BY confidence DESC, use_count DESC, id LIMIT 5",
                    (topic["id"],),
                )
            ]
            return topic

    def rename_topic(self, topic_id: int, name: str) -> str:
        """Rename a topic, or fold it into the topic that already has that name; return the name it ends up under."""
        name = self._clean_text(name, "topic", 200)
        with self._connect() as connection:
            old_name = connection.execute("SELECT name FROM topics WHERE id = ?", (topic_id,)).fetchone()["name"]
            other = connection.execute(
                "SELECT id, name FROM topics WHERE name = ? COLLATE NOCASE AND id != ?", (name, topic_id)
            ).fetchone()
            if other is not None:
                self._merge_topic_into(connection, other["id"], topic_id)
                return other["name"]
            old_node = self._node_id(connection, "topic", old_name)
            connection.execute("UPDATE topics SET name = ? WHERE id = ?", (name, topic_id))
            new_node = self._node_id(connection, "topic", name)
            if new_node != old_node:
                connection.execute("UPDATE OR IGNORE graph_edges SET source_node_id = ? WHERE source_node_id = ?", (new_node, old_node))
                connection.execute("UPDATE OR IGNORE graph_edges SET target_node_id = ? WHERE target_node_id = ?", (new_node, old_node))
                connection.execute("DELETE FROM graph_nodes WHERE id = ?", (old_node,))
            return name

    def remove_unsupported_topic(self, topic_id: int) -> bool:
        """Delete a topic that holds no active facts and no subtopics, keeping its sources; return whether it went."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT name FROM topics t WHERE id = ? "
                "AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.topic_id = t.id AND f.status = 'active') "
                "AND NOT EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id)",
                (topic_id,),
            ).fetchone()
            if row is None:
                return False
            self._delete_topic(connection, topic_id, row["name"])
            return True

    def mark_topic_placed(self, topic_id: int) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = ? WHERE id = ?", (time.time(), topic_id))

    def merge_facts(self, first_id: int, second_id: int) -> None:
        """Fold two facts that say the same thing into the more trusted one."""
        with self._connect() as connection:
            self._merge_fact_into(connection, *self._rank_facts(connection, first_id, second_id))

    def dispute_facts(self, first_id: int, second_id: int) -> str:
        """Set aside the less trusted of two contradicting facts, or both when neither is more trusted; return their topic."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT f.id, f.confidence, t.name AS topic FROM facts f JOIN topics t ON t.id = f.topic_id "
                "WHERE f.id IN (?, ?) ORDER BY f.confidence DESC",
                (first_id, second_id),
            ).fetchall()
            if not rows:
                return ""
            disputed = [row["id"] for row in rows if row["confidence"] == rows[-1]["confidence"]]
            connection.executemany("UPDATE facts SET status = 'disputed' WHERE id = ?", [(item,) for item in disputed])
            return rows[0]["topic"]

    def merge_user_memories(self, first_id: int, second_id: int) -> None:
        """Fold two memories that say the same thing into the more used one, or the newer when used equally."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, use_count, last_used_at FROM user_memory WHERE id IN (?, ?) "
                "ORDER BY use_count DESC, created_at DESC, id DESC",
                (first_id, second_id),
            ).fetchall()
            if len(rows) != 2:
                return
            keep, drop = rows
            connection.execute(
                "UPDATE user_memory SET use_count = use_count + ?, last_used_at = MAX(COALESCE(last_used_at, 0), ?) "
                "WHERE id = ?",
                (drop["use_count"], drop["last_used_at"] or 0, keep["id"]),
            )
            connection.execute("DELETE FROM user_memory WHERE id = ?", (drop["id"],))
            self._forget_checks(connection, "memory", drop["id"])

    def supersede_user_memory(self, first_id: int, second_id: int) -> None:
        """Set aside the older of two contradicting memories, since the newer one reflects the user now.

        A memory the user stated outright is kept over a learned one, whichever is newer.
        """
        with self._connect() as connection:
            older = connection.execute(
                "SELECT id FROM user_memory WHERE id IN (?, ?) ORDER BY origin = 'user', created_at, id LIMIT 1",
                (first_id, second_id),
            ).fetchone()
            if older:
                connection.execute("UPDATE user_memory SET status = 'superseded' WHERE id = ?", (older["id"],))

    @staticmethod
    def _forget_checks(connection: sqlite3.Connection, kind: str, item_id: int) -> None:
        connection.execute(
            "DELETE FROM consolidation_checks WHERE kind = ? AND (first_id = ? OR second_id = ?)",
            (kind, item_id, item_id),
        )

    @staticmethod
    def _ancestor_ids(connection: sqlite3.Connection, topic_id: int) -> set[int]:
        ancestors: set[int] = set()
        row = connection.execute("SELECT parent_id FROM topics WHERE id = ?", (topic_id,)).fetchone()
        parent_id = row["parent_id"] if row else None
        while parent_id is not None and parent_id not in ancestors and parent_id != topic_id:
            ancestors.add(parent_id)
            row = connection.execute("SELECT parent_id FROM topics WHERE id = ?", (parent_id,)).fetchone()
            parent_id = row["parent_id"] if row else None
        return ancestors

    @staticmethod
    def _descendant_ids(connection: sqlite3.Connection, topic_id: int) -> set[int]:
        descendants: set[int] = set()
        frontier = [topic_id]
        while frontier:
            rows = connection.execute(
                f"SELECT id FROM topics WHERE parent_id IN ({', '.join('?' * len(frontier))})", frontier
            ).fetchall()
            frontier = [row["id"] for row in rows if row["id"] not in descendants and row["id"] != topic_id]
            descendants.update(frontier)
        return descendants

    def _set_parent(self, connection: sqlite3.Connection, topic_id: int, parent_id: int | None) -> None:
        """Move a topic and replace its 'contains' edge in the graph to match."""
        name = connection.execute("SELECT name FROM topics WHERE id = ?", (topic_id,)).fetchone()["name"]
        node_id = self._node_id(connection, "topic", name)
        connection.execute("UPDATE topics SET parent_id = ? WHERE id = ?", (parent_id, topic_id))
        connection.execute(
            "DELETE FROM graph_edges WHERE relation = 'contains' AND target_node_id = ? "
            "AND source_node_id IN (SELECT id FROM graph_nodes WHERE kind = 'topic')",
            (node_id,),
        )
        if parent_id is not None:
            parent = connection.execute("SELECT name FROM topics WHERE id = ?", (parent_id,)).fetchone()["name"]
            connection.execute(
                "INSERT OR IGNORE INTO graph_edges (source_node_id, relation, target_node_id) "
                "VALUES (?, 'contains', ?)",
                (self._node_id(connection, "topic", parent), node_id),
            )

    def _break_topic_loops(self, connection: sqlite3.Connection) -> int:
        broken = 0
        for row in connection.execute("SELECT id FROM topics WHERE parent_id IS NOT NULL").fetchall():
            if self._walks_back_to(connection, row["id"]):
                self._set_parent(connection, row["id"], None)
                broken += 1
        return broken

    @staticmethod
    def _walks_back_to(connection: sqlite3.Connection, topic_id: int) -> bool:
        seen = set()
        parent_id = topic_id
        while parent_id is not None and parent_id not in seen:
            seen.add(parent_id)
            row = connection.execute("SELECT parent_id FROM topics WHERE id = ?", (parent_id,)).fetchone()
            parent_id = row["parent_id"] if row else None
            if parent_id == topic_id:
                return True
        return False

    def _merge_same_named_topics(self, connection: sqlite3.Connection) -> int:
        """Merge topics whose names have exactly the same words, such as 'Python packaging' and 'packaging Python'."""
        by_terms: dict[frozenset[str], int] = {}
        merged = 0
        for row in connection.execute("SELECT id, name FROM topics ORDER BY id").fetchall():
            terms = _comparison_terms(row["name"])
            if not terms:
                continue
            if terms not in by_terms:
                by_terms[terms] = row["id"]
                continue
            keep_id, drop_id = self._rank_topics(connection, by_terms[terms], row["id"])
            self._merge_topic_into(connection, keep_id, drop_id)
            by_terms[terms] = keep_id
            merged += 1
        return merged

    def _merge_same_worded_facts(self, connection: sqlite3.Connection) -> int:
        """Merge active facts under one topic that differ only in case and punctuation."""
        by_wording: dict[tuple[int, str], int] = {}
        merged = 0
        for row in connection.execute(
            "SELECT id, topic_id, statement FROM facts WHERE status = 'active' ORDER BY id"
        ).fetchall():
            key = (row["topic_id"], _same_wording(row["statement"]))
            if key not in by_wording:
                by_wording[key] = row["id"]
                continue
            keep_id, drop_id = self._rank_facts(connection, by_wording[key], row["id"])
            self._merge_fact_into(connection, keep_id, drop_id)
            by_wording[key] = keep_id
            merged += 1
        return merged

    def _queue_empty_topics(self, connection: sqlite3.Connection, max_pending: int) -> int:
        """Queue research for topics with no facts, sources, or subtopics, unless research is unfinished or has failed."""
        pending_count = connection.execute(
            "SELECT COUNT(*) FROM research_queue WHERE status = 'pending'"
        ).fetchone()[0]
        rows = connection.execute(
            "SELECT id FROM topics t WHERE "
            "NOT EXISTS (SELECT 1 FROM facts f WHERE f.topic_id = t.id) "
            "AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.topic_id = t.id) "
            "AND NOT EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id) "
            "AND NOT EXISTS (SELECT 1 FROM research_queue q WHERE q.topic_id = t.id AND q.status != 'done') "
            "ORDER BY t.priority DESC, t.use_count DESC, t.id LIMIT ?",
            (max(0, max_pending - pending_count),),
        ).fetchall()
        connection.executemany(
            "INSERT OR IGNORE INTO research_queue(topic_id, requested_at) VALUES (?, ?)",
            [(row["id"], time.time()) for row in rows],
        )
        return len(rows)

    def _delete_topic(self, connection: sqlite3.Connection, topic_id: int, name: str) -> None:
        connection.execute("DELETE FROM topics WHERE id = ?", (topic_id,))
        connection.execute("DELETE FROM graph_nodes WHERE kind = 'topic' AND label = ?", (name,))
        self._forget_checks(connection, "topic", topic_id)
        self._forget_checks(connection, "name", topic_id)

    @staticmethod
    def _rank_topics(connection: sqlite3.Connection, first_id: int, second_id: int) -> tuple[int, int]:
        """Order two topics as (keep, drop): more facts, sources, and use first, then the shorter name."""
        rows = connection.execute(
            "SELECT t.id, t.name, t.use_count "
            "+ (SELECT COUNT(*) FROM facts f WHERE f.topic_id = t.id) "
            "+ (SELECT COUNT(*) FROM sources s WHERE s.topic_id = t.id) AS weight "
            "FROM topics t WHERE t.id IN (?, ?)",
            (first_id, second_id),
        ).fetchall()
        keep, drop = sorted(rows, key=lambda row: (-row["weight"], len(row["name"]), row["id"]))
        return keep["id"], drop["id"]

    def _merge_topic_into(self, connection: sqlite3.Connection, keep_id: int, drop_id: int) -> None:
        keep = connection.execute("SELECT * FROM topics WHERE id = ?", (keep_id,)).fetchone()
        drop = connection.execute("SELECT * FROM topics WHERE id = ?", (drop_id,)).fetchone()
        # Lifting the kept topic out from under the dropped one stops its old subtopics forming a loop.
        if drop_id in self._ancestor_ids(connection, keep_id):
            self._set_parent(connection, keep_id, drop["parent_id"])
        elif keep["parent_id"] is None and drop["parent_id"] not in self._descendant_ids(connection, keep_id) | {keep_id, None}:
            self._set_parent(connection, keep_id, drop["parent_id"])
        for child in connection.execute(
            "SELECT id FROM topics WHERE parent_id = ? AND id != ?", (drop_id, keep_id)
        ).fetchall():
            self._set_parent(connection, child["id"], keep_id)
        for fact in connection.execute("SELECT id, statement FROM facts WHERE topic_id = ?", (drop_id,)).fetchall():
            twin = connection.execute(
                "SELECT id FROM facts WHERE topic_id = ? AND statement = ?", (keep_id, fact["statement"])
            ).fetchone()
            if twin:
                self._merge_fact_into(connection, twin["id"], fact["id"])
            else:
                connection.execute("UPDATE facts SET topic_id = ? WHERE id = ?", (keep_id, fact["id"]))
        connection.execute("UPDATE sources SET topic_id = ? WHERE topic_id = ?", (keep_id, drop_id))
        if connection.execute(
            "SELECT 1 FROM research_queue WHERE topic_id = ? AND status = 'pending'", (keep_id,)
        ).fetchone():
            connection.execute("DELETE FROM research_queue WHERE topic_id = ? AND status = 'pending'", (drop_id,))
        connection.execute("UPDATE research_queue SET topic_id = ? WHERE topic_id = ?", (keep_id, drop_id))
        connection.execute(
            "UPDATE topics SET priority = MAX(priority, ?), use_count = use_count + ?, "
            "last_used_at = MAX(COALESCE(last_used_at, 0), ?), "
            "last_researched_at = MAX(COALESCE(last_researched_at, 0), ?), "
            "summary = CASE WHEN summary = '' THEN ? ELSE summary END WHERE id = ?",
            (drop["priority"], drop["use_count"], drop["last_used_at"] or 0,
             drop["last_researched_at"] or 0, drop["summary"], keep_id),
        )
        keep_node = self._node_id(connection, "topic", keep["name"])
        drop_node = self._node_id(connection, "topic", drop["name"])
        connection.execute("UPDATE OR IGNORE graph_edges SET source_node_id = ? WHERE source_node_id = ?", (keep_node, drop_node))
        connection.execute("UPDATE OR IGNORE graph_edges SET target_node_id = ? WHERE target_node_id = ?", (keep_node, drop_node))
        connection.execute("DELETE FROM graph_edges WHERE source_node_id = target_node_id")
        self._delete_topic(connection, drop_id, drop["name"])

    @staticmethod
    def _rank_facts(connection: sqlite3.Connection, first_id: int, second_id: int) -> tuple[int, int]:
        """Order two facts as (keep, drop): higher confidence first, then more used, then older."""
        rows = connection.execute(
            "SELECT id FROM facts WHERE id IN (?, ?) ORDER BY confidence DESC, use_count DESC, id",
            (first_id, second_id),
        ).fetchall()
        return rows[0]["id"], rows[1]["id"]

    def _merge_fact_into(self, connection: sqlite3.Connection, keep_id: int, drop_id: int) -> None:
        drop = connection.execute("SELECT * FROM facts WHERE id = ?", (drop_id,)).fetchone()
        connection.execute(
            "UPDATE facts SET confidence = MAX(confidence, ?), use_count = use_count + ?, "
            "last_used_at = MAX(COALESCE(last_used_at, 0), ?), source_id = COALESCE(source_id, ?) WHERE id = ?",
            (drop["confidence"], drop["use_count"], drop["last_used_at"] or 0, drop["source_id"], keep_id),
        )
        connection.execute("DELETE FROM facts WHERE id = ?", (drop_id,))
        connection.execute("DELETE FROM memory_search WHERE kind = 'fact' AND item_id = ?", (drop_id,))
        self._forget_checks(connection, "fact", drop_id)

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

    # ==========================================================================
    # Embeddings
    # ==========================================================================

    def _query_vector(self, query: str) -> list[float] | None:
        if self.embedder is None or not query.strip():
            return None
        try:
            return self.embedder.embed_query(query)
        except (RuntimeError, ValueError, OSError):
            # A model that will not load or run leaves retrieval lexical rather than failing the request.
            return None

    def items_to_embed(self, model: str, limit: int) -> list[tuple[str, int, str]]:
        """Return facts and topics with no vector from this model, or whose text changed since theirs was made."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT kind, item_id, body FROM ("
                "SELECT 'fact' AS kind, f.id AS item_id, f.statement AS body FROM facts f WHERE f.status = 'active' "
                "UNION ALL SELECT 'topic', t.id, t.name || ': ' || t.summary FROM topics t"
                ") items WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.kind = items.kind "
                "AND e.item_id = items.item_id AND e.model = ? AND e.body = items.body) LIMIT ?",
                (model, limit),
            ).fetchall()
        return [(row["kind"], row["item_id"], row["body"]) for row in rows]

    def save_embeddings(self, model: str, items: list[tuple[str, int, str]], vectors: list[list[float]]) -> None:
        with self._connect() as connection:
            connection.executemany(
                "INSERT INTO embeddings(kind, item_id, model, body, vector) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(kind, item_id) DO UPDATE SET model = excluded.model, body = excluded.body, "
                "vector = excluded.vector",
                [(kind, item_id, model, body, pack(vector)) for (kind, item_id, body), vector in zip(items, vectors)],
            )

    @staticmethod
    def _similar_items(
        connection: sqlite3.Connection,
        kind: str,
        query_vector: list[float] | None,
        limit: int,
        minimum_similarity: float,
    ) -> list[int]:
        """Return the items of one kind closest in meaning to the query, closest first.

        Vectors of another length come from a different model and are skipped until re-embedded.
        """
        if query_vector is None:
            return []
        rows = connection.execute(
            "SELECT item_id, 1 - vec_distance_cosine(vector, ?) AS similarity FROM embeddings "
            "WHERE kind = ? AND length(vector) = ? ORDER BY similarity DESC LIMIT ?",
            (pack(query_vector), kind, 4 * len(query_vector), limit),
        ).fetchall()
        return [row["item_id"] for row in rows if row["similarity"] >= minimum_similarity]

    @classmethod
    def _recalled_fact(cls, connection: sqlite3.Connection, fact_id: int, now: float) -> dict[str, Any] | None:
        """Load an active fact with its source, its age, and the chain of topics above it."""
        fact = connection.execute(
            "SELECT f.id, f.statement, f.confidence, f.topic_id, t.name AS topic, "
            "s.url AS source_url, COALESCE(s.retrieved_at, f.created_at) AS retrieved_at, "
            # A fact with no source ages from when it was stored, as its source would have.
            "COALESCE(s.expires_at, f.created_at + ?) < ? AS stale "
            "FROM facts f JOIN topics t ON t.id = f.topic_id "
            "LEFT JOIN sources s ON s.id = f.source_id "
            "WHERE f.id = ? AND f.status = 'active'",
            (SOURCE_TTL_SECONDS, now, fact_id),
        ).fetchone()
        if fact is None:
            return None
        return {**dict(fact), "stale": bool(fact["stale"]), "topic_path": cls._topic_path(connection, fact["topic_id"])}

    @classmethod
    def _branch_fact_ids(
        cls,
        connection: sqlite3.Connection,
        terms: list[str],
        shown: set[int],
        limit: int,
        query_vector: list[float] | None = None,
    ) -> list[int]:
        """Return the best facts from the branch of the most specific topic the query names.

        A topic counts as named when every word of its name is among the query's terms, so a
        fact under it is found even when it shares too few words with the query to match itself.
        When the query names none, the topic closest to it in meaning is used instead.
        """
        named = []
        for topic in connection.execute("SELECT id, name FROM topics").fetchall():
            name_terms = _search_terms(topic["name"])
            if name_terms and all(term in terms for term in name_terms):
                named.append((len(name_terms), topic["id"]))
        if not named:
            closest = cls._similar_items(connection, "topic", query_vector, 1, TOPIC_SIMILARITY)
            named = [(0, topic_id) for topic_id in closest]
        if not named:
            return []
        most_specific = max(count for count, _ in named)
        branch = set()
        for count, topic_id in named:
            if count == most_specific:
                branch |= {topic_id, *cls._descendant_ids(connection, topic_id)}
        marks = ", ".join("?" * len(branch))
        rows = connection.execute(
            f"SELECT id, statement, confidence, use_count FROM facts WHERE status = 'active' AND topic_id IN ({marks})",
            tuple(branch),
        ).fetchall()
        candidates = [row for row in rows if row["id"] not in shown]
        # Facts sharing the most of the query come first, then the most trusted and most used.
        candidates.sort(key=lambda row: (
            -_shared_term_count(terms, row["statement"]), -row["confidence"], -row["use_count"]
        ))
        return [row["id"] for row in candidates[:limit]]

    @staticmethod
    def _relationships_named_in(connection: sqlite3.Connection, statements: list[str]) -> list[dict[str, Any]]:
        """Return the graph relationships of every entity a statement names, one step out."""
        if not statements:
            return []
        text = " ".join(statements).casefold()
        rows = connection.execute(
            "SELECT id, label FROM graph_nodes WHERE kind = 'entity' AND length(label) >= 2 AND instr(?, lower(label)) > 0",
            (text,),
        ).fetchall()
        # instr also finds a name inside a longer word, so only whole-word matches count.
        node_ids = [row["id"] for row in rows if re.search(rf"(?<!\w){re.escape(row['label'].casefold())}(?!\w)", text)]
        if not node_ids:
            return []
        marks = ", ".join("?" * len(node_ids))
        # One relationship backed by several sources is stored once per source but recalled once, citing the newest.
        edges = connection.execute(
            "SELECT a.label AS subject, e.relation, b.label AS object, s.url AS source_url, MAX(e.id) AS newest "
            "FROM graph_edges e JOIN graph_nodes a ON a.id = e.source_node_id "
            "JOIN graph_nodes b ON b.id = e.target_node_id LEFT JOIN sources s ON s.id = e.source_id "
            f"WHERE a.kind = 'entity' AND b.kind = 'entity' AND (e.source_node_id IN ({marks}) OR e.target_node_id IN ({marks})) "
            "GROUP BY e.source_node_id, e.relation, e.target_node_id ORDER BY newest DESC LIMIT ?",
            (*node_ids, *node_ids, MAX_RECALLED_RELATIONSHIPS),
        ).fetchall()
        return [{key: edge[key] for key in ("subject", "relation", "object", "source_url")} for edge in edges]

    @staticmethod
    def _topic_path(connection: sqlite3.Connection, topic_id: int) -> list[dict[str, str]]:
        """Return a topic's ancestors from the root down, each with its summary."""
        path = []
        seen = {topic_id}
        row = connection.execute("SELECT parent_id FROM topics WHERE id = ?", (topic_id,)).fetchone()
        parent_id = row["parent_id"] if row else None
        # The seen set stops a parent loop from walking forever.
        while parent_id is not None and parent_id not in seen:
            seen.add(parent_id)
            parent = connection.execute(
                "SELECT name, summary, parent_id FROM topics WHERE id = ?", (parent_id,)
            ).fetchone()
            if parent is None:
                break
            path.insert(0, {"name": parent["name"], "summary": parent["summary"]})
            parent_id = parent["parent_id"]
        return path

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