// Which of RoboEyes' own moods the mascot's face shows for the workbench state.
import { type WorkbenchState } from './runState.js';

export type MascotMood = 'default' | 'thinking' | 'happy' | 'sad' | 'asleep' | 'worried';

// The face's screen, the robot head's 28 by 20 cut-out at four pixels a unit.
export const MASCOT_SCREEN = { width: 112, height: 80 };
export const MOMENT_MILLISECONDS = 3000;

// The mood that lasts while the state holds, most urgent first.
export function lastingMood(state: WorkbenchState): MascotMood {
    if (state.connection === 'unavailable') return 'worried';
    if (state.suspended) return 'asleep';
    if (state.running) return 'thinking';
    return 'default';
}

// The mood shown for a few seconds after a run ends, if any; nothing interrupts worried.
export function momentAfter(previous: WorkbenchState, next: WorkbenchState): MascotMood | null {
    if (!previous.running || next.running || lastingMood(next) === 'worried') return null;
    if (next.status === 'Complete') return 'happy';
    if (next.status === 'Run failed') return 'sad';
    return null;
}
