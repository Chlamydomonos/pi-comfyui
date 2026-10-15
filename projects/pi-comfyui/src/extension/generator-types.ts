/**
 * Generator contract types (docs/20 §1) — shared between the loader
 * (src/extension/generators.ts) and generator example files.
 */

/** Context passed to `build(ctx)` when generating a graph. */
export interface GeneratorContext {
    /** Current workspace (agent cwd) as an absolute path. */
    workspace: string;
    /**
     * Resolve a workspace-relative input path to an absolute filesystem path
     * for ComfyUI path-style nodes (LoadImageFromPath / LoadVideoFromPath /
     * LoadAudioFromPath). Absolute inputs pass through unchanged.
     */
    resolvePath: (rel: string) => string;
    /** 6-hex random token, usable as a filename prefix for this run. */
    token: string;
    /** ISO timestamp at invocation time. */
    now: string;
}

/** What `build` must return: a raw ComfyUI prompt graph. */
export interface GeneratorPrompt {
    /** ComfyUI API-format graph: node id → { class_type, inputs }. */
    prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
}
