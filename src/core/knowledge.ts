// The SQLite knowledge store: topics, sources, facts, memories, episodes, task runs, the research queue and the graph.
// Its file is shared with earlier versions, so the schema, migrations and stored values stay exactly as they were.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { pack, type TextEmbedder } from './embeddings.js';
import { MAIL_CLASSES, conflictingRule, matchSenderRule, normalizeRulePattern, type MailClass, type SenderRule } from './mailChecks.js';


// ============================================================================
// Schema
// ============================================================================

// Schema migrations in order; a database at version N has run the first N of them.
export const MIGRATIONS: readonly string[] = [
    `
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
    `,
    `
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
    `,
    `
    ALTER TABLE episodes ADD COLUMN task_tree TEXT NOT NULL DEFAULT '';
    `,
    `
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
    `,
    `
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
    `,
    `
    CREATE TABLE embeddings (
        kind TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        body TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (kind, item_id)
    );
    `,
    `
    ALTER TABLE user_memory ADD COLUMN reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE user_memory ADD COLUMN origin TEXT NOT NULL DEFAULT 'learned';
    ALTER TABLE user_memory ADD COLUMN scope TEXT NOT NULL DEFAULT '';
    ALTER TABLE episodes ADD COLUMN scope TEXT NOT NULL DEFAULT '';
    `,
    `
    ALTER TABLE user_memory RENAME TO memories;
    ALTER TABLE memories RENAME COLUMN kind TO store;
    UPDATE memories SET store = CASE store WHEN 'project' THEN 'project' WHEN 'reference' THEN 'locations' ELSE 'user' END;
    `,
    `
    CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        dedupe_key TEXT NOT NULL DEFAULT '',
        trust TEXT NOT NULL DEFAULT 'external',
        priority INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        received_at REAL NOT NULL,
        started_at REAL,
        finished_at REAL,
        outcome TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX events_dedupe ON events(source, dedupe_key) WHERE dedupe_key != '';
    CREATE INDEX events_pending ON events(status, priority DESC, received_at);
    CREATE TABLE actions (
        id INTEGER PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at REAL NOT NULL,
        resolved_at REAL
    );
    CREATE INDEX actions_status ON actions(status, created_at);
    `,
    `
    ALTER TABLE task_runs ADD COLUMN title TEXT NOT NULL DEFAULT '';
    ALTER TABLE episodes ADD COLUMN title TEXT NOT NULL DEFAULT '';
    `,
    `
    CREATE TABLE mail_outcomes (
        id INTEGER PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
        draft_action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
        sender TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        mail_class TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT 'pending',
        draft TEXT,
        draft_checks TEXT NOT NULL DEFAULT '[]',
        draft_resolution TEXT,
        edited_draft TEXT,
        edit_distance INTEGER,
        triaged_at REAL NOT NULL,
        drafted_at REAL,
        resolved_at REAL,
        draft_resolved_at REAL
    );
    CREATE INDEX mail_outcomes_sender ON mail_outcomes(sender, triaged_at);
    CREATE INDEX mail_outcomes_action ON mail_outcomes(action_id);
    CREATE INDEX mail_outcomes_draft_action ON mail_outcomes(draft_action_id);
    CREATE TABLE mail_sender_rules (
        id INTEGER PRIMARY KEY,
        pattern TEXT NOT NULL UNIQUE,
        mail_class TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        created_at REAL NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0
    );
    `,
];

// ============================================================================
// Events and actions
// ============================================================================

export const EVENT_TRUSTS = ['user', 'external'] as const;
export type EventTrust = (typeof EVENT_TRUSTS)[number];

export const ACTION_RESOLUTIONS = ['approved', 'rejected', 'done'] as const;
export type ActionResolution = (typeof ACTION_RESOLUTIONS)[number];

// ============================================================================
// Mail outcomes and sender rules
// ============================================================================

// Who decided a message's class: the bulk-mail headers, a sender rule, the model, or nobody because the model failed.
export const MAIL_DECIDERS = ['heuristic', 'rule', 'model', 'fallback'] as const;
export type MailDecider = (typeof MAIL_DECIDERS)[number];
export const SENDER_RULE_ORIGINS = ['user', 'learned'] as const;
export type SenderRuleOrigin = (typeof SENDER_RULE_ORIGINS)[number];

export type NewMailOutcome = {
    eventId: number | null;
    actionId: number | null;
    sender: string;
    subject: string;
    messageId: string;
    mailClass: MailClass;
    decidedBy: MailDecider;
    reason: string;
};

export type SenderRuleRecord = SenderRule & { id: number; origin: SenderRuleOrigin; created_at: number; hits: number };

export type MailClassCounts = { mail_class: string; decided: number; approved: number; rejected: number; pending: number };

export type MailOutcomeSummary = {
    since: number;
    classes: MailClassCounts[];
    drafts: { proposed: number; approved: number; rejected: number; pending: number; failed_checks: number };
    // Share of shown mail the user kept (Done) rather than dismissed, or null before any was resolved.
    agreement: number | null;
    // Past decisions not made by a rule that today's sender rules would class differently.
    rule_conflicts: number;
};

// Largest serialized payload an event may carry; bigger material belongs behind a reference in the payload.
export const MAX_EVENT_PAYLOAD_CHARS = 100_000;

export type NewEvent = {
    source: string;
    type: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    trust?: EventTrust;
    priority?: number;
};

export type EventRecord = {
    id: number;
    source: string;
    type: string;
    dedupe_key: string;
    trust: EventTrust;
    priority: number;
    payload: Record<string, unknown>;
    received_at: number;
};

export type NewAction = {
    eventId?: number | null;
    kind: string;
    title: string;
    body?: string;
    payload?: Record<string, unknown>;
};

// ============================================================================
// Constants
// ============================================================================

// Common words that would match almost any stored snippet, so they never count as a search term.
const SEARCH_STOPWORDS = new Set(
    `
    a about all also an and any are as at be been but by can could do does for from had has
    have how i if in into is it its me my no not of on or our please should so some tell than
    that the their them then there these they this to up us was we what when where which who
    why will with would you your
    explain find latest look online recent research search show source verify web
    `.split(/\s+/).filter(Boolean),
);

export const MEMORY_KINDS = ['fact', 'episode'] as const;
// A task tree run is running until it ends; a run left running by a crash, or stopped, can be resumed.
export const TASK_RUN_STATUSES = ['running', 'stopped', 'finished', 'discarded'] as const;
export const RESUMABLE_TASK_RUN_STATUSES = ['running', 'stopped'] as const;
// Each memory belongs to one store, and each store is recalled with its own budget and heading.
export const MEMORY_STORES = ['general', 'user', 'locations', 'software', 'project', 'research', 'code'] as const;
export const MEMORY_STORE_LABELS: Record<MemoryStore, string> = {
    general: 'General knowledge learned from earlier requests',
    user: 'About the user',
    locations: 'Folders, files and locations on this machine',
    software: 'Software on this machine',
    project: 'About this project',
    research: 'Lessons for researching and fact finding',
    code: 'Lessons for code review and editing',
};
// Only project memories belong to one folder; every other store holds everywhere.
export const SCOPED_MEMORY_STORES: readonly MemoryStore[] = ['project'];
// Skills are recalled for the tasks that use them, not with the rest of memory for every request.
export const SKILL_MEMORY_STORES: readonly MemoryStore[] = ['research', 'code'];
// A memory the user stated outright is trusted over one the daemon probed, and both over one the worker learned.
export const MEMORY_ORIGINS = ['learned', 'probed', 'user'] as const;
// Memories recalled for one request from each store.
export const MAX_RECALLED_MEMORIES: Record<MemoryStore, number> = {
    user: 6, project: 6, general: 4, locations: 4, software: 4, research: 5, code: 5,
};

// What consolidation compares: two topics, two facts under one topic, or two memories in one store.
export const CONSOLIDATION_KINDS = ['topic', 'fact', 'memory'] as const;

// Two items sharing at least this share of their words are compared by the model.
export const SIMILAR_OVERLAP = 0.5;

// Facts this weak are pruned once they have gone unused for the configured number of days.
export const PRUNE_BELOW_CONFIDENCE = 0.5;
// Eviction stops below this share of the size cap, so the next few runs do not each evict again.
export const EVICT_TO_SHARE_OF_CAP = 0.9;
export const EVICT_BATCH_SIZE = 100;

// A topic name longer than this reads as a query or a sentence rather than a title.
export const MAX_TOPIC_NAME_WORDS = 5;
export const MAX_TOPIC_NAME_CHARS = 40;

// A topic recalled this often, and used since it was last researched, is refreshed in half the time.
export const OFTEN_USED_TOPIC_COUNT = 5;

// How long a stored search result is trusted before it should be looked up again.
export const SOURCE_TTL_SECONDS = 7 * 24 * 3600;

// Graph relationships recalled beside the facts that name their entities.
export const MAX_RECALLED_RELATIONSHIPS = 5;

// Cosine similarity a stored item needs to the query to count as related; unrelated text scores about 0.3.
export const FACT_SIMILARITY = 0.45;
export const TOPIC_SIMILARITY = 0.5;

// Cosine similarity at which two topics, or two facts under one topic, are worth comparing as duplicates.
export const DUPLICATE_SIMILARITY = 0.75;

// Reciprocal rank fusion's damping constant: higher values weigh the top ranks less.
export const FUSION_RANK_OFFSET = 60;

// A remembered fact is one short sentence, so a long request can only ever share a few words with it.
export const RECALL_MIN_SHARED_TERMS = 3;

// ============================================================================
// Types
// ============================================================================

export type MemoryStore = (typeof MEMORY_STORES)[number];
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];
export type ConsolidationKind = (typeof CONSOLIDATION_KINDS)[number];

type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, any>;

export type SearchResult = { url?: string; title?: string; snippet?: string; [key: string]: unknown };
export type EmbeddingItem = [kind: string, itemId: number, body: string];

export type RecalledFact = {
    id: number;
    statement: string;
    confidence: number;
    topic_id: number;
    topic: string;
    source_url: string | null;
    retrieved_at: number;
    stale: boolean;
    topic_path: Array<{ name: string; summary: string }>;
};

export type RecalledRelationship = { subject: string; relation: string; object: string; source_url: string | null };

export type Recalled = {
    memories: Row[];
    facts: RecalledFact[];
    episodes: Row[];
    relationships: RecalledRelationship[];
};

export type TaskRun = Row & { options: Record<string, unknown>; state: Record<string, unknown> | null };

// A conversation is one request: an unfinished task tree run, or a finished one remembered as an episode.
export type ConversationKind = 'task_run' | 'episode';

export type Conversation = { kind: ConversationKind; id: number; prompt: string };

// ============================================================================
// Text matching
// ============================================================================

export const WORD = '[\\p{L}\\p{N}_]';

// Folds case the way Python's casefold does for nearly every text, such as German sharp s to ss.
export function casefold(text: string): string {
    return text.toUpperCase().toLowerCase();
}

export function words(text: string, minimumLength: number): string[] {
    return text.match(new RegExp(`${WORD}{${minimumLength},}`, 'gu')) ?? [];
}

export function searchTerms(query: string): string[] {
    return Array.from(new Set(words(casefold(query), 2).filter((term) => !SEARCH_STOPWORDS.has(term)))).slice(0, 12);
}

export function matchExpression(terms: string[]): string {
    return terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
}

// Returns the meaningful words of a short text, with a plural s dropped, for comparing two items.
export function comparisonTerms(text: string): Set<string> {
    return new Set(
        words(casefold(text), 2)
            .filter((term) => !SEARCH_STOPWORDS.has(term))
            .map((term) => (Array.from(term).length > 3 && term.endsWith('s') ? term.slice(0, -1) : term)),
    );
}

export function overlap(first: Set<string>, second: Set<string>): number {
    if (first.size === 0 && second.size === 0) {
        return 0.0;
    }
    const shared = [...first].filter((term) => second.has(term)).length;
    return shared / (first.size + second.size - shared);
}

function sameWording(statement: string): string {
    return words(casefold(statement), 1).join(' ');
}

export function sharedTermCount(terms: string[], text: string): number {
    const found = new Set(words(casefold(text), 2));
    return terms.filter((term) => found.has(term)).length;
}

// A stored item counts as relevant only when it shares at least half of the query's terms.
export function sharesHalfTheTerms(terms: string[], text: string): boolean {
    return sharedTermCount(terms, text) >= Math.floor((terms.length + 1) / 2);
}

// Merges ranked lists of ids by reciprocal rank, so an item near the top of either comes first.
export function fuseRankings(...rankings: number[][]): number[] {
    const scores = new Map<number, number>();
    for (const ranking of rankings) {
        [...new Set(ranking)].forEach((itemId, rank) => {
            scores.set(itemId, (scores.get(itemId) ?? 0.0) + 1.0 / (FUSION_RANK_OFFSET + rank));
        });
    }
    return [...scores.keys()].sort((first, second) => scores.get(second)! - scores.get(first)!);
}

function isSubset(first: Set<string>, second: Set<string>): boolean {
    return [...first].every((term) => second.has(term));
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
}

// Keeps the first characters of a text, counting each character once even outside the basic plane.
function firstChars(text: string, maximum: number): string {
    return text.length <= maximum ? text : Array.from(text).slice(0, maximum).join('');
}

function collapseSpaces(text: string): string {
    return text.split(/\s+/).filter(Boolean).join(' ');
}

function compareText(first: string, second: string): number {
    return first < second ? -1 : first > second ? 1 : 0;
}

// Seconds since the epoch as a float, the format every stored timestamp uses.
function now(): number {
    return Date.now() / 1000;
}

function expandUser(path: string): string {
    return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
}

// ============================================================================
// Connections
// ============================================================================

// Whether sqlite-vec loads, decided on the first connection and kept for the process.
let sqliteVecLoads: boolean | null = null;

export function sqliteVecAvailable(): boolean | null {
    return sqliteVecLoads;
}

class Connection {
    constructor(readonly database: DatabaseSync) {}

    all(sql: string, ...parameters: SqlValue[]): Row[] {
        return this.database.prepare(sql).all(...parameters).map((row) => ({ ...row }));
    }

    get(sql: string, ...parameters: SqlValue[]): Row | undefined {
        const row = this.database.prepare(sql).get(...parameters);
        return row ? { ...row } : undefined;
    }

    value(sql: string, ...parameters: SqlValue[]): any {
        const row = this.database.prepare(sql).get(...parameters);
        return row ? Object.values(row)[0] : undefined;
    }

    run(sql: string, ...parameters: SqlValue[]): { changes: number; lastInsertRowid: number } {
        const result = this.database.prepare(sql).run(...parameters);
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    }

    runMany(sql: string, rows: SqlValue[][]): void {
        const statement = this.database.prepare(sql);
        for (const row of rows) {
            statement.run(...row);
        }
    }

    exec(sql: string): void {
        this.database.exec(sql);
    }
}

// ============================================================================
// Knowledge store
// ============================================================================

export class KnowledgeStore {
    readonly path: string;
    readonly embedder: TextEmbedder | null;

    constructor(databasePath: string, embedder: TextEmbedder | null = null) {
        this.path = expandUser(databasePath);
        mkdirSync(dirname(this.path), { recursive: true });
        const database = this.open();
        try {
            const connection = new Connection(database);
            const schemaVersion = Number(connection.value('PRAGMA user_version'));
            if (schemaVersion > MIGRATIONS.length) {
                throw new Error(`Knowledge database schema ${schemaVersion} is newer than this application.`);
            }
            connection.exec('PRAGMA journal_mode = WAL');
            for (let targetVersion = schemaVersion + 1; targetVersion <= MIGRATIONS.length; targetVersion += 1) {
                // Each migration and its version bump commit together, so a crash never leaves half a schema.
                try {
                    connection.exec(`BEGIN;\n${MIGRATIONS[targetVersion - 1]}\nPRAGMA user_version = ${targetVersion};\nCOMMIT;`);
                } catch (error) {
                    if (database.isTransaction) {
                        connection.exec('ROLLBACK');
                    }
                    throw error;
                }
            }
        } finally {
            database.close();
        }
        // Vectors are searched with sqlite-vec, so without it retrieval stays lexical.
        this.embedder = sqliteVecLoads ? embedder : null;
    }

    private open(): DatabaseSync {
        const database = new DatabaseSync(this.path, { allowExtension: true });
        database.exec('PRAGMA busy_timeout = 10000');
        database.exec('PRAGMA foreign_keys = ON');
        if (sqliteVecLoads !== false) {
            try {
                database.loadExtension(getLoadablePath());
                sqliteVecLoads = true;
            } catch {
                sqliteVecLoads = false;
            }
        }
        database.enableLoadExtension(false);
        return database;
    }

    // Runs work in one transaction on a fresh connection, committing on success and rolling back on error.
    private withConnection<T>(work: (connection: Connection) => T, begin = 'BEGIN'): T {
        const database = this.open();
        try {
            const connection = new Connection(database);
            connection.exec(begin);
            try {
                const result = work(connection);
                connection.exec('COMMIT');
                return result;
            } catch (error) {
                if (database.isTransaction) {
                    connection.exec('ROLLBACK');
                }
                throw error;
            }
        } finally {
            database.close();
        }
    }

    // ==========================================================================
    // Topics, sources and the research queue
    // ==========================================================================

    // Creates a topic, or updates it; a parent or priority left out keeps its stored value.
    addTopic(name: string, options: { parent?: string | null; priority?: number | null } = {}): number {
        const topicName = cleanText(name, 'topic', 200);
        const parent = options.parent ?? null;
        const priority = options.priority ?? null;
        return this.withConnection((connection) => {
            const parentId = parent ? this.topicId(connection, parent) : null;
            connection.run(
                'INSERT INTO topics(name, parent_id, priority) VALUES (?, ?, COALESCE(?, 0)) ' +
                    'ON CONFLICT(name) DO UPDATE SET parent_id = COALESCE(excluded.parent_id, parent_id), ' +
                    'priority = COALESCE(?, priority)',
                topicName, parentId, priority, priority,
            );
            const topicId = connection.get('SELECT id FROM topics WHERE name = ? COLLATE NOCASE', topicName)!.id;
            const nodeId = this.nodeId(connection, 'topic', topicName);
            if (parent) {
                const parentNodeId = this.nodeId(connection, 'topic', parent);
                connection.run(
                    'INSERT OR IGNORE INTO graph_edges ' +
                        "(source_node_id, relation, target_node_id) VALUES (?, 'contains', ?)",
                    parentNodeId, nodeId,
                );
            }
            return Number(topicId);
        });
    }

    enqueueTopic(name: string, options: { priority?: number | null; maxPending?: number } = {}): number {
        const maxPending = options.maxPending ?? 100;
        const topicId = this.addTopic(name, { priority: options.priority ?? null });
        return this.withConnection((connection) => {
            const existing = connection.get("SELECT id FROM research_queue WHERE topic_id = ? AND status = 'pending'", topicId);
            if (existing) {
                return Number(existing.id);
            }
            const pendingCount = Number(connection.value("SELECT COUNT(*) FROM research_queue WHERE status = 'pending'"));
            if (pendingCount >= maxPending) {
                throw new Error(`Background research queue is full (${maxPending} pending jobs).`);
            }
            connection.run('INSERT OR IGNORE INTO research_queue(topic_id, requested_at) VALUES (?, ?)', topicId, now());
            const row = connection.get("SELECT id FROM research_queue WHERE topic_id = ? AND status = 'pending'", topicId);
            return row ? Number(row.id) : 0;
        });
    }

    claimJob(): { id: number; topic_id: number; name: string } | null {
        return this.withConnection((connection) => {
            const row = connection.get(
                'SELECT q.id, t.id AS topic_id, t.name FROM research_queue q ' +
                    "JOIN topics t ON t.id = q.topic_id WHERE q.status = 'pending' " +
                    'ORDER BY t.priority DESC, q.requested_at, q.id LIMIT 1',
            );
            if (!row) {
                return null;
            }
            connection.run("UPDATE research_queue SET status = 'running', started_at = ? WHERE id = ?", now(), row.id);
            return row as { id: number; topic_id: number; name: string };
        }, 'BEGIN IMMEDIATE');
    }

    // Queues topics whose research is old, refreshing often-used ones sooner and ahead of the rest.
    enqueueDueTopics(refreshIntervalHours: number, maxPending = 100): number {
        const cutoff = now() - refreshIntervalHours * 3600;
        const oftenUsedCutoff = now() - refreshIntervalHours * 1800;
        return this.withConnection((connection) => {
            const pendingCount = Number(connection.value("SELECT COUNT(*) FROM research_queue WHERE status = 'pending'"));
            const availableSlots = Math.max(0, maxPending - pendingCount);
            if (availableSlots === 0) {
                return 0;
            }
            const topicIds = connection.all(
                'SELECT id FROM topics t WHERE EXISTS ' +
                    '(SELECT 1 FROM sources s WHERE s.topic_id = t.id) ' +
                    'AND (t.last_researched_at IS NULL OR t.last_researched_at <= ? ' +
                    'OR (t.use_count >= ? AND t.last_used_at > t.last_researched_at AND t.last_researched_at <= ?)) ' +
                    'AND NOT EXISTS (SELECT 1 FROM research_queue q WHERE q.topic_id = t.id ' +
                    "AND q.status = 'pending') " +
                    'ORDER BY t.priority DESC, COALESCE(t.last_used_at > t.last_researched_at, 0) DESC, ' +
                    't.use_count DESC, t.name LIMIT ?',
                cutoff, OFTEN_USED_TOPIC_COUNT, oftenUsedCutoff, availableSlots,
            );
            connection.runMany(
                'INSERT OR IGNORE INTO research_queue(topic_id, requested_at) VALUES (?, ?)',
                topicIds.map((row) => [row.id, now()]),
            );
            return topicIds.length;
        });
    }

    finishJob(jobId: number, error = ''): void {
        const status = error ? 'failed' : 'done';
        this.withConnection((connection) => {
            connection.run(
                'UPDATE research_queue SET status = ?, finished_at = ?, error = ? WHERE id = ?',
                status, now(), firstChars(error, 1000), jobId,
            );
        });
    }

    // Puts back in the queue the jobs a stopped worker left running, dropping those whose topic is queued again already.
    requeueInterruptedJobs(): number {
        return this.withConnection((connection) => {
            connection.run(
                "DELETE FROM research_queue WHERE status = 'running' AND topic_id IN " +
                    "(SELECT topic_id FROM research_queue WHERE status = 'pending')",
            );
            return connection.run(
                "UPDATE research_queue SET status = 'pending', started_at = NULL WHERE status = 'running'",
            ).changes;
        });
    }

    deferJob(jobId: number): void {
        this.withConnection((connection) => {
            connection.run(
                "UPDATE research_queue SET status = 'pending', started_at = NULL, " +
                    "finished_at = NULL, error = '' WHERE id = ?",
                jobId,
            );
        });
    }

    storeSearchResults(
        query: string,
        results: SearchResult[],
        options: { topic?: string | null; ttlSeconds?: number; summary?: string } = {},
    ): number {
        const topic = options.topic ?? null;
        const ttlSeconds = options.ttlSeconds ?? SOURCE_TTL_SECONDS;
        const summary = options.summary ?? '';
        const topicId = topic ? this.addTopic(topic) : null;
        const storedAt = now();
        return this.withConnection((connection) => {
            let stored = 0;
            for (const result of results) {
                const url = String(result.url ?? '').trim();
                if (!url.startsWith('https://') && !url.startsWith('http://')) {
                    continue;
                }
                const title = firstChars(String(result.title ?? ''), 500);
                const snippet = firstChars(String(result.snippet ?? ''), 4000);
                connection.run(
                    'INSERT INTO sources(url, title, snippet, query, topic_id, ' +
                        'retrieved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                        'ON CONFLICT(url) DO UPDATE SET title = excluded.title, ' +
                        'snippet = excluded.snippet, ' +
                        'query = excluded.query, topic_id = excluded.topic_id, ' +
                        'retrieved_at = excluded.retrieved_at, expires_at = excluded.expires_at',
                    url, title, snippet, firstChars(query, 500), topicId, storedAt, storedAt + ttlSeconds,
                );
                const source = connection.get('SELECT id, summary FROM sources WHERE url = ?', url)!;
                const sourceId = source.id;
                connection.run('DELETE FROM knowledge_search WHERE rowid = ?', sourceId);
                connection.run(
                    'INSERT INTO knowledge_search(rowid, title, body, url) VALUES (?, ?, ?, ?)',
                    sourceId, title, `${snippet} ${source.summary}`, url,
                );
                if (topic) {
                    const topicNode = this.nodeId(connection, 'topic', topic);
                    const sourceNode = this.nodeId(connection, 'source', url);
                    connection.run(
                        'INSERT OR IGNORE INTO graph_edges ' +
                            '(source_node_id, relation, target_node_id, source_id) ' +
                            "VALUES (?, 'supported_by', ?, ?)",
                        topicNode, sourceNode, sourceId,
                    );
                }
                stored += 1;
            }
            if (topicId !== null) {
                connection.run(
                    'UPDATE topics SET last_researched_at = ?, ' +
                        "summary = CASE WHEN ? != '' THEN ? ELSE summary END WHERE id = ?",
                    storedAt, summary, firstChars(summary, 4000), topicId,
                );
            }
            return stored;
        });
    }

    search(query: string, options: { limit?: number } = {}): Row[] {
        const limit = options.limit ?? 8;
        const terms = searchTerms(query);
        if (terms.length === 0) {
            return [];
        }
        const expression = matchExpression(terms);
        const rows = this.withConnection((connection) =>
            connection.all(
                'SELECT s.title, s.url, s.snippet, ' +
                    "CASE WHEN s.summary != '' THEN s.summary ELSE COALESCE(t.summary, '') END AS summary, " +
                    's.query, s.retrieved_at, ' +
                    't.name AS topic FROM knowledge_search k JOIN sources s ON s.id = k.rowid ' +
                    'LEFT JOIN topics t ON t.id = s.topic_id ' +
                    'WHERE knowledge_search MATCH ? AND s.expires_at >= ? ' +
                    'ORDER BY rank LIMIT ?',
                expression, now(), limit * 4,
            ),
        );
        const columns = ['title', 'url', 'snippet', 'summary', 'query'];
        return rows
            .filter((row) => sharesHalfTheTerms(terms, columns.map((column) => String(row[column] || '')).join(' ')))
            .slice(0, limit);
    }

    topics(): Row[] {
        return this.withConnection((connection) =>
            connection.all(
                'SELECT t.id, t.name, t.parent_id, p.name AS parent, t.priority, ' +
                    't.last_researched_at, COUNT(s.id) AS source_count ' +
                    'FROM topics t LEFT JOIN topics p ON p.id = t.parent_id ' +
                    'LEFT JOIN sources s ON s.topic_id = t.id ' +
                    'GROUP BY t.id ORDER BY p.name, t.name',
            ),
        );
    }

    sources(topicId: number | null = null, options: { limit?: number } = {}): Row[] {
        const limit = options.limit ?? 200;
        return this.withConnection((connection) =>
            connection.all(
                'SELECT s.id, s.title, s.url, s.snippet, s.summary, s.query, ' +
                    's.retrieved_at, s.expires_at, s.topic_id, t.name AS topic FROM sources s ' +
                    'LEFT JOIN topics t ON t.id = s.topic_id ' +
                    'WHERE (? IS NULL OR s.topic_id = ?) ORDER BY s.retrieved_at DESC LIMIT ?',
                topicId, topicId, limit,
            ),
        );
    }

    graph(): Row[] {
        return this.withConnection((connection) =>
            connection.all(
                'SELECT a.kind AS source_kind, a.label AS source, e.relation, ' +
                    'b.kind AS target_kind, b.label AS target, s.url AS evidence_url ' +
                    'FROM graph_edges e JOIN graph_nodes a ON a.id = e.source_node_id ' +
                    'JOIN graph_nodes b ON b.id = e.target_node_id ' +
                    'LEFT JOIN sources s ON s.id = e.source_id ' +
                    'ORDER BY a.label, e.relation',
            ),
        );
    }

    addRelationship(source: string, relation: string, target: string, sourceUrl: string | null = null): void {
        const sourceName = cleanText(source, 'source entity', 200);
        const relationName = cleanText(relation, 'relationship', 100);
        const targetName = cleanText(target, 'target entity', 200);
        this.withConnection((connection) => {
            const sourceId = this.nodeId(connection, 'entity', sourceName);
            const targetId = this.nodeId(connection, 'entity', targetName);
            let evidenceId: number | null = null;
            if (sourceUrl) {
                const row = connection.get('SELECT id FROM sources WHERE url = ?', sourceUrl);
                if (!row) {
                    throw new Error('source_url must refer to a stored source.');
                }
                evidenceId = row.id;
            }
            connection.run(
                'INSERT OR IGNORE INTO graph_edges ' +
                    '(source_node_id, relation, target_node_id, source_id) VALUES (?, ?, ?, ?)',
                sourceId, relationName, targetId, evidenceId,
            );
        });
    }

    // ==========================================================================
    // Facts, memories, and episodes
    // ==========================================================================

    // Stores one atomic fact under a topic; a repeated fact keeps its highest confidence.
    addFact(topic: string, statement: string, sourceUrl: string | null = null, confidence = 0.5): number {
        const factStatement = collapseSpaces(cleanText(statement, 'fact', 500));
        const factConfidence = Math.min(1.0, Math.max(0.0, Number(confidence)));
        const topicId = this.addTopic(topic);
        return this.withConnection((connection) => {
            let sourceId: number | null = null;
            if (sourceUrl) {
                const row = connection.get('SELECT id FROM sources WHERE url = ?', sourceUrl);
                sourceId = row ? row.id : null;
            }
            const previous = connection.get('SELECT id, status FROM facts WHERE topic_id = ? AND statement = ?', topicId, factStatement);
            if (previous && previous.status !== 'active') {
                // A fact learned again after being set aside is compared afresh.
                forgetChecks(connection, 'fact', previous.id);
            }
            connection.run(
                'INSERT INTO facts(topic_id, statement, source_id, confidence, created_at) ' +
                    'VALUES (?, ?, ?, ?, ?) ON CONFLICT(topic_id, statement) DO UPDATE SET ' +
                    'confidence = MAX(confidence, excluded.confidence), ' +
                    "source_id = COALESCE(excluded.source_id, source_id), status = 'active'",
                topicId, factStatement, sourceId, factConfidence, now(),
            );
            const factId = connection.get('SELECT id FROM facts WHERE topic_id = ? AND statement = ?', topicId, factStatement)!.id;
            indexMemory(connection, 'fact', factId, factStatement);
            return Number(factId);
        });
    }

    facts(options: { topicId?: number | null; limit?: number } = {}): Row[] {
        const topicId = options.topicId ?? null;
        const limit = options.limit ?? 200;
        return this.withConnection((connection) =>
            connection.all(
                'SELECT f.id, f.statement, f.confidence, f.status, f.use_count, f.created_at, ' +
                    'f.topic_id, t.name AS topic, s.url AS source_url FROM facts f ' +
                    'JOIN topics t ON t.id = f.topic_id LEFT JOIN sources s ON s.id = f.source_id ' +
                    'WHERE (? IS NULL OR f.topic_id = ?) ORDER BY f.created_at DESC LIMIT ?',
                topicId, topicId, limit,
            ),
        );
    }

    hasFacts(topic: string): boolean {
        return this.withConnection(
            (connection) =>
                connection.get(
                    'SELECT 1 FROM facts f JOIN topics t ON t.id = f.topic_id ' +
                        "WHERE t.name = ? AND f.status = 'active' LIMIT 1",
                    topic,
                ) !== undefined,
        );
    }

    setTopicSummary(topic: string, summary: string): void {
        const topicId = this.addTopic(topic);
        this.withConnection((connection) => {
            connection.run('UPDATE topics SET summary = ? WHERE id = ?', firstChars(summary.trim(), 4000), topicId);
        });
    }

    // Stores a summary of one fetched page on its source, and makes it searchable.
    setSourceSummary(url: string, summary: string): void {
        this.withConnection((connection) => {
            const row = connection.get('SELECT id, title, snippet FROM sources WHERE url = ?', url);
            if (!row) {
                return;
            }
            const cleanSummary = firstChars(summary.trim(), 4000);
            connection.run('UPDATE sources SET summary = ? WHERE id = ?', cleanSummary, row.id);
            connection.run('DELETE FROM knowledge_search WHERE rowid = ?', row.id);
            connection.run(
                'INSERT INTO knowledge_search(rowid, title, body, url) VALUES (?, ?, ?, ?)',
                row.id, row.title, `${row.snippet} ${cleanSummary}`, url,
            );
        });
    }

    // Returns whether a topic has sources of its own, so its summary comes from research rather than its subtopics.
    isResearched(topic: string): boolean {
        return this.withConnection(
            (connection) =>
                connection.get(
                    'SELECT 1 FROM sources s JOIN topics t ON t.id = s.topic_id WHERE t.name = ? COLLATE NOCASE LIMIT 1',
                    topic,
                ) !== undefined,
        );
    }

    childSummaries(parent: string): Array<[name: string, summary: string]> {
        const rows = this.withConnection((connection) =>
            connection.all(
                'SELECT c.name, c.summary FROM topics c JOIN topics p ON p.id = c.parent_id ' +
                    "WHERE p.name = ? COLLATE NOCASE AND c.summary != '' ORDER BY c.use_count DESC, c.name",
                parent,
            ),
        );
        return rows.map((row) => [row.name, row.summary]);
    }

    // Remembers one durable statement in a memory store; a project memory's scope keeps it to that folder.
    addMemory(
        store: string,
        statement: string,
        options: { reason?: string; origin?: string; scope?: string } = {},
    ): number {
        const reason = options.reason ?? '';
        const origin = options.origin ?? 'learned';
        if (!(MEMORY_STORES as readonly string[]).includes(store)) {
            throw new Error(`store must be one of: ${MEMORY_STORES.join(', ')}.`);
        }
        if (!(MEMORY_ORIGINS as readonly string[]).includes(origin)) {
            throw new Error(`origin must be one of: ${MEMORY_ORIGINS.join(', ')}.`);
        }
        const memory = collapseSpaces(cleanText(statement, 'memory', 500));
        const memoryReason = firstChars(collapseSpaces(reason), 500);
        const scope = (SCOPED_MEMORY_STORES as readonly string[]).includes(store) ? (options.scope ?? '') : '';
        return this.withConnection((connection) => {
            const previous = connection.get('SELECT id, status FROM memories WHERE statement = ? COLLATE NOCASE', memory);
            if (previous && previous.status !== 'active') {
                forgetChecks(connection, 'memory', previous.id);
            }
            // Learning a memory again never takes away what the user said about it.
            connection.run(
                'INSERT INTO memories(store, statement, reason, origin, scope, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
                    "ON CONFLICT(statement) DO UPDATE SET status = 'active', " +
                    "store = CASE WHEN memories.origin = 'user' AND excluded.origin != 'user' " +
                    'THEN memories.store ELSE excluded.store END, ' +
                    "reason = CASE WHEN excluded.reason != '' THEN excluded.reason ELSE memories.reason END, " +
                    "origin = CASE WHEN memories.origin = 'user' THEN 'user' ELSE excluded.origin END, " +
                    "scope = CASE WHEN memories.origin = 'user' AND excluded.origin != 'user' " +
                    'THEN memories.scope ELSE excluded.scope END',
                store, memory, memoryReason, origin, scope, now(),
            );
            return Number(connection.get('SELECT id FROM memories WHERE statement = ? COLLATE NOCASE', memory)!.id);
        });
    }

    // Makes a store's probed memories exactly these statements, forgetting what the probe no longer finds.
    replaceProbedMemories(store: string, statements: string[]): void {
        const kept = statements.map((statement) => this.addMemory(store, statement, { origin: 'probed' }));
        this.withConnection((connection) => {
            const stale = connection
                .all("SELECT id FROM memories WHERE store = ? AND origin = 'probed'", store)
                .map((row) => Number(row.id))
                .filter((memoryId) => !kept.includes(memoryId));
            for (const memoryId of stale) {
                connection.run('DELETE FROM memories WHERE id = ?', memoryId);
                forgetChecks(connection, 'memory', memoryId);
            }
        });
    }

    // Lists active memories in the given stores, newest first; with a scope, only global ones and that project's.
    memories(options: { limit?: number; scope?: string | null; stores?: readonly string[] } = {}): Row[] {
        const limit = options.limit ?? 50;
        const scope = options.scope ?? null;
        const stores = options.stores ?? MEMORY_STORES;
        const placeholders = stores.map(() => '?').join(', ');
        return this.withConnection((connection) =>
            connection.all(
                'SELECT id, store, statement, reason, origin, scope, created_at, use_count FROM memories ' +
                    `WHERE status = 'active' AND store IN (${placeholders}) AND (? IS NULL OR scope IN ('', ?)) ` +
                    'ORDER BY created_at DESC, id DESC LIMIT ?',
                ...stores, scope, scope, limit,
            ),
        );
    }

    // Returns each store's memories sharing the most words with a request first, then the user's, then the newest.
    relevantMemories(
        query: string,
        options: { scope?: string; stores?: readonly string[]; countUse?: boolean } = {},
    ): Row[] {
        const scope = options.scope ?? '';
        const stores = options.stores ?? MEMORY_STORES;
        const terms = searchTerms(query);
        const recalled: Row[] = [];
        for (const store of stores) {
            const memories = this.memories({ limit: 10_000, scope, stores: [store] });
            const shared = new Map(memories.map((memory) => [memory.id, sharedTermCount(terms, `${memory.statement} ${memory.reason}`)]));
            const ranked = [...memories].sort(
                (first, second) =>
                    shared.get(second.id)! - shared.get(first.id)! ||
                    Number(first.origin !== 'user') - Number(second.origin !== 'user') ||
                    second.created_at - first.created_at ||
                    second.id - first.id,
            );
            recalled.push(...ranked.slice(0, MAX_RECALLED_MEMORIES[store as MemoryStore]));
        }
        if (options.countUse) {
            this.countMemoryUse(recalled);
        }
        return recalled;
    }

    // Counts one more use of each recalled memory.
    private countMemoryUse(memories: Row[]): void {
        this.withConnection((connection) => {
            connection.runMany(
                'UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
                memories.map((memory) => [now(), memory.id]),
            );
        });
    }

    // Deletes one memory for good and returns whether it existed.
    forgetMemory(memoryId: number): boolean {
        return this.withConnection((connection) => {
            const deleted = connection.run('DELETE FROM memories WHERE id = ?', memoryId).changes;
            forgetChecks(connection, 'memory', memoryId);
            return deleted > 0;
        });
    }

    // Remembers one finished request, scoped to the project folder it was worked in.
    recordEpisode(
        prompt: string,
        taskType: string,
        checklist: string,
        answer: string,
        outcome: string,
        options: { taskTree?: string; scope?: string } = {},
    ): number {
        const taskTree = options.taskTree ?? '';
        const scope = options.scope ?? '';
        return this.withConnection((connection) => {
            const episodeId = connection.run(
                'INSERT INTO episodes(prompt, task_type, checklist, answer, outcome, task_tree, scope, created_at) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                firstChars(prompt, 4000), taskType, firstChars(checklist, 4000), firstChars(answer, 4000),
                firstChars(outcome, 500), taskTree, scope, now(),
            ).lastInsertRowid;
            indexMemory(connection, 'episode', episodeId, `${firstChars(prompt, 4000)} ${firstChars(checklist, 4000)}`);
            return episodeId;
        });
    }

    episodes(options: { unprocessedOnly?: boolean; limit?: number } = {}): Row[] {
        const unprocessedOnly = options.unprocessedOnly ?? false;
        const limit = options.limit ?? 50;
        return this.withConnection((connection) =>
            connection.all(
                'SELECT id, prompt, title, task_type, checklist, answer, outcome, task_tree, scope, created_at, processed_at ' +
                    'FROM episodes WHERE (? = 0 OR processed_at IS NULL) ORDER BY created_at DESC LIMIT ?',
                unprocessedOnly ? 1 : 0, limit,
            ),
        );
    }

    // Opens a checkpoint for a task tree run, holding what is needed to start it again.
    startTaskRun(prompt: string, options: Record<string, unknown>): number {
        const startedAt = now();
        return this.withConnection(
            (connection) =>
                connection.run(
                    'INSERT INTO task_runs(prompt, options, started_at, updated_at) VALUES (?, ?, ?, ?)',
                    prompt, JSON.stringify(options), startedAt, startedAt,
                ).lastInsertRowid,
        );
    }

    saveTaskRun(runId: number, state: Record<string, unknown>, tasksDone: number, tasksTotal: number): void {
        this.withConnection((connection) => {
            connection.run(
                'UPDATE task_runs SET state = ?, tasks_done = ?, tasks_total = ?, updated_at = ? WHERE id = ?',
                JSON.stringify(state), tasksDone, tasksTotal, now(), runId,
            );
        });
    }

    setTaskRunStatus(runId: number, status: string): void {
        if (!(TASK_RUN_STATUSES as readonly string[]).includes(status)) {
            throw new Error(`Unknown task run status: ${status}`);
        }
        this.withConnection((connection) => {
            connection.run('UPDATE task_runs SET status = ?, updated_at = ? WHERE id = ?', status, now(), runId);
        });
    }

    taskRun(runId: number): TaskRun | null {
        const row = this.withConnection((connection) => connection.get('SELECT * FROM task_runs WHERE id = ?', runId));
        if (!row) {
            return null;
        }
        return { ...row, options: JSON.parse(row.options), state: row.state ? JSON.parse(row.state) : null };
    }

    // Lists task tree runs that can be resumed, newest first, without their saved state.
    unfinishedTaskRuns(options: { limit?: number } = {}): Row[] {
        const limit = options.limit ?? 10;
        const placeholders = RESUMABLE_TASK_RUN_STATUSES.map(() => '?').join(', ');
        return this.withConnection((connection) =>
            connection.all(
                'SELECT id, prompt, title, status, tasks_done, tasks_total, started_at, updated_at FROM task_runs ' +
                    `WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`,
                ...RESUMABLE_TASK_RUN_STATUSES, limit,
            ),
        );
    }

    // Returns the newest conversation without a title, unfinished runs first because the window shows them.
    nextConversationToTitle(): Conversation | null {
        const placeholders = RESUMABLE_TASK_RUN_STATUSES.map(() => '?').join(', ');
        return this.withConnection((connection) => {
            const run = connection.get(
                `SELECT id, prompt FROM task_runs WHERE title = '' AND status IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`,
                ...RESUMABLE_TASK_RUN_STATUSES,
            );
            if (run) {
                return { kind: 'task_run', id: Number(run.id), prompt: String(run.prompt) };
            }
            const episode = connection.get("SELECT id, prompt FROM episodes WHERE title = '' ORDER BY created_at DESC LIMIT 1");
            return episode ? { kind: 'episode', id: Number(episode.id), prompt: String(episode.prompt) } : null;
        });
    }

    setConversationTitle(kind: ConversationKind, conversationId: number, title: string): void {
        const table = kind === 'task_run' ? 'task_runs' : 'episodes';
        this.withConnection((connection) => {
            connection.run(`UPDATE ${table} SET title = ? WHERE id = ?`, title, conversationId);
        });
    }

    markEpisodeProcessed(episodeId: number): void {
        this.withConnection((connection) => {
            connection.run('UPDATE episodes SET processed_at = ? WHERE id = ?', now(), episodeId);
        });
    }

    // Returns what memory holds for a request: the non-skill memory stores, matching facts, past episodes and relationships.
    async recall(query: string, options: { limit?: number; includeMemories?: boolean; scope?: string } = {}): Promise<Recalled> {
        const limit = options.limit ?? 5;
        const includeMemories = options.includeMemories ?? true;
        const scope = options.scope ?? '';
        const stores = MEMORY_STORES.filter((store) => !SKILL_MEMORY_STORES.includes(store));
        const recalled: Recalled = {
            memories: includeMemories ? this.relevantMemories(query, { scope, stores }) : [],
            facts: [],
            episodes: [],
            relationships: [],
        };
        const terms = searchTerms(query);
        const queryVector = await this.queryVector(query);
        const recalledAt = now();
        const result = this.withConnection((connection) => {
            const lexicalFactIds: number[] = [];
            if (terms.length > 0) {
                const rows = connection.all(
                    'SELECT m.kind, m.item_id, m.body FROM memory_search m ' +
                        'WHERE memory_search MATCH ? ORDER BY rank LIMIT ?',
                    // Rows sharing too few terms are dropped below, so FTS5 is asked for plenty.
                    matchExpression(terms), limit * 20,
                );
                const needed = Math.min(RECALL_MIN_SHARED_TERMS, Math.floor((terms.length + 1) / 2));
                // The sort is stable, so items sharing as many terms keep their FTS5 rank order.
                const ranked = rows
                    .map((row) => ({ shared: sharedTermCount(terms, row.body), row }))
                    .filter((pair) => pair.shared >= needed)
                    .sort((first, second) => second.shared - first.shared);
                for (const { row } of ranked) {
                    if (row.kind === 'fact') {
                        lexicalFactIds.push(row.item_id);
                    } else if (row.kind === 'episode' && recalled.episodes.length < Math.min(limit, 3)) {
                        const episode = connection.get(
                            'SELECT id, prompt, task_type, outcome, created_at FROM episodes WHERE id = ?',
                            row.item_id,
                        );
                        if (episode) {
                            recalled.episodes.push(episode);
                        }
                    }
                }
            }
            const vectorFactIds = similarItems(connection, 'fact', queryVector, limit * 4, FACT_SIMILARITY);
            for (const factId of fuseRankings(lexicalFactIds, vectorFactIds)) {
                if (recalled.facts.length === limit) {
                    break;
                }
                const fact = recalledFact(connection, factId, recalledAt);
                if (fact) {
                    recalled.facts.push(fact);
                }
            }
            if (recalled.facts.length < limit) {
                const shown = new Set(recalled.facts.map((fact) => fact.id));
                for (const factId of branchFactIds(connection, terms, shown, limit - recalled.facts.length, queryVector)) {
                    const fact = recalledFact(connection, factId, recalledAt);
                    if (fact) {
                        recalled.facts.push(fact);
                    }
                }
            }
            recalled.relationships = relationshipsNamedIn(connection, recalled.facts.map((fact) => fact.statement));
            // Usage counts let the background worker refresh and keep what is actually used.
            connection.runMany(
                'UPDATE facts SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
                recalled.facts.map((fact) => [recalledAt, fact.id]),
            );
            connection.runMany(
                'UPDATE topics SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
                [...new Set(recalled.facts.map((fact) => fact.topic_id))].map((topicId) => [recalledAt, topicId]),
            );
            return recalled;
        });
        this.countMemoryUse(result.memories);
        return result;
    }

    // ==========================================================================
    // Consolidation
    // ==========================================================================

    // Makes every change that needs no model: break loops, merge exact duplicates, research empty topics, prune and evict.
    tidy(pruneAfterDays: number, maxPending = 100, maxMegabytes: number | null = null): Record<string, number> {
        return this.withConnection((connection) => {
            const changes: Record<string, number> = {
                'parent loops broken': this.breakTopicLoops(connection),
                'topics merged': this.mergeSameNamedTopics(connection),
                'facts merged': this.mergeSameWordedFacts(connection),
                'empty topics queued for research': queueEmptyTopics(connection, maxPending),
            };
            changes['facts pruned'] = connection.run(
                "UPDATE facts SET status = 'pruned' WHERE status = 'active' AND use_count = 0 " +
                    'AND confidence < ? AND created_at < ?',
                PRUNE_BELOW_CONFIDENCE, now() - pruneAfterDays * 86400,
            ).changes;
            if (maxMegabytes !== null && maxMegabytes !== undefined) {
                changes['items evicted to fit the size cap'] = evictToFit(connection, maxMegabytes * 1024 * 1024);
            }
            return Object.fromEntries(Object.entries(changes).filter(([, count]) => count));
        });
    }

    // Returns the most alike pair of the given kind that the model has not compared yet.
    nextUncheckedPair(kind: string): [Row, Row] | null {
        if (!(CONSOLIDATION_KINDS as readonly string[]).includes(kind)) {
            throw new Error(`kind must be one of: ${CONSOLIDATION_KINDS.join(', ')}.`);
        }
        const { checked, rows, textColumn } = this.withConnection((connection) => {
            const checkedPairs = new Set(
                connection
                    .all('SELECT first_id, second_id FROM consolidation_checks WHERE kind = ?', kind)
                    .map((row) => `${row.first_id},${row.second_id}`),
            );
            if (kind === 'topic') {
                return {
                    checked: checkedPairs,
                    rows: connection.all('SELECT id, name, summary, parent_id, 0 AS grouping FROM topics'),
                    textColumn: 'name',
                };
            }
            if (kind === 'fact') {
                return {
                    checked: checkedPairs,
                    rows: connection.all(
                        'SELECT f.id, f.statement, f.confidence, f.topic_id AS grouping, t.name AS topic ' +
                            "FROM facts f JOIN topics t ON t.id = f.topic_id WHERE f.status = 'active'",
                    ),
                    textColumn: 'statement',
                };
            }
            return {
                checked: checkedPairs,
                // Memories are compared within one store, and a project's only with that project's.
                rows: connection.all(
                    "SELECT id, store, statement, origin, created_at, store || ':' || scope AS grouping " +
                        "FROM memories WHERE status = 'active'",
                ),
                textColumn: 'statement',
            };
        });
        const items = new Map<number, Row>(rows.map((row) => [row.id, row]));
        const terms = new Map<number, Set<string>>(rows.map((row) => [row.id, comparisonTerms(row[textColumn])]));
        // Only items sharing a word, in the same group, can be alike, so the index keeps this from comparing every pair.
        const index = new Map<string, number[]>();
        for (const itemId of [...items.keys()].sort((first, second) => first - second)) {
            for (const term of terms.get(itemId)!) {
                const key = JSON.stringify([items.get(itemId)!.grouping, term]);
                const ids = index.get(key) ?? [];
                ids.push(itemId);
                index.set(key, ids);
            }
        }
        const candidates = new Map<string, { first: number; second: number; score: number }>();
        for (const itemIds of index.values()) {
            itemIds.forEach((firstId, position) => {
                for (const secondId of itemIds.slice(position + 1)) {
                    const key = `${firstId},${secondId}`;
                    if (checked.has(key) || candidates.has(key)) {
                        continue;
                    }
                    const first = items.get(firstId)!;
                    const second = items.get(secondId)!;
                    if (kind === 'memory' && first.origin === 'probed' && second.origin === 'probed') {
                        // Each probe finding is a separate reading of the machine, so two never repeat or contradict.
                        continue;
                    }
                    const firstTerms = terms.get(firstId)!;
                    const secondTerms = terms.get(secondId)!;
                    let score = overlap(firstTerms, secondTerms);
                    if (kind === 'topic') {
                        if (first.id === second.parent_id || second.id === first.parent_id) {
                            continue;
                        }
                        // A name inside another, such as SQLite in SQLite FTS5, may be the broader topic.
                        if (isSubset(firstTerms, secondTerms) || isSubset(secondTerms, firstTerms)) {
                            score = Math.max(score, SIMILAR_OVERLAP);
                        }
                    }
                    if (score >= SIMILAR_OVERLAP) {
                        candidates.set(key, { first: firstId, second: secondId, score });
                    }
                }
            });
        }
        // Pairs worded differently but close in meaning are compared too.
        for (const [firstId, secondId, similarity] of this.similarPairs(kind)) {
            const key = `${firstId},${secondId}`;
            if (items.has(firstId) && items.has(secondId) && !checked.has(key)) {
                if (kind === 'topic' && (firstId === items.get(secondId)!.parent_id || secondId === items.get(firstId)!.parent_id)) {
                    continue;
                }
                const score = Math.max(candidates.get(key)?.score ?? 0.0, similarity);
                candidates.set(key, { first: firstId, second: secondId, score });
            }
        }
        if (candidates.size === 0) {
            return null;
        }
        const best = [...candidates.values()].sort(
            (first, second) => second.score - first.score || first.first - second.first || first.second - second.second,
        )[0];
        return [items.get(best.first)!, items.get(best.second)!];
    }

    // Returns pairs of topics, or of facts under one topic, whose vectors are close, lower id first.
    private similarPairs(kind: string): Array<[number, number, number]> {
        if (!sqliteVecLoads || (kind !== 'topic' && kind !== 'fact')) {
            return [];
        }
        const sameGroup =
            kind === 'fact'
                ? 'JOIN facts fa ON fa.id = a.item_id JOIN facts fb ON fb.id = b.item_id AND fb.topic_id = fa.topic_id '
                : '';
        const rows = this.withConnection((connection) =>
            connection.all(
                'SELECT a.item_id AS first_id, b.item_id AS second_id, ' +
                    '1 - vec_distance_cosine(a.vector, b.vector) AS similarity ' +
                    'FROM embeddings a JOIN embeddings b ON b.kind = a.kind AND b.item_id > a.item_id ' +
                    `AND b.model = a.model AND length(b.vector) = length(a.vector) ${sameGroup}` +
                    'WHERE a.kind = ? AND 1 - vec_distance_cosine(a.vector, b.vector) >= ?',
                kind, DUPLICATE_SIMILARITY,
            ),
        );
        return rows.map((row) => [row.first_id, row.second_id, row.similarity]);
    }

    recordCheck(kind: string, firstId: number, secondId: number, verdict: string): void {
        const [lower, higher] = [firstId, secondId].sort((first, second) => first - second);
        this.withConnection((connection) => {
            connection.run(
                'INSERT OR REPLACE INTO consolidation_checks(kind, first_id, second_id, verdict, checked_at) ' +
                    'VALUES (?, ?, ?, ?, ?)',
                kind, lower, higher, verdict, now(),
            );
        });
    }

    // Folds two topics that name one subject into the one with more behind it, returning its name.
    mergeTopics(firstId: number, secondId: number): string {
        return this.withConnection((connection) => {
            const [keepId, dropId] = rankTopics(connection, firstId, secondId);
            this.mergeTopicInto(connection, keepId, dropId);
            return connection.get('SELECT name FROM topics WHERE id = ?', keepId)!.name;
        });
    }

    // Files a topic under a broader one when that narrows where it sits now, and returns whether it moved.
    adoptTopic(parentId: number, childId: number): boolean {
        return this.withConnection((connection) => {
            const child = connection.get('SELECT parent_id FROM topics WHERE id = ?', childId);
            if (!child || parentId === childId || descendantIds(connection, childId).has(parentId)) {
                return false;
            }
            const currentParent = child.parent_id;
            if (currentParent === parentId) {
                return false;
            }
            if (currentParent !== null && !ancestorIds(connection, parentId).has(currentParent)) {
                return false;
            }
            this.setParent(connection, childId, parentId);
            return true;
        });
    }

    // Moves a topic under another, or to the top level, and returns whether it moved.
    setTopicParent(topicId: number, parentId: number | null): boolean {
        return this.withConnection((connection) => {
            const row = connection.get('SELECT parent_id FROM topics WHERE id = ?', topicId);
            if (!row || row.parent_id === parentId) {
                return false;
            }
            if (parentId !== null && (parentId === topicId || descendantIds(connection, topicId).has(parentId))) {
                return false;
            }
            this.setParent(connection, topicId, parentId);
            return true;
        });
    }

    // Returns the topic whose place in the tree has gone longest without review, if any is due.
    nextTopicToPlace(reviewedBefore: number): Row | null {
        return this.withConnection((connection) => {
            const topic = connection.get(
                'SELECT t.id, t.name, t.summary, t.parent_id, p.name AS parent, ' +
                    'EXISTS (SELECT 1 FROM sources s WHERE s.topic_id = t.id) AS researched FROM topics t ' +
                    'LEFT JOIN topics p ON p.id = t.parent_id ' +
                    'WHERE t.placed_at IS NULL OR t.placed_at < ? ' +
                    'ORDER BY t.placed_at IS NOT NULL, t.placed_at, t.use_count DESC, t.id LIMIT 1',
                reviewedBefore,
            );
            if (!topic) {
                return null;
            }
            topic.children = connection.all('SELECT name FROM topics WHERE parent_id = ? ORDER BY name', topic.id).map((child) => child.name);
            return topic;
        });
    }

    // Returns the topics this one could sit under, the most related first, keeping the current parent in.
    // A topic with no summary is left out, and so is one whose name holds every word of this one and more.
    placementCandidates(topicId: number, options: { limit?: number } = {}): Row[] {
        const limit = options.limit ?? 20;
        const found = this.withConnection((connection) => {
            const topic = connection.get('SELECT name, summary, parent_id FROM topics WHERE id = ?', topicId);
            if (!topic) {
                return null;
            }
            const excluded = descendantIds(connection, topicId).add(topicId);
            const nameTerms = comparisonTerms(topic.name);
            const rows = connection
                .all('SELECT id, name, summary, parent_id FROM topics')
                .filter((row) => {
                    if (excluded.has(row.id) || !(row.summary || row.id === topic.parent_id)) {
                        return false;
                    }
                    const rowTerms = comparisonTerms(row.name);
                    return !(isSubset(nameTerms, rowTerms) && rowTerms.size > nameTerms.size);
                });
            return { topic, rows };
        });
        if (!found) {
            return [];
        }
        const { topic, rows } = found;
        const terms = comparisonTerms(`${topic.name} ${topic.summary}`);
        const shared = (row: Row) => [...comparisonTerms(row.name)].filter((term) => terms.has(term)).length;
        return rows
            .map((row) => ({ row, shared: shared(row), name: casefold(row.name) }))
            .sort(
                (first, second) =>
                    Number(first.row.id !== topic.parent_id) - Number(second.row.id !== topic.parent_id) ||
                    second.shared - first.shared ||
                    Number(first.row.parent_id !== null) - Number(second.row.parent_id !== null) ||
                    compareText(first.name, second.name),
            )
            .slice(0, limit)
            .map(({ row }) => row);
    }

    // Returns the most used topic not yet checked for a title, with its best facts, its searches and related topics.
    // Every researched topic is checked once, and so is any other whose name is too long for a title.
    nextTopicToName(): Row | null {
        return this.withConnection((connection) => {
            const topic = connection.get(
                'SELECT t.id, t.name, t.summary FROM topics t ' +
                    'WHERE (EXISTS (SELECT 1 FROM sources s WHERE s.topic_id = t.id) ' +
                    "OR length(t.name) > ? OR length(t.name) - length(replace(t.name, ' ', '')) >= ?) " +
                    "AND NOT EXISTS (SELECT 1 FROM consolidation_checks c WHERE c.kind = 'title' AND c.first_id = t.id) " +
                    'ORDER BY t.use_count DESC, t.id LIMIT 1',
                MAX_TOPIC_NAME_CHARS, MAX_TOPIC_NAME_WORDS,
            );
            if (!topic) {
                return null;
            }
            topic.facts = connection
                .all(
                    "SELECT statement FROM facts WHERE topic_id = ? AND status = 'active' " +
                        'ORDER BY confidence DESC, use_count DESC, id LIMIT 5',
                    topic.id,
                )
                .map((fact) => fact.statement);
            topic.queries = connection
                .all("SELECT DISTINCT query FROM sources WHERE topic_id = ? AND query != '' LIMIT 3", topic.id)
                .map((row) => row.query);
            const terms = comparisonTerms(topic.name);
            topic.related = connection
                .all('SELECT id, name FROM topics ORDER BY use_count DESC, name')
                .filter((row) => row.id !== topic.id && [...comparisonTerms(row.name)].some((term) => terms.has(term)))
                .map((row) => row.name)
                .slice(0, 10);
            return topic;
        });
    }

    // Renames a topic, or folds it into the topic that already has that name, and returns the name it ends up under.
    // The topic and its subtopics were placed under the old name, so they are due to be placed again.
    renameTopic(topicId: number, name: string): string {
        const newName = cleanText(name, 'topic', 200);
        return this.withConnection((connection) => {
            const oldName = connection.get('SELECT name FROM topics WHERE id = ?', topicId)!.name;
            const other = connection.get('SELECT id, name FROM topics WHERE name = ? COLLATE NOCASE AND id != ?', newName, topicId);
            if (other) {
                this.mergeTopicInto(connection, other.id, topicId);
                connection.run('UPDATE topics SET placed_at = NULL WHERE id = ? OR parent_id = ?', other.id, other.id);
                return other.name;
            }
            connection.run('UPDATE topics SET placed_at = NULL WHERE id = ? OR parent_id = ?', topicId, topicId);
            const oldNode = this.nodeId(connection, 'topic', oldName);
            connection.run('UPDATE topics SET name = ? WHERE id = ?', newName, topicId);
            const newNode = this.nodeId(connection, 'topic', newName);
            if (newNode !== oldNode) {
                connection.run('UPDATE OR IGNORE graph_edges SET source_node_id = ? WHERE source_node_id = ?', newNode, oldNode);
                connection.run('UPDATE OR IGNORE graph_edges SET target_node_id = ? WHERE target_node_id = ?', newNode, oldNode);
                connection.run('DELETE FROM graph_nodes WHERE id = ?', oldNode);
            }
            return newName;
        });
    }

    // Deletes a topic with no active facts, keeping its sources and lifting its subtopics into its place.
    removeUnsupportedTopic(topicId: number): boolean {
        return this.withConnection((connection) => {
            const row = connection.get(
                'SELECT name, parent_id FROM topics t WHERE id = ? ' +
                    "AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.topic_id = t.id AND f.status = 'active')",
                topicId,
            );
            if (!row) {
                return false;
            }
            for (const child of connection.all('SELECT id FROM topics WHERE parent_id = ?', topicId)) {
                this.setParent(connection, child.id, row.parent_id);
                connection.run('UPDATE topics SET placed_at = NULL WHERE id = ?', child.id);
            }
            deleteTopic(connection, topicId, row.name);
            return true;
        });
    }

    markTopicUnplaced(topicId: number): void {
        this.withConnection((connection) => {
            connection.run('UPDATE topics SET placed_at = NULL WHERE id = ?', topicId);
        });
    }

    markTopicPlaced(topicId: number): void {
        this.withConnection((connection) => {
            connection.run('UPDATE topics SET placed_at = ? WHERE id = ?', now(), topicId);
        });
    }

    // Folds two facts that say the same thing into the more trusted one.
    mergeFacts(firstId: number, secondId: number): void {
        this.withConnection((connection) => {
            const [keepId, dropId] = rankFacts(connection, firstId, secondId);
            mergeFactInto(connection, keepId, dropId);
        });
    }

    // Sets aside the less trusted of two contradicting facts, or both when tied, and returns their topic.
    disputeFacts(firstId: number, secondId: number): string {
        return this.withConnection((connection) => {
            const rows = connection.all(
                'SELECT f.id, f.confidence, t.name AS topic FROM facts f JOIN topics t ON t.id = f.topic_id ' +
                    'WHERE f.id IN (?, ?) ORDER BY f.confidence DESC',
                firstId, secondId,
            );
            if (rows.length === 0) {
                return '';
            }
            const lowest = rows[rows.length - 1].confidence;
            connection.runMany(
                "UPDATE facts SET status = 'disputed' WHERE id = ?",
                rows.filter((row) => row.confidence === lowest).map((row) => [row.id]),
            );
            return rows[0].topic;
        });
    }

    // Folds two memories that say the same thing into the more used one, or the newer when used equally.
    mergeMemories(firstId: number, secondId: number): void {
        this.withConnection((connection) => {
            const rows = connection.all(
                'SELECT id, use_count, last_used_at FROM memories WHERE id IN (?, ?) ' +
                    'ORDER BY use_count DESC, created_at DESC, id DESC',
                firstId, secondId,
            );
            if (rows.length !== 2) {
                return;
            }
            const [keep, drop] = rows;
            connection.run(
                'UPDATE memories SET use_count = use_count + ?, last_used_at = MAX(COALESCE(last_used_at, 0), ?) ' +
                    'WHERE id = ?',
                drop.use_count, drop.last_used_at || 0, keep.id,
            );
            connection.run('DELETE FROM memories WHERE id = ?', drop.id);
            forgetChecks(connection, 'memory', drop.id);
        });
    }

    // Sets aside the older of two contradicting memories, keeping the user's over a probed one and a probed over a learned one.
    supersedeMemory(firstId: number, secondId: number): void {
        this.withConnection((connection) => {
            const older = connection.get(
                "SELECT id FROM memories WHERE id IN (?, ?) ORDER BY origin = 'user', origin = 'probed', created_at, id LIMIT 1",
                firstId, secondId,
            );
            if (older) {
                connection.run("UPDATE memories SET status = 'superseded' WHERE id = ?", older.id);
            }
        });
    }

    queueStatus(): Row[] {
        return this.withConnection((connection) =>
            connection.all(
                'SELECT q.id, t.name AS topic, q.status, q.requested_at, q.error ' +
                    'FROM research_queue q JOIN topics t ON t.id = q.topic_id ' +
                    'ORDER BY q.requested_at DESC LIMIT 100',
            ),
        );
    }

    // ==========================================================================
    // Events and actions
    // ==========================================================================

    // Queues an event; one with a dedupe key already stored for its source is not queued again.
    enqueueEvent(event: NewEvent, options: { maxPending?: number } = {}): { id: number; duplicate: boolean } {
        const source = event.source.trim();
        const type = event.type.trim();
        if (!source || !type) {
            throw new Error('An event needs a source and a type.');
        }
        const trust = event.trust ?? 'external';
        if (!EVENT_TRUSTS.includes(trust)) {
            throw new Error(`An event's trust must be one of: ${EVENT_TRUSTS.join(', ')}.`);
        }
        const payload = JSON.stringify(event.payload ?? {});
        if (payload.length > MAX_EVENT_PAYLOAD_CHARS) {
            throw new Error(`An event's payload is over ${MAX_EVENT_PAYLOAD_CHARS} characters.`);
        }
        const dedupeKey = event.dedupeKey ?? '';
        const maxPending = options.maxPending ?? 1000;
        return this.withConnection((connection) => {
            if (dedupeKey) {
                const existing = connection.get('SELECT id FROM events WHERE source = ? AND dedupe_key = ?', source, dedupeKey);
                if (existing) {
                    return { id: Number(existing.id), duplicate: true };
                }
            }
            const pendingCount = Number(connection.value("SELECT COUNT(*) FROM events WHERE status = 'pending'"));
            if (pendingCount >= maxPending) {
                throw new Error(`The event queue is full (${maxPending} pending events).`);
            }
            const result = connection.run(
                'INSERT INTO events(source, type, dedupe_key, trust, priority, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                source, type, dedupeKey, trust, event.priority ?? 0, payload, now(),
            );
            return { id: result.lastInsertRowid, duplicate: false };
        }, 'BEGIN IMMEDIATE');
    }

    // Takes the most important pending event, oldest first, and marks it running.
    claimEvent(): EventRecord | null {
        return this.withConnection((connection) => {
            const row = connection.get(
                "SELECT id, source, type, dedupe_key, trust, priority, payload, received_at FROM events WHERE status = 'pending' " +
                    'ORDER BY priority DESC, received_at, id LIMIT 1',
            );
            if (!row) {
                return null;
            }
            connection.run("UPDATE events SET status = 'running', started_at = ? WHERE id = ?", now(), row.id);
            let payload: Record<string, unknown> = {};
            try {
                const parsed: unknown = JSON.parse(String(row.payload));
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    payload = parsed as Record<string, unknown>;
                }
            } catch {
                // A payload that cannot be read is handled as an empty one.
            }
            return { ...row, payload } as EventRecord;
        }, 'BEGIN IMMEDIATE');
    }

    // Returns the dedupe keys among the given ones that this source has already queued.
    knownEventKeys(source: string, keys: string[]): string[] {
        if (keys.length === 0) {
            return [];
        }
        return this.withConnection((connection) =>
            connection
                .all(`SELECT dedupe_key FROM events WHERE source = ? AND dedupe_key IN (${keys.map(() => '?').join(', ')})`, source, ...keys)
                .map((row) => String(row.dedupe_key)),
        );
    }

    finishEvent(eventId: number, status: 'done' | 'ignored' | 'failed', detail = ''): void {
        this.withConnection((connection) => {
            const [outcome, error] = status === 'failed' ? ['', detail] : [detail, ''];
            connection.run(
                'UPDATE events SET status = ?, finished_at = ?, outcome = ?, error = ? WHERE id = ?',
                status, now(), firstChars(outcome, 1000), firstChars(error, 1000), eventId,
            );
        });
    }

    // Puts a running event back in the queue, such as one paused by a foreground run.
    deferEvent(eventId: number): void {
        this.withConnection((connection) => {
            connection.run("UPDATE events SET status = 'pending', started_at = NULL WHERE id = ? AND status = 'running'", eventId);
        });
    }

    requeueInterruptedEvents(): number {
        return this.withConnection((connection) =>
            connection.run("UPDATE events SET status = 'pending', started_at = NULL WHERE status = 'running'").changes,
        );
    }

    events(limit = 100): Row[] {
        return this.withConnection((connection) =>
            connection.all(
                'SELECT id, source, type, dedupe_key, trust, priority, status, received_at, finished_at, outcome, error ' +
                    'FROM events ORDER BY received_at DESC, id DESC LIMIT ?',
                limit,
            ),
        );
    }

    addAction(action: NewAction): number {
        const kind = action.kind.trim();
        const title = action.title.trim();
        if (!kind || !title) {
            throw new Error('An action needs a kind and a title.');
        }
        return this.withConnection(
            (connection) =>
                connection.run(
                    'INSERT INTO actions(event_id, kind, title, body, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                    action.eventId ?? null, kind, title, action.body ?? '', JSON.stringify(action.payload ?? {}), now(),
                ).lastInsertRowid,
        );
    }

    actions(status: string | null = null, limit = 100): Row[] {
        return this.withConnection((connection) =>
            connection.all(
                'SELECT id, event_id, kind, title, body, payload, status, created_at, resolved_at FROM actions ' +
                    'WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ?',
                status, status, limit,
            ),
        );
    }

    // Marks a proposed action approved, rejected or done, returning whether one was waiting.
    // The mail outcome it belongs to records the answer; with a threshold, repeated dismissals of one sender propose a rule.
    resolveAction(actionId: number, resolution: ActionResolution, options: { senderRuleThreshold?: number } = {}): boolean {
        if (!ACTION_RESOLUTIONS.includes(resolution)) {
            throw new Error(`An action is resolved as one of: ${ACTION_RESOLUTIONS.join(', ')}.`);
        }
        return this.withConnection((connection) => {
            const allowed = resolution === 'done' ? "('proposed', 'approved')" : "('proposed')";
            const resolvedAt = now();
            const resolved =
                connection.run(`UPDATE actions SET status = ?, resolved_at = ? WHERE id = ? AND status IN ${allowed}`, resolution, resolvedAt, actionId)
                    .changes > 0;
            if (!resolved) {
                return false;
            }
            connection.run('UPDATE mail_outcomes SET resolution = ?, resolved_at = ? WHERE action_id = ?', resolution, resolvedAt, actionId);
            connection.run('UPDATE mail_outcomes SET draft_resolution = ?, draft_resolved_at = ? WHERE draft_action_id = ?', resolution, resolvedAt, actionId);
            const action = connection.get('SELECT kind, payload FROM actions WHERE id = ?', actionId);
            if (action?.kind === 'rule' && resolution !== 'rejected') {
                this.addProposedRule(connection, String(action.payload));
            }
            if (resolution === 'rejected' && (options.senderRuleThreshold ?? 0) > 0) {
                this.proposeIgnoreRule(connection, actionId, options.senderRuleThreshold!);
            }
            return true;
        });
    }

    // ==========================================================================
    // Mail outcomes and sender rules
    // ==========================================================================

    // Stores what triage decided for one message; the user's answer is filled in when its action is resolved.
    recordMailTriage(outcome: NewMailOutcome): number {
        const resolution = outcome.mailClass === 'ignore' ? 'ignored' : 'pending';
        return this.withConnection(
            (connection) =>
                connection.run(
                    'INSERT INTO mail_outcomes(event_id, action_id, sender, subject, message_id, mail_class, decided_by, reason, resolution, triaged_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    outcome.eventId, outcome.actionId, outcome.sender, firstChars(outcome.subject, 300), outcome.messageId,
                    outcome.mailClass, outcome.decidedBy, firstChars(outcome.reason, 300), resolution, now(),
                ).lastInsertRowid,
        );
    }

    // Stores the draft proposed for a message and the names of the checks it failed.
    recordMailDraft(outcomeId: number, draftActionId: number, draft: string, failedChecks: string[]): void {
        this.withConnection((connection) => {
            connection.run(
                "UPDATE mail_outcomes SET draft_action_id = ?, draft = ?, draft_checks = ?, draft_resolution = 'pending', drafted_at = ? WHERE id = ?",
                draftActionId, draft, JSON.stringify(failedChecks), now(), outcomeId,
            );
        });
    }

    mailOutcomes(limit = 100): Row[] {
        return this.withConnection((connection) =>
            connection.all('SELECT * FROM mail_outcomes ORDER BY triaged_at DESC, id DESC LIMIT ?', limit),
        );
    }

    // Counts per class of what triage decided and what the user then did, for outcomes triaged at or after a time.
    mailOutcomeSummary(since = 0): MailOutcomeSummary {
        return this.withConnection((connection) => {
            const classes = connection
                .all(
                    "SELECT mail_class, COUNT(*) AS decided, SUM(resolution IN ('approved', 'done')) AS approved, " +
                        "SUM(resolution = 'rejected') AS rejected, SUM(resolution = 'pending') AS pending " +
                        'FROM mail_outcomes WHERE triaged_at >= ? GROUP BY mail_class ORDER BY mail_class',
                    since,
                )
                .map((row) => ({
                    mail_class: String(row.mail_class),
                    decided: Number(row.decided),
                    approved: Number(row.approved ?? 0),
                    rejected: Number(row.rejected ?? 0),
                    pending: Number(row.pending ?? 0),
                }));
            const drafts = connection.get(
                "SELECT COUNT(draft) AS proposed, SUM(draft_resolution IN ('approved', 'done')) AS approved, " +
                    "SUM(draft_resolution = 'rejected') AS rejected, SUM(draft_resolution = 'pending') AS pending, " +
                    "SUM(draft IS NOT NULL AND draft_checks != '[]') AS failed_checks FROM mail_outcomes WHERE triaged_at >= ?",
                since,
            )!;
            const shown = classes.filter((counts) => counts.mail_class !== 'ignore');
            const approved = shown.reduce((total, counts) => total + counts.approved, 0);
            const answered = approved + shown.reduce((total, counts) => total + counts.rejected, 0);
            const rules = this.readSenderRules(connection);
            const ruleConflicts = connection
                .all("SELECT sender, mail_class FROM mail_outcomes WHERE triaged_at >= ? AND decided_by != 'rule'", since)
                .filter((row) => conflictingRule(rules, String(row.sender), String(row.mail_class)) !== null).length;
            return {
                since,
                classes,
                drafts: {
                    proposed: Number(drafts.proposed ?? 0),
                    approved: Number(drafts.approved ?? 0),
                    rejected: Number(drafts.rejected ?? 0),
                    pending: Number(drafts.pending ?? 0),
                    failed_checks: Number(drafts.failed_checks ?? 0),
                },
                agreement: answered > 0 ? approved / answered : null,
                rule_conflicts: ruleConflicts,
            };
        });
    }

    senderRules(): SenderRuleRecord[] {
        return this.withConnection((connection) => this.readSenderRules(connection));
    }

    // Adds or replaces the rule for an address or domain, returning it and how many past decisions it disagrees with.
    setSenderRule(pattern: string, mailClass: MailClass, origin: SenderRuleOrigin = 'user'): { rule: SenderRuleRecord; conflicts: number } {
        if (!MAIL_CLASSES.includes(mailClass)) {
            throw new Error(`A sender rule's class is one of: ${MAIL_CLASSES.join(', ')}.`);
        }
        const normalized = normalizeRulePattern(pattern);
        return this.withConnection((connection) => {
            connection.run(
                'INSERT INTO mail_sender_rules(pattern, mail_class, origin, created_at) VALUES (?, ?, ?, ?) ' +
                    'ON CONFLICT(pattern) DO UPDATE SET mail_class = excluded.mail_class, origin = excluded.origin, created_at = excluded.created_at, hits = 0',
                normalized, mailClass, origin, now(),
            );
            const rule = this.readSenderRules(connection).find((candidate) => candidate.pattern === normalized)!;
            const conflicts = connection
                .all("SELECT sender, mail_class FROM mail_outcomes WHERE decided_by != 'rule'")
                .filter((row) => conflictingRule([rule], String(row.sender), String(row.mail_class)) !== null).length;
            return { rule, conflicts };
        });
    }

    deleteSenderRule(pattern: string): boolean {
        const normalized = normalizeRulePattern(pattern);
        return this.withConnection((connection) => connection.run('DELETE FROM mail_sender_rules WHERE pattern = ?', normalized).changes > 0);
    }

    // The rule that decides for a sender's address, exact address before domain, counting the hit.
    applySenderRule(address: string): SenderRuleRecord | null {
        if (!address) {
            return null;
        }
        return this.withConnection((connection) => {
            const rule = matchSenderRule(this.readSenderRules(connection), address);
            if (rule) {
                connection.run('UPDATE mail_sender_rules SET hits = hits + 1 WHERE id = ?', rule.id);
            }
            return rule;
        });
    }

    private readSenderRules(connection: Connection): SenderRuleRecord[] {
        return connection
            .all('SELECT id, pattern, mail_class, origin, created_at, hits FROM mail_sender_rules ORDER BY pattern')
            .map((row) => ({ ...row }) as SenderRuleRecord);
    }

    // An approved rule proposal becomes a learned rule, unless the user has set one for that pattern since.
    private addProposedRule(connection: Connection, payloadText: string): void {
        let payload: Record<string, unknown> = {};
        try {
            payload = JSON.parse(payloadText) as Record<string, unknown>;
        } catch {
            return;
        }
        const { pattern, mail_class: mailClass } = payload;
        if (typeof pattern !== 'string' || !(MAIL_CLASSES as readonly unknown[]).includes(mailClass)) {
            return;
        }
        connection.run(
            "INSERT OR IGNORE INTO mail_sender_rules(pattern, mail_class, origin, created_at) VALUES (?, ?, 'learned', ?)",
            normalizeRulePattern(pattern), String(mailClass), now(),
        );
    }

    // After the user dismissed a sender's last few messages in a row, propose ignoring that sender; never write the rule unasked.
    private proposeIgnoreRule(connection: Connection, actionId: number, threshold: number): void {
        const sender = String(connection.value('SELECT sender FROM mail_outcomes WHERE action_id = ?', actionId) ?? '');
        if (!sender || matchSenderRule(this.readSenderRules(connection), sender)) {
            return;
        }
        const proposedBefore = connection.value(
            "SELECT COUNT(*) FROM actions WHERE kind = 'rule' AND json_extract(payload, '$.pattern') = ?",
            sender,
        );
        if (Number(proposedBefore) > 0) {
            return;
        }
        const recent = connection.all(
            "SELECT resolution FROM mail_outcomes WHERE sender = ? AND resolution IN ('approved', 'done', 'rejected') " +
                'ORDER BY resolved_at DESC, id DESC LIMIT ?',
            sender, threshold,
        );
        if (recent.length < threshold || recent.some((row) => row.resolution !== 'rejected')) {
            return;
        }
        const total = Number(connection.value('SELECT COUNT(*) FROM mail_outcomes WHERE sender = ?', sender));
        const changed = Number(connection.value("SELECT COUNT(*) FROM mail_outcomes WHERE sender = ? AND mail_class != 'ignore'", sender));
        connection.run(
            'INSERT INTO actions(event_id, kind, title, body, payload, created_at) VALUES (NULL, ?, ?, ?, ?, ?)',
            'rule',
            firstChars(`Ignore mail from ${sender}?`, 120),
            `You dismissed the last ${threshold} messages from ${sender}. Mark Done to add a sender rule that ignores its mail ` +
                `without the model, or Dismiss to keep it as it is. The rule would have changed ${changed} of ${total} earlier decisions.`,
            JSON.stringify({ pattern: sender, mail_class: 'ignore', origin: 'learned' }),
            now(),
        );
    }

    exportSourceJson(source: Record<string, unknown>): string {
        return JSON.stringify(source, null, 2);
    }

    // ==========================================================================
    // Embeddings
    // ==========================================================================

    private async queryVector(query: string): Promise<number[] | null> {
        if (!this.embedder || !query.trim()) {
            return null;
        }
        try {
            return await this.embedder.embedQuery(query);
        } catch {
            // A model that will not load or run leaves retrieval lexical rather than failing the request.
            return null;
        }
    }

    // Returns facts and topics with no vector from this model, or whose text changed since theirs was made.
    itemsToEmbed(model: string, limit: number): EmbeddingItem[] {
        const rows = this.withConnection((connection) =>
            connection.all(
                'SELECT kind, item_id, body FROM (' +
                    "SELECT 'fact' AS kind, f.id AS item_id, f.statement AS body FROM facts f WHERE f.status = 'active' " +
                    "UNION ALL SELECT 'topic', t.id, t.name || ': ' || t.summary FROM topics t" +
                    ') items WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.kind = items.kind ' +
                    'AND e.item_id = items.item_id AND e.model = ? AND e.body = items.body) LIMIT ?',
                model, limit,
            ),
        );
        return rows.map((row) => [row.kind, row.item_id, row.body]);
    }

    saveEmbeddings(model: string, items: EmbeddingItem[], vectors: number[][]): void {
        this.withConnection((connection) => {
            const count = Math.min(items.length, vectors.length);
            connection.runMany(
                'INSERT INTO embeddings(kind, item_id, model, body, vector) VALUES (?, ?, ?, ?, ?) ' +
                    'ON CONFLICT(kind, item_id) DO UPDATE SET model = excluded.model, body = excluded.body, ' +
                    'vector = excluded.vector',
                items.slice(0, count).map(([kind, itemId, body], position) => [kind, itemId, model, body, pack(vectors[position])]),
            );
        });
    }

    // ==========================================================================
    // Topic tree helpers
    // ==========================================================================

    // Moves a topic and replaces its contains edge in the graph to match.
    private setParent(connection: Connection, topicId: number, parentId: number | null): void {
        const name = connection.get('SELECT name FROM topics WHERE id = ?', topicId)!.name;
        const nodeId = this.nodeId(connection, 'topic', name);
        connection.run('UPDATE topics SET parent_id = ? WHERE id = ?', parentId, topicId);
        connection.run(
            "DELETE FROM graph_edges WHERE relation = 'contains' AND target_node_id = ? " +
                "AND source_node_id IN (SELECT id FROM graph_nodes WHERE kind = 'topic')",
            nodeId,
        );
        if (parentId !== null) {
            const parent = connection.get('SELECT name FROM topics WHERE id = ?', parentId)!.name;
            connection.run(
                'INSERT OR IGNORE INTO graph_edges (source_node_id, relation, target_node_id) ' +
                    "VALUES (?, 'contains', ?)",
                this.nodeId(connection, 'topic', parent), nodeId,
            );
        }
    }

    private breakTopicLoops(connection: Connection): number {
        let broken = 0;
        for (const row of connection.all('SELECT id FROM topics WHERE parent_id IS NOT NULL')) {
            if (walksBackTo(connection, row.id)) {
                this.setParent(connection, row.id, null);
                broken += 1;
            }
        }
        return broken;
    }

    // Merges topics whose names have exactly the same words, such as Python packaging and packaging Python.
    private mergeSameNamedTopics(connection: Connection): number {
        const byTerms = new Map<string, number>();
        let merged = 0;
        for (const row of connection.all('SELECT id, name FROM topics ORDER BY id')) {
            const terms = comparisonTerms(row.name);
            if (terms.size === 0) {
                continue;
            }
            const key = JSON.stringify([...terms].sort());
            if (!byTerms.has(key)) {
                byTerms.set(key, row.id);
                continue;
            }
            const [keepId, dropId] = rankTopics(connection, byTerms.get(key)!, row.id);
            this.mergeTopicInto(connection, keepId, dropId);
            byTerms.set(key, keepId);
            merged += 1;
        }
        return merged;
    }

    // Merges active facts under one topic that differ only in case and punctuation.
    private mergeSameWordedFacts(connection: Connection): number {
        const byWording = new Map<string, number>();
        let merged = 0;
        for (const row of connection.all("SELECT id, topic_id, statement FROM facts WHERE status = 'active' ORDER BY id")) {
            const key = JSON.stringify([row.topic_id, sameWording(row.statement)]);
            if (!byWording.has(key)) {
                byWording.set(key, row.id);
                continue;
            }
            const [keepId, dropId] = rankFacts(connection, byWording.get(key)!, row.id);
            mergeFactInto(connection, keepId, dropId);
            byWording.set(key, keepId);
            merged += 1;
        }
        return merged;
    }

    private mergeTopicInto(connection: Connection, keepId: number, dropId: number): void {
        const keep = connection.get('SELECT * FROM topics WHERE id = ?', keepId)!;
        const drop = connection.get('SELECT * FROM topics WHERE id = ?', dropId)!;
        // Lifting the kept topic out from under the dropped one stops its old subtopics forming a loop.
        if (ancestorIds(connection, keepId).has(dropId)) {
            this.setParent(connection, keepId, drop.parent_id);
        } else if (
            keep.parent_id === null &&
            drop.parent_id !== null &&
            drop.parent_id !== keepId &&
            !descendantIds(connection, keepId).has(drop.parent_id)
        ) {
            this.setParent(connection, keepId, drop.parent_id);
        }
        for (const child of connection.all('SELECT id FROM topics WHERE parent_id = ? AND id != ?', dropId, keepId)) {
            this.setParent(connection, child.id, keepId);
        }
        for (const fact of connection.all('SELECT id, statement FROM facts WHERE topic_id = ?', dropId)) {
            const twin = connection.get('SELECT id FROM facts WHERE topic_id = ? AND statement = ?', keepId, fact.statement);
            if (twin) {
                mergeFactInto(connection, twin.id, fact.id);
            } else {
                connection.run('UPDATE facts SET topic_id = ? WHERE id = ?', keepId, fact.id);
            }
        }
        connection.run('UPDATE sources SET topic_id = ? WHERE topic_id = ?', keepId, dropId);
        if (connection.get("SELECT 1 FROM research_queue WHERE topic_id = ? AND status = 'pending'", keepId)) {
            connection.run("DELETE FROM research_queue WHERE topic_id = ? AND status = 'pending'", dropId);
        }
        connection.run('UPDATE research_queue SET topic_id = ? WHERE topic_id = ?', keepId, dropId);
        connection.run(
            'UPDATE topics SET priority = MAX(priority, ?), use_count = use_count + ?, ' +
                'last_used_at = MAX(COALESCE(last_used_at, 0), ?), ' +
                'last_researched_at = MAX(COALESCE(last_researched_at, 0), ?), ' +
                "summary = CASE WHEN summary = '' THEN ? ELSE summary END WHERE id = ?",
            drop.priority, drop.use_count, drop.last_used_at || 0, drop.last_researched_at || 0, drop.summary, keepId,
        );
        const keepNode = this.nodeId(connection, 'topic', keep.name);
        const dropNode = this.nodeId(connection, 'topic', drop.name);
        connection.run('UPDATE OR IGNORE graph_edges SET source_node_id = ? WHERE source_node_id = ?', keepNode, dropNode);
        connection.run('UPDATE OR IGNORE graph_edges SET target_node_id = ? WHERE target_node_id = ?', keepNode, dropNode);
        connection.run('DELETE FROM graph_edges WHERE source_node_id = target_node_id');
        deleteTopic(connection, dropId, drop.name);
    }

    private topicId(connection: Connection, name: string): number {
        const topicName = cleanText(name, 'topic', 200);
        connection.run('INSERT OR IGNORE INTO topics(name) VALUES (?)', topicName);
        return Number(connection.get('SELECT id FROM topics WHERE name = ? COLLATE NOCASE', topicName)!.id);
    }

    private nodeId(connection: Connection, kind: string, label: string): number {
        connection.run('INSERT OR IGNORE INTO graph_nodes(kind, label) VALUES (?, ?)', kind, label);
        return Number(connection.get('SELECT id FROM graph_nodes WHERE kind = ? AND label = ?', kind, label)!.id);
    }
}

// ============================================================================
// Store helpers
// ============================================================================

function cleanText(value: unknown, name: string, maximum: number): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${name} must be a non-empty string.`);
    }
    return firstChars(value.trim(), maximum);
}

function forgetChecks(connection: Connection, kind: string, itemId: number): void {
    connection.run('DELETE FROM consolidation_checks WHERE kind = ? AND (first_id = ? OR second_id = ?)', kind, itemId, itemId);
}

function indexMemory(connection: Connection, kind: string, itemId: number, body: string): void {
    connection.run('DELETE FROM memory_search WHERE kind = ? AND item_id = ?', kind, itemId);
    connection.run('INSERT INTO memory_search(body, kind, item_id) VALUES (?, ?, ?)', body, kind, itemId);
}

function ancestorIds(connection: Connection, topicId: number): Set<number> {
    const ancestors = new Set<number>();
    let parentId: number | null = connection.get('SELECT parent_id FROM topics WHERE id = ?', topicId)?.parent_id ?? null;
    while (parentId !== null && !ancestors.has(parentId) && parentId !== topicId) {
        ancestors.add(parentId);
        parentId = connection.get('SELECT parent_id FROM topics WHERE id = ?', parentId)?.parent_id ?? null;
    }
    return ancestors;
}

function descendantIds(connection: Connection, topicId: number): Set<number> {
    const descendants = new Set<number>();
    let frontier = [topicId];
    while (frontier.length > 0) {
        const rows = connection.all(`SELECT id FROM topics WHERE parent_id IN (${frontier.map(() => '?').join(', ')})`, ...frontier);
        frontier = rows.map((row) => row.id as number).filter((id) => !descendants.has(id) && id !== topicId);
        frontier.forEach((id) => descendants.add(id));
    }
    return descendants;
}

function walksBackTo(connection: Connection, topicId: number): boolean {
    const seen = new Set<number>();
    let parentId: number | null = topicId;
    while (parentId !== null && !seen.has(parentId)) {
        seen.add(parentId);
        parentId = connection.get('SELECT parent_id FROM topics WHERE id = ?', parentId)?.parent_id ?? null;
        if (parentId === topicId) {
            return true;
        }
    }
    return false;
}

// Queues research for topics with no facts, sources or subtopics, unless research is unfinished or has failed.
function queueEmptyTopics(connection: Connection, maxPending: number): number {
    const pendingCount = Number(connection.value("SELECT COUNT(*) FROM research_queue WHERE status = 'pending'"));
    const rows = connection.all(
        'SELECT id FROM topics t WHERE ' +
            'NOT EXISTS (SELECT 1 FROM facts f WHERE f.topic_id = t.id) ' +
            'AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.topic_id = t.id) ' +
            'AND NOT EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id) ' +
            "AND NOT EXISTS (SELECT 1 FROM research_queue q WHERE q.topic_id = t.id AND q.status != 'done') " +
            'ORDER BY t.priority DESC, t.use_count DESC, t.id LIMIT ?',
        Math.max(0, maxPending - pendingCount),
    );
    connection.runMany(
        'INSERT OR IGNORE INTO research_queue(topic_id, requested_at) VALUES (?, ?)',
        rows.map((row) => [row.id, now()]),
    );
    return rows.length;
}

function deleteTopic(connection: Connection, topicId: number, name: string): void {
    connection.run('DELETE FROM topics WHERE id = ?', topicId);
    connection.run("DELETE FROM graph_nodes WHERE kind = 'topic' AND label = ?", name);
    connection.run("DELETE FROM embeddings WHERE kind = 'topic' AND item_id = ?", topicId);
    forgetChecks(connection, 'topic', topicId);
    forgetChecks(connection, 'title', topicId);
}

// Orders two topics as keep then drop: more facts, sources and use first, then the shorter name.
function rankTopics(connection: Connection, firstId: number, secondId: number): [number, number] {
    const rows = connection.all(
        'SELECT t.id, t.name, t.use_count ' +
            '+ (SELECT COUNT(*) FROM facts f WHERE f.topic_id = t.id) ' +
            '+ (SELECT COUNT(*) FROM sources s WHERE s.topic_id = t.id) AS weight ' +
            'FROM topics t WHERE t.id IN (?, ?)',
        firstId, secondId,
    );
    const [keep, drop] = rows.sort(
        (first, second) =>
            second.weight - first.weight || Array.from(first.name).length - Array.from(second.name).length || first.id - second.id,
    );
    return [keep.id, drop.id];
}

// Orders two facts as keep then drop: higher confidence first, then more used, then older.
function rankFacts(connection: Connection, firstId: number, secondId: number): [number, number] {
    const rows = connection.all(
        'SELECT id FROM facts WHERE id IN (?, ?) ORDER BY confidence DESC, use_count DESC, id',
        firstId, secondId,
    );
    return [rows[0].id, rows[1].id];
}

function mergeFactInto(connection: Connection, keepId: number, dropId: number): void {
    const drop = connection.get('SELECT * FROM facts WHERE id = ?', dropId)!;
    connection.run(
        'UPDATE facts SET confidence = MAX(confidence, ?), use_count = use_count + ?, ' +
            'last_used_at = MAX(COALESCE(last_used_at, 0), ?), source_id = COALESCE(source_id, ?) WHERE id = ?',
        drop.confidence, drop.use_count, drop.last_used_at || 0, drop.source_id, keepId,
    );
    connection.run('DELETE FROM facts WHERE id = ?', dropId);
    connection.run("DELETE FROM memory_search WHERE kind = 'fact' AND item_id = ?", dropId);
    connection.run("DELETE FROM embeddings WHERE kind = 'fact' AND item_id = ?", dropId);
    forgetChecks(connection, 'fact', dropId);
}

// ============================================================================
// Size cap
// ============================================================================

// Returns the bytes the store's data uses, leaving out pages freed by earlier deletes.
function liveBytes(connection: Connection): number {
    const pageCount = Number(connection.value('PRAGMA page_count'));
    const freePages = Number(connection.value('PRAGMA freelist_count'));
    return (pageCount - freePages) * Number(connection.value('PRAGMA page_size'));
}

// Deletes the least valuable rows, least valuable kind first, until the store fits under its cap.
function evictToFit(connection: Connection, maxBytes: number): number {
    if (liveBytes(connection) <= maxBytes) {
        return 0;
    }
    const target = Math.trunc(maxBytes * EVICT_TO_SHARE_OF_CAP);
    const placeholders = RESUMABLE_TASK_RUN_STATUSES.map(() => '?').join(', ');
    const candidates: Array<[string, string, SqlValue[]]> = [
        ['fact', "SELECT id FROM facts WHERE status = 'pruned' ORDER BY created_at LIMIT ?", []],
        [
            'task_run',
            `SELECT id FROM task_runs WHERE status NOT IN (${placeholders}) ORDER BY updated_at LIMIT ?`,
            [...RESUMABLE_TASK_RUN_STATUSES],
        ],
        ['episode', 'SELECT id FROM episodes WHERE processed_at IS NOT NULL ORDER BY created_at LIMIT ?', []],
        [
            'source',
            'SELECT id FROM sources WHERE expires_at < ? AND id NOT IN ' +
                '(SELECT source_id FROM facts WHERE source_id IS NOT NULL) ORDER BY retrieved_at LIMIT ?',
            [now()],
        ],
        ['fact', "SELECT id FROM facts ORDER BY status = 'active', use_count, COALESCE(last_used_at, created_at) LIMIT ?", []],
    ];
    let evicted = 0;
    for (const [kind, query, parameters] of candidates) {
        while (liveBytes(connection) > target) {
            const ids = connection.all(query, ...parameters, EVICT_BATCH_SIZE).map((row) => row.id as number);
            if (ids.length === 0) {
                break;
            }
            for (const itemId of ids) {
                deleteItem(connection, kind, itemId);
            }
            evicted += ids.length;
            // A full-text index only marks deleted rows, so it is merged for their pages to be freed.
            const index = kind === 'source' ? 'knowledge_search' : 'memory_search';
            connection.run(`INSERT INTO ${index}(${index}) VALUES ('optimize')`);
        }
        if (liveBytes(connection) <= target) {
            break;
        }
    }
    return evicted;
}

// Deletes one row together with its search entries, vector and graph links.
function deleteItem(connection: Connection, kind: string, itemId: number): void {
    if (kind === 'fact') {
        connection.run('DELETE FROM facts WHERE id = ?', itemId);
        connection.run("DELETE FROM consolidation_checks WHERE kind = 'fact' AND (first_id = ? OR second_id = ?)", itemId, itemId);
    } else if (kind === 'episode') {
        connection.run('DELETE FROM episodes WHERE id = ?', itemId);
    } else if (kind === 'task_run') {
        connection.run('DELETE FROM task_runs WHERE id = ?', itemId);
        return;
    } else {
        const url = connection.value('SELECT url FROM sources WHERE id = ?', itemId);
        connection.run('DELETE FROM knowledge_search WHERE rowid = ?', itemId);
        // Removing the source's node also removes every edge to it.
        connection.run("DELETE FROM graph_nodes WHERE kind = 'source' AND label = ?", url);
        connection.run('DELETE FROM sources WHERE id = ?', itemId);
        return;
    }
    connection.run('DELETE FROM memory_search WHERE kind = ? AND item_id = ?', kind, itemId);
    connection.run('DELETE FROM embeddings WHERE kind = ? AND item_id = ?', kind, itemId);
}

// ============================================================================
// Recall helpers
// ============================================================================

// Returns the items of one kind closest in meaning to the query, closest first, skipping vectors of another length.
function similarItems(
    connection: Connection,
    kind: string,
    queryVector: number[] | null,
    limit: number,
    minimumSimilarity: number,
): number[] {
    if (queryVector === null) {
        return [];
    }
    const rows = connection.all(
        'SELECT item_id, 1 - vec_distance_cosine(vector, ?) AS similarity FROM embeddings ' +
            'WHERE kind = ? AND length(vector) = ? ORDER BY similarity DESC LIMIT ?',
        pack(queryVector), kind, 4 * queryVector.length, limit,
    );
    return rows.filter((row) => row.similarity >= minimumSimilarity).map((row) => row.item_id);
}

// Loads an active fact with its source, its age, and the chain of topics above it.
function recalledFact(connection: Connection, factId: number, recalledAt: number): RecalledFact | null {
    const fact = connection.get(
        'SELECT f.id, f.statement, f.confidence, f.topic_id, t.name AS topic, ' +
            's.url AS source_url, COALESCE(s.retrieved_at, f.created_at) AS retrieved_at, ' +
            // A fact with no source ages from when it was stored, as its source would have.
            'COALESCE(s.expires_at, f.created_at + ?) < ? AS stale ' +
            'FROM facts f JOIN topics t ON t.id = f.topic_id ' +
            'LEFT JOIN sources s ON s.id = f.source_id ' +
            "WHERE f.id = ? AND f.status = 'active'",
        SOURCE_TTL_SECONDS, recalledAt, factId,
    );
    if (!fact) {
        return null;
    }
    return { ...fact, stale: Boolean(fact.stale), topic_path: topicPath(connection, fact.topic_id) } as RecalledFact;
}

// Returns the best facts from the branch of the most specific topic the query names, or the closest in meaning.
function branchFactIds(
    connection: Connection,
    terms: string[],
    shown: Set<number>,
    limit: number,
    queryVector: number[] | null = null,
): number[] {
    let named: Array<[number, number]> = [];
    for (const topic of connection.all('SELECT id, name FROM topics')) {
        const nameTerms = searchTerms(topic.name);
        if (nameTerms.length > 0 && nameTerms.every((term) => terms.includes(term))) {
            named.push([nameTerms.length, topic.id]);
        }
    }
    if (named.length === 0) {
        named = similarItems(connection, 'topic', queryVector, 1, TOPIC_SIMILARITY).map((topicId) => [0, topicId]);
    }
    if (named.length === 0) {
        return [];
    }
    const mostSpecific = Math.max(...named.map(([count]) => count));
    const branch = new Set<number>();
    for (const [count, topicId] of named) {
        if (count === mostSpecific) {
            branch.add(topicId);
            descendantIds(connection, topicId).forEach((id) => branch.add(id));
        }
    }
    const marks = [...branch].map(() => '?').join(', ');
    const rows = connection.all(
        `SELECT id, statement, confidence, use_count FROM facts WHERE status = 'active' AND topic_id IN (${marks})`,
        ...branch,
    );
    // Facts sharing the most of the query come first, then the most trusted and most used.
    return rows
        .filter((row) => !shown.has(row.id))
        .map((row) => ({ row, shared: sharedTermCount(terms, row.statement) }))
        .sort(
            (first, second) =>
                second.shared - first.shared ||
                second.row.confidence - first.row.confidence ||
                second.row.use_count - first.row.use_count,
        )
        .slice(0, limit)
        .map(({ row }) => row.id);
}

// Returns the graph relationships of every entity a statement names, one step out.
function relationshipsNamedIn(connection: Connection, statements: string[]): RecalledRelationship[] {
    if (statements.length === 0) {
        return [];
    }
    const text = casefold(statements.join(' '));
    const rows = connection.all(
        "SELECT id, label FROM graph_nodes WHERE kind = 'entity' AND length(label) >= 2 AND instr(?, lower(label)) > 0",
        text,
    );
    // instr also finds a name inside a longer word, so only whole-word matches count.
    const nodeIds = rows
        .filter((row) => new RegExp(`(?<!${WORD})${escapeRegExp(casefold(row.label))}(?!${WORD})`, 'u').test(text))
        .map((row) => row.id as number);
    if (nodeIds.length === 0) {
        return [];
    }
    const marks = nodeIds.map(() => '?').join(', ');
    // One relationship backed by several sources is stored once per source but recalled once, citing the newest.
    const edges = connection.all(
        'SELECT a.label AS subject, e.relation, b.label AS object, s.url AS source_url, MAX(e.id) AS newest ' +
            'FROM graph_edges e JOIN graph_nodes a ON a.id = e.source_node_id ' +
            'JOIN graph_nodes b ON b.id = e.target_node_id LEFT JOIN sources s ON s.id = e.source_id ' +
            `WHERE a.kind = 'entity' AND b.kind = 'entity' AND (e.source_node_id IN (${marks}) OR e.target_node_id IN (${marks})) ` +
            'GROUP BY e.source_node_id, e.relation, e.target_node_id ORDER BY newest DESC LIMIT ?',
        ...nodeIds, ...nodeIds, MAX_RECALLED_RELATIONSHIPS,
    );
    return edges.map((edge) => ({ subject: edge.subject, relation: edge.relation, object: edge.object, source_url: edge.source_url }));
}

// Returns a topic's ancestors from the root down, each with its summary.
function topicPath(connection: Connection, topicId: number): Array<{ name: string; summary: string }> {
    const path: Array<{ name: string; summary: string }> = [];
    const seen = new Set([topicId]);
    let parentId: number | null = connection.get('SELECT parent_id FROM topics WHERE id = ?', topicId)?.parent_id ?? null;
    // The seen set stops a parent loop from walking forever.
    while (parentId !== null && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = connection.get('SELECT name, summary, parent_id FROM topics WHERE id = ?', parentId);
        if (!parent) {
            break;
        }
        path.unshift({ name: parent.name, summary: parent.summary });
        parentId = parent.parent_id;
    }
    return path;
}
