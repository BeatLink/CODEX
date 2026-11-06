import { describe, expect, it } from 'vitest';

import { freshActions, MAX_NOTIFIED_TITLES, notificationBody, summarizeActions } from './inbox.js';

describe('summarizeActions', () => {
    it('keeps the id and title of each listed action and drops entries of another shape', () => {
        expect(summarizeActions([{ id: 2, title: 'Call', body: 'x' }, { id: 'x', title: 'Bad' }, null, { id: 3 }])).toEqual([{ id: 2, title: 'Call' }]);
        expect(summarizeActions('nothing')).toEqual([]);
    });
});

describe('freshActions', () => {
    const listed = [
        { id: 5, title: 'Newest' },
        { id: 4, title: 'Middle' },
        { id: 2, title: 'Old' },
    ];

    it('returns the actions after the last one seen, oldest first, and the new mark', () => {
        expect(freshActions(2, listed)).toEqual({ fresh: [listed[1], listed[0]], seenUpTo: 5 });
    });

    it('returns nothing and keeps the mark when nothing is newer', () => {
        expect(freshActions(5, listed)).toEqual({ fresh: [], seenUpTo: 5 });
        expect(freshActions(0, [])).toEqual({ fresh: [], seenUpTo: 0 });
    });
});

describe('notificationBody', () => {
    it('is null with nothing new and lists the newest titles first', () => {
        expect(notificationBody([])).toBeNull();
        expect(notificationBody([{ id: 1, title: 'First' }, { id: 2, title: 'Second' }])).toBe('Second\nFirst');
    });

    it('counts the ones it leaves out', () => {
        const fresh = Array.from({ length: MAX_NOTIFIED_TITLES + 2 }, (_, index) => ({ id: index + 1, title: `Item ${index + 1}` }));

        expect(notificationBody(fresh)).toBe('Item 5\nItem 4\nItem 3\nand 2 more');
    });
});
