import { globalInterrupt } from './comfy-client.js';
import { SessionQueue } from './generate.js';

export interface CancelOutcome {
    /** What the request translated to. */
    action: 'job-cancelled' | 'session-queue' | 'global-interrupt' | 'not-found';
    target?: string;
}

/**
 * comfyui_cancel logic (docs/10 §3.3):
 * - with jobId → session queue cancel (interrupt if it is the active job)
 * - without jobId → interrupt the session's active job; if none of ours is
 *   running, fall back to a global ComfyUI interrupt (the server's own
 *   currently-running prompt).
 */
export async function handleCancel(
    queue: SessionQueue,
    baseUrl: string,
    jobId: string | undefined,
): Promise<CancelOutcome> {
    if (jobId) {
        const target = queue.cancel(jobId);
        return target === null ? { action: 'not-found', target: jobId } : { action: 'job-cancelled', target };
    }
    const active = queue.cancel();
    if (active !== null) return { action: 'job-cancelled', target: active };
    await globalInterrupt(baseUrl);
    return { action: 'global-interrupt' };
}

export { globalInterrupt };
