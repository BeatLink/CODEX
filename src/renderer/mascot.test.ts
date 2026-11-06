import { RoboEyes, type Display } from '@x-tech-laboratories/roboeyes';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lastingMood, MASCOT_MOODS, mascotConfig, momentAfter, shownMood, startMoment } from './mascot.js';
import { beginRun, finishRun, initialState, stopRun, type WorkbenchState } from './runState.js';

const display: Display = { setSize() {}, clearDisplay() {}, fillRoundRect() {}, strokeLine() {}, display() {} };

function connected(changes: Partial<WorkbenchState> = {}): WorkbenchState {
    return { ...initialState(), connection: 'connected', ...changes };
}

afterEach(() => {
    vi.restoreAllMocks();
});

// ============================================================================
// Face
// ============================================================================

describe('the face', () => {
    it('names only eye states, mouth states and looks it has', () => {
        const config = mascotConfig();

        for (const name of MASCOT_MOODS) {
            const mood = config.moods[name];
            if (mood.eyes) expect(config.eyeStates, `${name} eyes`).toHaveProperty(mood.eyes);
            if (mood.mouth) expect(config.mouthStates, `${name} mouth`).toHaveProperty(mood.mouth);
            if (mood.look) expect(config.looks, `${name} look`).toHaveProperty(mood.look);
            for (const step of mood.intro ?? []) {
                if (step.eyes) expect(config.eyeStates, `${name} intro`).toHaveProperty(step.eyes);
            }
        }
    });

    it('replaces RoboEyes moods of the same name instead of merging into them', () => {
        expect(mascotConfig().moods.thinking).toEqual({ mouth: 'flat', look: 'glanceUp', blink: { interval: 4, variation: 1.2 } });
    });

    it('sets every mood on a RoboEyes face without a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const face = new RoboEyes(display, { config: mascotConfig() });
        face.begin(112, 80, 50);

        for (const name of MASCOT_MOODS) {
            face.setMood(name);
            for (let frame = 0; frame < 5; frame++) face.drawEyes();
            expect(face.mood).toBe(name);
        }

        expect(warn).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Lasting moods
// ============================================================================

describe('the lasting mood', () => {
    it('wakes while connecting and is calm once connected with nothing to do', () => {
        expect(lastingMood(initialState())).toBe('waking');
        expect(lastingMood(connected())).toBe('calm');
    });

    it('thinks during a run and is focused while background research works', () => {
        expect(lastingMood(beginRun(connected(), 1))).toBe('thinking');
        expect(lastingMood(connected({ backgroundStatus: 'Searching: tides' }))).toBe('focused');
        expect(lastingMood(connected({ backgroundStatus: 'Paused' }))).toBe('calm');
    });

    it('puts the more urgent state first', () => {
        const running = beginRun(connected({ backgroundStatus: 'Searching: tides' }), 1);
        const asking = { ...running, clarifications: [{ run_id: 1, clarification_id: 2, question: 'Which?', approval: false }] };

        expect(lastingMood(asking)).toBe('curious');
        expect(lastingMood({ ...asking, cancelling: true })).toBe('startled');
        expect(lastingMood({ ...asking, suspended: true })).toBe('asleep');
        expect(lastingMood({ ...asking, connection: 'unavailable' })).toBe('worried');
    });
});

// ============================================================================
// Moments
// ============================================================================

describe('moments', () => {
    it('gets excited when a run starts and happy when it completes', () => {
        const idle = connected();
        const running = beginRun(idle, 1);

        expect(momentAfter(idle, running)).toBe('excited');
        expect(momentAfter(running, finishRun(running, 'Done'))).toBe('happy');
        expect(momentAfter(running, stopRun(running, '_Run cancelled._', 'Cancelled'))).toBeNull();
    });

    it('wakes when the daemon resumes', () => {
        expect(momentAfter(connected({ suspended: true }), connected())).toBe('waking');
    });

    it('shows a moment over the lasting mood until it ends', () => {
        const state = connected();
        const moment = startMoment(state, 'happy', 1000);

        expect(shownMood(state, moment, 3999)).toBe('happy');
        expect(shownMood(state, moment, 4000)).toBe('calm');
    });

    it('never interrupts worried', () => {
        const lost = connected({ connection: 'unavailable' });

        expect(startMoment(lost, 'sad', 0)).toBeNull();
        expect(shownMood(lost, { mood: 'sad', until: 3000 }, 0)).toBe('worried');
    });
});
