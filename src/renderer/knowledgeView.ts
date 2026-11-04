// How the window shows the knowledge store and the research queue: topic rows, sources, facts, graph lines and jobs.
import type { Fact, GraphEdge, ResearchJob, Source, Topic } from './types.js';

export const MAX_GRAPH_EDGES = 50;
export const MAX_QUEUE_JOBS = 20;
export const NO_SOURCES_TEXT = '_No matching stored evidence._';
export const NO_GRAPH_TEXT = '_No graph relationships yet._';
export const NO_FACTS_TEXT = '_No facts stored for this choice._';
export const NO_JOBS_TEXT = 'No research jobs';

// ============================================================================
// Topics
// ============================================================================

export type TopicRow = { id: number | null; text: string; depth: number };

// Orders topics as a tree under "All topics", parents before children, and keeps any topic a loop would hide.
export function topicRows(topics: Topic[]): TopicRow[] {
    const children = new Map<number | null, Topic[]>();
    for (const topic of topics) {
        const siblings = children.get(topic.parent_id) ?? [];
        siblings.push(topic);
        children.set(topic.parent_id, siblings);
    }
    const rows: TopicRow[] = [{ id: null, text: 'All topics', depth: 0 }];
    const visited = new Set<number>();
    const add = (topic: Topic, depth: number): void => {
        visited.add(topic.id);
        rows.push({ id: topic.id, text: `${topic.name}  (${topic.source_count})`, depth });
        for (const child of children.get(topic.id) ?? []) {
            if (!visited.has(child.id)) {
                add(child, depth + 1);
            }
        }
    };
    for (const topic of children.get(null) ?? []) {
        add(topic, 0);
    }
    for (const topic of topics) {
        if (!visited.has(topic.id)) {
            add(topic, 0);
        }
    }
    return rows;
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
