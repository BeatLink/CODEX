// How the window shows the knowledge store and the research queue: tree rows, sources, facts, graph lines and jobs.
import type { Fact, GraphEdge, ResearchJob, Source, Topic } from './types.js';

export const MAX_GRAPH_EDGES = 50;
export const MAX_QUEUE_JOBS = 20;
export const NO_SOURCES_TEXT = '_No matching stored evidence._';
export const NO_GRAPH_TEXT = '_No graph relationships yet._';
export const NO_FACTS_TEXT = '_No facts stored for this choice._';
export const NO_JOBS_TEXT = 'No research jobs';

// ============================================================================
// Tree
// ============================================================================

export const MAX_LISTED_SOURCES = 30;
export const UNCATEGORIZED_TEXT = 'Uncategorized';

export type TreeChoice =
    | { kind: 'all' }
    | { kind: 'topic'; id: number }
    | { kind: 'uncategorized' }
    | { kind: 'source'; id: number }
    | { kind: 'fact'; id: number };

export type TreeRow = { choice: TreeChoice; text: string; depth: number };

export function sameChoice(first: TreeChoice, second: TreeChoice): boolean {
    return first.kind === second.kind && ('id' in first ? first.id : null) === ('id' in second ? second.id : null);
}

// Orders the store as a tree under "All topics": each topic, then its subtopics, articles and findings,
// parents before children, keeping any topic a loop would hide and grouping articles with no topic last.
export function knowledgeTreeRows(topics: Topic[], sources: Source[], facts: Fact[]): TreeRow[] {
    const children = new Map<number | null, Topic[]>();
    for (const topic of topics) {
        const siblings = children.get(topic.parent_id) ?? [];
        siblings.push(topic);
        children.set(topic.parent_id, siblings);
    }
    const sourcesByTopic = groupBy(sources, (source) => source.topic_id ?? null);
    const factsByTopic = groupBy(facts, (fact) => fact.topic_id);
    const rows: TreeRow[] = [{ choice: { kind: 'all' }, text: 'All topics', depth: 0 }];
    const addEntries = (topicId: number | null, depth: number): void => {
        for (const source of sourcesByTopic.get(topicId) ?? []) {
            rows.push({ choice: { kind: 'source', id: source.id }, text: source.title || source.url, depth });
        }
        for (const fact of factsByTopic.get(topicId) ?? []) {
            rows.push({ choice: { kind: 'fact', id: fact.id }, text: fact.statement, depth });
        }
    };
    const visited = new Set<number>();
    const add = (topic: Topic, depth: number): void => {
        visited.add(topic.id);
        rows.push({ choice: { kind: 'topic', id: topic.id }, text: `${topic.name}  (${topic.source_count})`, depth });
        for (const child of children.get(topic.id) ?? []) {
            if (!visited.has(child.id)) {
                add(child, depth + 1);
            }
        }
        addEntries(topic.id, depth + 1);
    };
    for (const topic of children.get(null) ?? []) {
        add(topic, 0);
    }
    for (const topic of topics) {
        if (!visited.has(topic.id)) {
            add(topic, 0);
        }
    }
    const uncategorized = sourcesByTopic.get(null) ?? [];
    if (uncategorized.length > 0) {
        rows.push({ choice: { kind: 'uncategorized' }, text: `${UNCATEGORIZED_TEXT}  (${uncategorized.length})`, depth: 0 });
        addEntries(null, 1);
    }
    return rows;
}

function groupBy<Item>(items: Item[], key: (item: Item) => number | null): Map<number | null, Item[]> {
    const groups = new Map<number | null, Item[]>();
    for (const item of items) {
        const group = groups.get(key(item)) ?? [];
        group.push(item);
        groups.set(key(item), group);
    }
    return groups;
}

export type ChosenKnowledge = { sources: Source[]; facts: Fact[] };

// Picks what the side panes show for a tree row: a topic's newest articles and its findings,
// one article and the findings it backs, or one finding and the article it came from.
export function chosenKnowledge(choice: TreeChoice, sources: Source[], facts: Fact[]): ChosenKnowledge {
    switch (choice.kind) {
        case 'all':
            return { sources: sources.slice(0, MAX_LISTED_SOURCES), facts };
        case 'topic':
            return {
                sources: sources.filter((source) => source.topic_id === choice.id).slice(0, MAX_LISTED_SOURCES),
                facts: facts.filter((fact) => fact.topic_id === choice.id),
            };
        case 'uncategorized':
            return { sources: sources.filter((source) => source.topic_id == null).slice(0, MAX_LISTED_SOURCES), facts: [] };
        case 'source': {
            const source = sources.find((candidate) => candidate.id === choice.id);
            return {
                sources: source ? [source] : [],
                facts: source ? facts.filter((fact) => fact.source_url === source.url) : [],
            };
        }
        case 'fact': {
            const fact = facts.find((candidate) => candidate.id === choice.id);
            return {
                sources: fact?.source_url ? sources.filter((source) => source.url === fact.source_url) : [],
                facts: fact ? [fact] : [],
            };
        }
    }
}

// ============================================================================
// Sources, facts and graph
// ============================================================================

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export function formatTimestamp(seconds: number): string {
    const when = new Date(seconds * 1000);
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export function sourcesMarkdown(sources: Source[]): string {
    if (sources.length === 0) {
        return NO_SOURCES_TEXT;
    }
    return sources
        .map((source) => {
            const title = source.title || source.url;
            return (
                `### [${title}](${source.url})\n` +
                `${source.topic || 'Uncategorized'} | Retrieved ${formatTimestamp(source.retrieved_at)}\n\n` +
                `${source.snippet ?? ''}\n\n` +
                `${source.summary ?? ''}`
            );
        })
        .join('\n\n---\n\n');
}

export function factsMarkdown(facts: Fact[]): string {
    if (facts.length === 0) {
        return NO_FACTS_TEXT;
    }
    return facts
        .map((fact) => {
            const evidence = fact.source_url ? ` ([evidence](${fact.source_url}))` : '';
            const setAside = fact.status !== 'active' ? `, ${fact.status}` : '';
            return `- **${fact.topic}**: ${fact.statement} _(confidence ${fact.confidence.toFixed(2)}${setAside})_${evidence}`;
        })
        .join('\n');
}

export function graphMarkdown(edges: GraphEdge[]): string {
    const lines = edges
        .slice(0, MAX_GRAPH_EDGES)
        .map((edge) => `\`${edge.source}\` -${edge.relation}-> \`${edge.target}\`` + (edge.evidence_url ? ` ([evidence](${edge.evidence_url}))` : ''));
    return lines.length > 0 ? lines.join('\n\n') : NO_GRAPH_TEXT;
}

// ============================================================================
// Research queue
// ============================================================================

export function queueLines(jobs: ResearchJob[]): string {
    if (jobs.length === 0) {
        return NO_JOBS_TEXT;
    }
    return jobs
        .slice(0, MAX_QUEUE_JOBS)
        .map((job) => `${job.status.toUpperCase().padEnd(8)} ${job.topic}` + (job.error ? `  (${job.error})` : ''))
        .join('\n');
}
