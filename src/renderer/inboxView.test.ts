import { describe, expect, it } from 'vitest';

import { actionCards, actionMeta, inboxTabText } from './inboxView.js';
import type { ProposedAction } from './types.js';

const created = new Date(2026, 10, 5, 9, 30).getTime() / 1000;

function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
    return { id: 1, event_id: 7, kind: 'notify', title: 'Alice: Lunch?', body: 'Alice asks about lunch.', payload: '{}', status: 'proposed', created_at: created, ...overrides };
}

describe('actionMeta', () => {
    it('lists the importance, category and wait for a reply, then the time', () => {
        const payload = JSON.stringify({ importance: 'high', category: 'work', needs_reply: true });

        expect(actionMeta(action({ payload }))).toBe('high importance · work · waiting for a reply · 2026-11-05 09:30');
    });

    it('shows just the time when the payload has nothing to add or cannot be read', () => {
        expect(actionMeta(action())).toBe('2026-11-05 09:30');
        expect(actionMeta(action({ payload: 'not json' }))).toBe('2026-11-05 09:30');
        expect(actionMeta(action({ payload: '[1]' }))).toBe('2026-11-05 09:30');
    });
});

describe('actionCards', () => {
    it('makes a card with Done and Dismiss for each action', () => {
        expect(actionCards([action({ id: 4 })])).toEqual([
            {
                id: 4,
                title: 'Alice: Lunch?',
                body: 'Alice asks about lunch.',
                meta: '2026-11-05 09:30',
                buttons: [
                    { label: 'Done', resolution: 'done' },
                    { label: 'Dismiss', resolution: 'rejected' },
                ],
            },
        ]);
    });
});

describe('inboxTabText', () => {
    it('adds the count only while actions are waiting', () => {
        expect(inboxTabText(0)).toBe('Inbox');
        expect(inboxTabText(3)).toBe('Inbox (3)');
    });
});
