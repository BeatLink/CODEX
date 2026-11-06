// The background jobs in the order they are tried: events the user is waiting on first, upkeep after.
import type { BackgroundOptions } from './background.js';
import type { Settings } from './settings.js';

export type BackgroundStep = (settings: Settings, options: BackgroundOptions) => Promise<boolean>;

export const JOB_CLASSES = ['reactive', 'maintenance'] as const;
export type JobClass = (typeof JOB_CLASSES)[number];

export type Job = {
    name: string;
    jobClass: JobClass;
    step: BackgroundStep;
};

// Run the first job that has work, reactive jobs before maintenance ones, and return its name, or null when none did.
export async function runNextJob(jobs: readonly Job[], settings: Settings, options: BackgroundOptions): Promise<string | null> {
    for (const jobClass of JOB_CLASSES) {
        for (const job of jobs) {
            if (job.jobClass === jobClass && (await job.step(settings, options))) {
                return job.name;
            }
        }
    }
    return null;
}
