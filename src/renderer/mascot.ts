// Which of RoboEyes' own moods the mascot's face shows for the workbench state.
import { type WorkbenchState } from './runState.js';

export type MascotMood = 'default' | 'thinking' | 'happy' | 'sad' | 'asleep';

// The face's screen, the 26 by 18 screen inside the robot head at five pixels a unit.
export const MASCOT_SCREEN = { width: 130, height: 90 };
export const MOMENT_MILLISECONDS = 3000;

// The mood that lasts while the state holds, most urgent first.
export function lastingMood(state: WorkbenchState): MascotMood {
    if (state.connection === 'unavailable' || state.suspended) return 'asleep';
    if (state.running) return 'thinking';
    return 'default';
}

// The mood shown for a few seconds after a run ends, if any; none while the daemon is unavailable.
export function momentAfter(previous: WorkbenchState, next: WorkbenchState): MascotMood | null {
    if (!previous.running || next.running || next.connection === 'unavailable') return null;
    if (next.status === 'Complete') return 'happy';
    if (next.status === 'Run failed') return 'sad';
    return null;
}
