/**
 * Wire protocol — the single source of truth shared by all three entry points:
 * pi extension (pi.events frames), pi-web server plugin (fan-out + journal),
 * and pi-web browser plugin (panel rendering).
 *
 * Docs: docs/30 §5. Everything here is pure type/constant data (JSON-safe).
 */

/** Event-bus channel between the pi extension and the pi-web server plugin. */
export const COMFYUI_CHANNEL = 'pi-comfyui';

/** Lifecycle state of a generation job. */
export type ComfyJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** One produced file, as stored inside the workspace (relative path). */
export interface ComfyFileRef {
    /** Workspace-relative path of the harvested file. */
    path: string;
    size?: number;
    mime?: string;
    /** ComfyUI output subfolder (original reference for debugging). */
    subfolder?: string;
    /** ComfyUI output type ("output" / "temp" / …). */
    type?: string;
}

/** Persisted job record (server plugin journal, docs/30 §3.3). */
export interface ComfyJobRecord {
    jobId: string;
    generator: string;
    title?: string;
    state: ComfyJobState;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
    files: ComfyFileRef[];
    error?: string;
    promptId?: string;
}

/** Frames emitted by the pi extension on the shared channel. */
export type ExtensionFrame =
    | {
          kind: 'job';
          jobId: string;
          state: ComfyJobState;
          generator: string;
          title?: string;
          /** Human-readable phase (e.g. "KSampler"). */
          phase?: string;
          message?: string;
          startedAt?: string;
          endedAt?: string;
          error?: string;
          promptId?: string;
      }
    | { kind: 'progress'; jobId: string; value: number; max: number; node?: string; label?: string }
    | { kind: 'preview'; jobId: string; mime: 'image/jpeg' | 'image/png'; data: string }
    | { kind: 'outputs'; jobId: string; files: ComfyFileRef[] }
    | { kind: 'generators'; list: { name: string; title: string }[] };

/** Frames sent by the browser over a "live" channel (docs/30 §5.2). */
export type BrowserFrame = { kind: 'cmd'; action: 'cancel'; jobId?: string } | { kind: 'cmd'; action: 'history-clear' };

/** Initial state frame sent on channel open, plus relayed extension frames. */
export type ServerFrame =
    | { kind: 'history'; records: ComfyJobRecord[] }
    | { kind: 'error'; message: string }
    | ExtensionFrame;

/** Command frame the extension receives on the channel (docs/10 §7). */
export interface CommandFrame {
    kind: 'cmd';
    action: 'cancel' | 'refresh';
    jobId?: string;
}

/** Summary payload for the panel's first paint (peer.request "summary"). */
export interface ComfySummary {
    /** Most recently seen non-terminal or last job in this workspace. */
    active?: ComfyJobSummaryJob;
    /** Number of jobs currently queued (best effort, from frames). */
    queueLen: number;
    generatorCount?: number;
}

export interface ComfyJobSummaryJob {
    jobId: string;
    generator: string;
    state: ComfyJobState;
    phase?: string;
    message?: string;
    /** Progress ratio when known. */
    value?: number;
    max?: number;
}

/** peer.request operation input payloads (docs/30 §3.2). */
export interface ComfyListRequest {
    limit?: number;
}

export interface ComfyCancelRequest {
    jobId?: string;
    /** Optional hint so the server can pick the right session connection. */
    sessionId?: string;
}
