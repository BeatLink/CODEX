// What the main process tells the user about proposed actions: the count for the tray, and notifications for new ones.

export type ActionSummary = { id: number; title: string };

// Most titles one desktop notification lists before it counts the rest.
export const MAX_NOTIFIED_TITLES = 3;

// Reads the id and title of each action the daemon listed, ignoring entries of any other shape.
export function summarizeActions(reply: unknown): ActionSummary[] {
    if (!Array.isArray(reply)) {
        return [];
    }
    return reply.flatMap((entry): ActionSummary[] => {
        const { id, title } = (entry ?? {}) as Record<string, unknown>;
        return typeof id === 'number' && typeof title === 'string' ? [{ id, title }] : [];
    });
}

// Splits the listed actions into those newer than the last one seen, oldest first, and the highest id now seen.
export function freshActions(seenUpTo: number, actions: ActionSummary[]): { fresh: ActionSummary[]; seenUpTo: number } {
    const fresh = actions.filter((action) => action.id > seenUpTo).sort((first, second) => first.id - second.id);
    return { fresh, seenUpTo: fresh.length > 0 ? fresh[fresh.length - 1].id : seenUpTo };
}

// The text of one notification for actions the user has not seen, or null when there are none.
export function notificationBody(fresh: ActionSummary[]): string | null {
    if (fresh.length === 0) {
        return null;
    }
    const shown = fresh.slice(-MAX_NOTIFIED_TITLES).reverse().map((action) => action.title);
    const more = fresh.length - shown.length;
    return more > 0 ? `${shown.join('\n')}\nand ${more} more` : shown.join('\n');
}
