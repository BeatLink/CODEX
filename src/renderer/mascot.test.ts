import { defaultConfig } from '@x-tech-laboratories/robobuddy';
import { describe, expect, it } from 'vitest';

import { lastingMood, momentAfter, type MascotMood } from './mascot.js';
import { beginRun, failRun, finishRun, initialState, stopRun, type WorkbenchState } from './runState.js';

function connected(changes: Partial<WorkbenchState> = {}): WorkbenchState {
    return { ...initialState(), connection: 'connected', ...changes };
}

describe('the mascot mood', () => {
    it('uses only moods RoboBuddy has', () => {
        const moods: MascotMood[] = ['default', 'thinking', 'happy', 'sad', 'asleep'];

        for (const mood of moods) expect(defaultConfig.moods).toHaveProperty(mood);
    });

    it('follows the state, most urgent first', () => {
        const running = beginRun(connected(), 1);

        expect(lastingMood(connected())).toBe('default');
        expect(lastingMood(running)).toBe('thinking');
        expect(lastingMood({ ...running, suspended: true })).toBe('asleep');
        expect(lastingMood({ ...running, connection: 'unavailable' })).toBe('asleep');
    });

    it('is happy after a completed run and sad after a failed one', () => {
        const running = beginRun(connected(), 1);

        expect(momentAfter(running, finishRun(running, 'Done'))).toBe('happy');
        expect(momentAfter(running, failRun(running, 'Broke').state)).toBe('sad');
        expect(momentAfter(running, stopRun(running, '_Run cancelled._', 'Cancelled'))).toBeNull();
        expect(momentAfter(connected(), beginRun(connected(), 1))).toBeNull();
    });

    it('goes straight to sleep when a run fails because the daemon went away', () => {
        const running = beginRun(connected(), 1);
        const lost = { ...failRun(running, 'Gone').state, connection: 'unavailable' as const };

        expect(momentAfter(running, lost)).toBeNull();
    });
});
