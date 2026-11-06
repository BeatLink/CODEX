// The mascot's face and which emotion it shows: RoboEyes draws the eyes and mouth, CODEX picks the mood from the workbench state.
import { defaultConfig, mergeConfig, type FaceConfig, type FaceConfigPatch } from '@x-tech-laboratories/roboeyes';
import { backgroundState, type WorkbenchState } from './runState.js';

export type MascotMood =
    | 'calm'
    | 'thinking'
    | 'curious'
    | 'happy'
    | 'sad'
    | 'asleep'
    | 'worried'
    | 'excited'
    | 'focused'
    | 'startled'
    | 'waking';

// An emotion shown for a short while after an event, over the lasting one.
export type Moment = { mood: MascotMood; until: number };

// The size of the face's screen, the head's 28 by 20 screen at four pixels a unit.
export const MASCOT_SCREEN = { width: 112, height: 80 };
export const MASCOT_FRAME_RATE = 50;
export const MOMENT_MILLISECONDS: Partial<Record<MascotMood, number>> = { happy: 3000, sad: 3000, excited: 2000, waking: 2000 };

// ============================================================================
// Face
// ============================================================================

const BLINK = { interval: 4, variation: 1.2 };

// The face and its moods, laid over RoboEyes' own settings.
export const MASCOT_FACE = {
    wander: { interval: 2, variation: 2 },
    eyes: { left: { width: 30, height: 30 }, right: { width: 30, height: 30 }, spacing: 14 },
    mouth: { gap: 14, width: 45, moodWidth: true },
    eyeStates: {
        focused: { top: { height: 0.33, angle: 0, curve: 0 }, bottom: { height: 0.33, angle: 0, curve: 0 }, closed: false },
    },
    mouthStates: {
        smile: { width: 26 },
        softSmile: { width: 22 },
        slack: { width: 10 },
        frown: { width: 16 },
        flat: { width: 14 },
        smirk: { width: 18 },
        wry: { width: 18 },
        faintFrown: { left: -2, right: -2, width: 20 },
        shortFlat: { left: 0, right: 0, width: 11 },
    },
    looks: {
        upward: { x: 0.5, y: 0.35 },
        downward: { x: 0.5, y: 0.6 },
        darting: {
            x: 0.5,
            y: 0.5,
            path: [
                { x: 0.35, y: 0.5, holdMs: 400 },
                { x: 0.65, y: 0.55, holdMs: 520 },
                { x: 0.5, y: 0.35, holdMs: 390 },
            ],
        },
        bouncing: { x: 0.5, y: 0.5, nod: { amplitude: 2, speed: 0.5 } },
    },
    moods: {
        calm: { mouth: 'smirk', look: 'center', blink: BLINK },
        thinking: { mouth: 'flat', look: 'glanceUp', blink: BLINK },
        curious: { mouth: 'flat', look: 'upward', scale: 1.08, blink: { interval: 5.5, variation: 1 } },
        happy: { eyes: 'happy', mouth: 'softSmile', look: 'center', autoblink: false },
        sad: { eyes: 'sad', mouth: 'faintFrown', look: 'downward', blink: { interval: 6.5, variation: 1 } },
        asleep: { eyes: 'closed', mouth: 'shortFlat', look: 'center', autoblink: false },
        worried: { eyes: 'sad', mouth: 'wry', look: 'darting', scale: 1.05, blink: { interval: 2.5, variation: 1 } },
        excited: { mouth: 'flat', look: 'bouncing', scale: 1.12, blink: { interval: 4, variation: 2 } },
        focused: { eyes: 'focused', mouth: 'flat', look: 'scan', blink: { interval: 7, variation: 2 } },
        startled: { mouth: 'flat', look: 'center', scale: 1.12, autoblink: false, intro: [{ scale: 1.25, ms: 100 }] },
        waking: {
            mouth: 'smirk',
            look: 'center',
            blink: BLINK,
            intro: [
                { eyes: 'closed', ms: 200 },
                { eyes: 'sleepy', ms: 400 },
                { eyes: 'closed', ms: 300 },
            ],
        },
    },
} satisfies FaceConfigPatch & { moods: Record<MascotMood, unknown> };

export const MASCOT_MOODS = Object.keys(MASCOT_FACE.moods) as MascotMood[];

// RoboEyes' settings with the mascot's laid over them; RoboEyes moods of the same name are replaced, not merged into.
export function mascotConfig(): FaceConfig {
    const cleared = mergeConfig(defaultConfig, { moods: Object.fromEntries(MASCOT_MOODS.map((name) => [name, null])) });
    return mergeConfig(cleared, MASCOT_FACE);
}

// ============================================================================
// Choosing the mood
// ============================================================================

// The emotion that lasts while the state holds, most urgent first.
export function lastingMood(state: WorkbenchState): MascotMood {
    if (state.connection === 'unavailable') return 'worried';
    if (state.connection === 'connecting') return 'waking';
    if (state.suspended) return 'asleep';
    if (state.cancelling) return 'startled';
    if (state.clarifications.length > 0) return 'curious';
    if (state.running) return 'thinking';
    if (backgroundState(state.backgroundStatus) === 'working') return 'focused';
    return 'calm';
}

// The short emotion a change of state calls for, if any.
export function momentAfter(previous: WorkbenchState, next: WorkbenchState): MascotMood | null {
    if (!previous.running && next.running) return 'excited';
    if (previous.running && !next.running && next.status === 'Complete') return 'happy';
    if (previous.suspended && !next.suspended) return 'waking';
    return null;
}

// Starts a moment at now, or returns null when the mascot is already worried, which no moment interrupts.
export function startMoment(state: WorkbenchState, mood: MascotMood, now: number): Moment | null {
    if (lastingMood(state) === 'worried') return null;
    return { mood, until: now + (MOMENT_MILLISECONDS[mood] ?? 3000) };
}

export function shownMood(state: WorkbenchState, moment: Moment | null, now: number): MascotMood {
    if (moment !== null && now < moment.until && lastingMood(state) !== 'worried') return moment.mood;
    return lastingMood(state);
}
