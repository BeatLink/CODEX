// The shapes of the daemon's replies and events that the window reads, with the protocol's own snake_case keys.

export type Settings = Record<string, unknown> & {
    mode: string;
    model_path: string;
    filesystem_root: string;
    allow_file_writes: boolean;
    background_research_enabled: boolean;
    mcp_servers: unknown[];
};

export type StepRecord = { name: string; status: string; started_at: number; ended_at: number | null; error: string };

export type TaskNode = {
    id: string;
    prompt: string;
    deliverable: string;
    status: string;
    approach?: string | null;
    depends_on?: string[];
    note?: string | null;
    result?: string | null;
    result_shortened?: boolean;
    steps?: StepRecord[];
};

export type RunSnapshot = {
    run_id: number;
    prompt: string;
    tree: TaskNode[];
    progress: string[];
    outputs: Record<string, string>;
    inputs?: Record<string, StepInput>;
};

export type StepInput = { system: string; input: string };

export type UnfinishedRun = {
    id: number;
    prompt: string;
    status: string;
    tasks_done: number;
    tasks_total: number;
    started_at?: number;
    updated_at?: number;
};

export type Status = {
    settings: Settings;
    settings_path: string;
    run: RunSnapshot | null;
    background: { status: string; output: string };
    suspended?: boolean;
    unfinished_runs: UnfinishedRun[];
};

export type Topic = {
    id: number;
    name: string;
    parent_id: number | null;
    parent?: string | null;
    priority?: number;
    last_researched_at?: number | null;
    source_count: number;
};

export type Source = {
    id: number;
    title?: string | null;
    url: string;
    snippet?: string;
    summary?: string;
    query?: string;
    retrieved_at: number;
    topic_id?: number | null;
    topic?: string | null;
};

export type Fact = {
    id: number;
    statement: string;
    confidence: number;
    status: string;
    topic_id: number;
    topic: string;
    source_url?: string | null;
};

export type GraphEdge = {
    source: string;
    relation: string;
    target: string;
    source_kind?: string;
    target_kind?: string;
    evidence_url: string | null;
};

// Every topic, article and finding in the store, plus the articles a search matched.
export type Knowledge = {
    topics: Topic[];
    sources: Source[];
    facts: Fact[];
    graph: GraphEdge[];
    matches: Source[];
};

export type ResearchJob = {
    id: number;
    topic: string;
    status: string;
    requested_at?: number;
    error: string | null;
};

export type ProposedAction = {
    id: number;
    event_id: number | null;
    kind: string;
    title: string;
    body: string;
    // JSON text of what the handler recorded, such as the category and importance of a mail.
    payload: string;
    status: string;
    created_at: number;
};

export type SizeChoice = {
    context_size: number;
    max_tokens: number;
    background_max_tokens: number;
    background_context_size: number;
    explanation: string;
};

export type UserCommand = { name: string; description: string; mode: string | null };

export type CodexApi = {
    connect(): Promise<{ socket_path: string; started: boolean }>;
    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    onEvent(listener: (event: string, data: Record<string, unknown>) => void): () => void;
    openDialog(options?: { title?: string; defaultPath?: string; directory?: boolean; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
    saveDialog(options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
    copyText(text: string): Promise<boolean>;
    listCommands(filesystemRoot: string): Promise<UserCommand[]>;
    getAutostart(): Promise<boolean>;
    setAutostart(enabled: boolean): Promise<boolean>;
    restartDaemon(): Promise<boolean>;
};
