import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ComfyFileRef, ComfyJobState, ExtensionFrame, CommandFrame } from '../shared/protocol.js';
import {
    ComfyWsClient,
    comfyWsUrl,
    fetchHistory,
    globalInterrupt,
    submitPrompt,
    type PreviewImage,
} from './comfy-client.js';
import {
    loadGenerators,
    resolveInputPath,
    validateAndApplyDefaults,
    formatParamsErrors,
    defaultGeneratorDir,
} from './generators.js';
import { collectOutputRefs, downloadAndSave, safeResolveDir, sanitizeNameComponent } from './outputs.js';
import type { GeneratorContext, GeneratorPrompt } from './generator-types.js';

type Warn = (message: string) => void;

/** jobId → abort hook for the currently executing job (session-side cancel). */
const cancelHooks = new Map<string, () => void>();

/** Partial tool result shape pushed through onUpdate (structural, no pi import). */
export interface ToolUpdate {
    content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
    details: GenerateDetails;
}

/** Streaming details for the comfyui_generate tool. */
export interface GenerateDetails {
    jobId: string;
    generator: string;
    state: ComfyJobState;
    phase?: string;
    value?: number;
    max?: number;
    promptId?: string;
    previewCount: number;
    files: ComfyFileRef[];
    error?: string;
}

export interface RunJobDeps {
    baseUrl: string;
    timeoutMs: number;
    outputDir: string;
    previewMaxSize: number;
    previewIntervalMs: number;
    previewBytes: number;
    workspace: string;
    emitFrame: (frame: ExtensionFrame) => void;
    onUpdate: ((update: ToolUpdate) => void) | undefined;
    warn: Warn;
}

export interface GenerateJobInput {
    generator: string;
    params?: Record<string, unknown>;
    output?: { dir?: string; name?: string };
}

export interface JobResult {
    jobId: string;
    state: 'completed' | 'failed' | 'cancelled';
    files: ComfyFileRef[];
    promptId?: string;
    warnings: string[];
    error?: string;
    timings: { queueMs: number; runMs: number };
}

export function newJobId(): string {
    return `pi-${randomBytes(3).toString('hex')}`;
}

export function newToken(): string {
    return randomBytes(3).toString('hex');
}

/* ------------------------------------------------------------------ */
/*  Session-scoped FIFO queue (docs/10 §8)                            */
/* ------------------------------------------------------------------ */

interface WaitingEntry {
    jobId: string;
    title?: string;
    cancelled: boolean;
    cancelController: AbortController;
}

/**
 * One queue per extension session: a single active job + FIFO waiters.
 * `maxQueue` caps active+waiting combined. Waiting jobs that are cancelled (or
 * aborted) resolve as "cancelled" without any HTTP traffic.
 */
export class SessionQueue {
    private tail: Promise<unknown> = Promise.resolve();
    private waiting: WaitingEntry[] = [];
    private activeJobId: string | null = null;

    constructor(
        private readonly maxQueue: number,
        private readonly deps: RunJobDeps,
    ) {}

    get activeCount(): number {
        return this.activeJobId === null ? 0 : 1;
    }

    get queueLen(): number {
        return this.waiting.length;
    }

    has(jobId: string): boolean {
        return this.activeJobId === jobId || this.waiting.some((w) => w.jobId === jobId);
    }

    enqueue(
        input: GenerateJobInput,
        signal: AbortSignal | undefined,
        title: string | undefined,
        onUpdate: ((update: ToolUpdate) => void) | undefined,
    ): Promise<JobResult> {
        const total = this.activeCount + this.waiting.length;
        if (total >= this.maxQueue) {
            return Promise.reject(
                new Error(
                    `会话队列已满(上限 ${this.maxQueue}:1 个执行中 + ${this.maxQueue - 1} 个等待),请等待完成或先取消`,
                ),
            );
        }
        const jobId = newJobId();
        const queuedAt = Date.now();
        this.deps.emitFrame({
            kind: 'job',
            jobId,
            state: 'queued',
            generator: input.generator,
            title,
            startedAt: new Date().toISOString(),
            message: '已排队',
        });

        const entry: WaitingEntry = {
            jobId,
            title,
            cancelled: false,
            cancelController: new AbortController(),
        };
        this.waiting.push(entry);

        const queuedResult = (): JobResult => ({
            jobId,
            state: 'cancelled',
            files: [],
            warnings: ['任务在排队时被取消,未提交到 ComfyUI'],
            timings: { queueMs: Date.now() - queuedAt, runMs: 0 },
        });

        const runPromise = this.tail.then(async (): Promise<JobResult> => {
            if (entry.cancelled || signal?.aborted) return queuedResult();
            this.waiting = this.waiting.filter((w) => w !== entry);
            this.activeJobId = jobId;
            try {
                return await runJob(jobId, input, signal, Date.now() - queuedAt, { ...this.deps, onUpdate }, title);
            } finally {
                this.activeJobId = null;
            }
        });
        // Keep the FIFO chain going regardless of the outcome of this job.
        this.tail = runPromise.then(
            () => undefined,
            () => undefined,
        );

        // First of: the run itself, a session-side cancel, or an agent abort — wins.
        const races: Promise<JobResult>[] = [runPromise, waitForSignal(entry.cancelController.signal, queuedResult)];
        if (signal) races.push(waitForSignal(signal, queuedResult));
        return Promise.race(races);
    }

    /** Cancel the active job (interrupt) or remove a waiting job. */
    cancel(jobId?: string): string | null {
        const target = jobId ?? this.activeJobId ?? null;
        if (target === null) return null; // nothing of ours runs — caller may fall back to a global interrupt
        if (this.activeJobId === target) {
            cancelHooks.get(target)?.();
            return target;
        }
        const entry = this.waiting.find((w) => w.jobId === target);
        if (entry) {
            entry.cancelled = true;
            entry.cancelController.abort();
            this.waiting = this.waiting.filter((w) => w !== entry);
            return target;
        }
        return null;
    }
}

function waitForSignal(signal: AbortSignal, make: () => JobResult): Promise<JobResult> {
    return new Promise<JobResult>((resolveWait) => {
        if (signal.aborted) {
            resolveWait(make());
            return;
        }
        signal.addEventListener('abort', () => resolveWait(make()), { once: true });
    });
}

/* ------------------------------------------------------------------ */
/*  Rate-limited live emitter (progress / preview, docs/10 §6)        */
/* ------------------------------------------------------------------ */

class LiveEmitter {
    private lastEmit = 0;
    phase?: string;
    value?: number;
    max?: number;
    previewCount = 0;

    constructor(
        private readonly jobId: string,
        private readonly generator: string,
        private readonly title: string | undefined,
        private readonly deps: RunJobDeps,
        readonly promptId?: string,
    ) {}

    private throttled(): boolean {
        const now = Date.now();
        if (now - this.lastEmit < this.deps.previewIntervalMs) return false;
        this.lastEmit = now;
        return true;
    }

    details(state: ComfyJobState = 'running'): GenerateDetails {
        return {
            jobId: this.jobId,
            generator: this.generator,
            state,
            phase: this.phase,
            value: this.value,
            max: this.max,
            promptId: this.promptId,
            previewCount: this.previewCount,
            files: [],
        };
    }

    /** Rate-limited progress: channel frame + model-facing details update. */
    progress(value: number, max: number): void {
        if (!this.throttled()) return;
        this.value = value;
        this.max = max;
        this.deps.emitFrame({ kind: 'progress', jobId: this.jobId, value, max, node: this.phase });
        this.deps.onUpdate?.({ content: [], details: this.details() });
    }

    /** Node-phase change: not throttled (node boundaries are naturally sparse). */
    setPhase(node: string): void {
        this.phase = node;
        this.deps.emitFrame({
            kind: 'job',
            jobId: this.jobId,
            state: 'running',
            generator: this.generator,
            title: this.title,
            phase: node,
            promptId: this.promptId,
        });
        this.deps.onUpdate?.({ content: [], details: this.details() });
    }

    /** File-saving detail update: model-facing only, throttled. */
    saving(filename: string): void {
        this.phase = `保存 ${filename}`;
        if (!this.throttled()) return;
        this.deps.onUpdate?.({ content: [], details: this.details() });
    }

    async preview(image: PreviewImage): Promise<void> {
        if (!this.throttled()) return;
        let chosen = image;
        if (image.data.byteLength > this.deps.previewBytes) {
            chosen = (await resizePreview(image, this.deps.previewMaxSize)) ?? image;
            if (chosen.data.byteLength > this.deps.previewBytes) return; // drop oversized frame
        }
        this.previewCount += 1;
        const base64 = Buffer.from(chosen.data).toString('base64');
        this.deps.emitFrame({ kind: 'preview', jobId: this.jobId, mime: chosen.mime, data: base64 });
        this.deps.onUpdate?.({
            content: [{ type: 'image', data: base64, mimeType: chosen.mime }],
            details: this.details(),
        });
    }
}

/** Optional sharp downscale — sharp is an optional dependency; missing → null. */
async function resizePreview(image: PreviewImage, maxSize: number): Promise<PreviewImage | null> {
    try {
        const moduleName = 'sharp';
        const mod = (await import(moduleName)) as { default?: (input: unknown) => SharpInstance };
        if (!mod.default) return null;
        const buf = await mod
            .default(image.data)
            .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
        return { mime: 'image/jpeg', data: new Uint8Array(buf) };
    } catch {
        return null;
    }
}

interface SharpInstance {
    resize(w: number, h: number, opts: object): SharpInstance;
    jpeg(opts: object): SharpInstance;
    toBuffer(): Promise<Buffer>;
}

/* ------------------------------------------------------------------ */
/*  Job execution (docs/10 §3 — the 9 steps)                          */
/* ------------------------------------------------------------------ */

async function runJob(
    jobId: string,
    input: GenerateJobInput,
    signal: AbortSignal | undefined,
    queueMs: number,
    deps: RunJobDeps,
    title?: string,
): Promise<JobResult> {
    const startedAt = Date.now();
    const startedIso = new Date().toISOString();

    // ── Step 1. Pre-checks: load generators, validate params, resolve output dir ──
    const { generators, invalid } = await loadGenerators(defaultGeneratorDir(deps.workspace));
    const generator = generators.find((g) => g.name === input.generator);
    if (!generator) {
        const known = [...generators.map((g) => g.name), ...invalid.map((i) => `${i.file} (无效)`)].join(', ');
        throw new Error(`生成器 "${input.generator}" 未找到。可用: ${known || '(无)'}`);
    }
    const validated = validateAndApplyDefaults(generator.params, input.params ?? {});
    if (!validated.ok) {
        throw new Error(`生成器 "${input.generator}" 参数无效: ${formatParamsErrors(validated.errors ?? [])}`);
    }
    const outDirRaw = input.output?.dir ?? deps.outputDir;
    if (
        typeof outDirRaw !== 'string' ||
        outDirRaw.trim() === '' ||
        safeResolveDir(deps.workspace, outDirRaw) === null
    ) {
        throw new Error(`output.dir 无效(必须是工作区内的相对路径): ${JSON.stringify(outDirRaw)}`);
    }
    const outDirAbs = safeResolveDir(deps.workspace, outDirRaw)!;
    const nameRaw = input.output?.name;
    if (nameRaw !== undefined && sanitizeNameComponent(nameRaw) === null) {
        throw new Error(`output.name 无效(不能为空、路径或以 ".." 逃逸)`);
    }

    // ── Step 2. WebSocket first (docs/40 §4.1) ──
    const clientId = `${newToken()}${newToken()}`;
    const ws = new ComfyWsClient(comfyWsUrl(deps.baseUrl, clientId));
    ws.start(); // the client does not auto-connect on construction
    const connected = await waitForWsOpen(ws, 10_000);
    if (!connected) deps.warn('comfyui: WebSocket 连接失败,事件改由轮询兜底');

    // ── Step 3. Build the graph ──
    const genCtx: GeneratorContext = {
        workspace: deps.workspace,
        resolvePath: (rel: string) => resolveInputPath(deps.workspace, rel),
        token: newToken(),
        now: startedIso,
    };
    let graph: unknown;
    try {
        // Generator contract (docs/20 §2): build(params, ctx) → { prompt }.
        // `validated.value` already has defaults deep-merged.
        graph = generator.build(validated.value ?? {}, genCtx);
        if (graph instanceof Promise) graph = await graph;
        graph = (graph as { prompt?: unknown } | undefined)?.prompt ?? graph;
        if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
            throw new Error('返回值不是 ComfyUI prompt 对象');
        }
    } catch (error) {
        ws.close();
        throw new Error(
            `生成器 "${input.generator}" build 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    // ── Step 4. POST /prompt ──
    let promptId: string;
    let submissionWarnings: string[] = [];
    try {
        const submission = await submitPrompt(deps.baseUrl, graph, clientId, { pi_generator: input.generator });
        promptId = submission.promptId;
        const nodeErrorKeys = Object.keys(submission.nodeErrors ?? {});
        if (nodeErrorKeys.length > 0) {
            submissionWarnings = [
                `提交时部分节点校验有警告(${nodeErrorKeys.length} 个节点): ${JSON.stringify(submission.nodeErrors).slice(0, 1500)}`,
            ];
        }
    } catch (error) {
        ws.close();
        throw error;
    }

    deps.emitFrame({
        kind: 'job',
        jobId,
        state: 'running',
        generator: input.generator,
        title,
        startedAt: startedIso,
        promptId,
        message: '已在 ComfyUI 执行',
    });

    const emitter = new LiveEmitter(jobId, input.generator, title, deps, promptId);

    // ── Step 5. Drive to a terminal state (WS events + 2s fallback polling) ──
    const final = await driveToTerminal(deps, ws, promptId, jobId, emitter, signal, {
        generator: input.generator,
        title,
    });

    // ── Step 6. Harvest outputs ──
    const warnings = [...submissionWarnings];
    let files: ComfyFileRef[] = [];
    if (final.state === 'completed') {
        files = await harvestOutputs(deps, promptId, outDirAbs, nameRaw, warnings, emitter);
    }
    const runMs = Date.now() - startedAt;
    ws.close();

    // ── Step 7. Terminal frames ──
    deps.emitFrame({
        kind: 'job',
        jobId,
        state: final.state,
        generator: input.generator,
        title,
        startedAt: startedIso,
        endedAt: new Date().toISOString(),
        error: final.error,
        promptId,
    });
    if (files.length > 0) deps.emitFrame({ kind: 'outputs', jobId, files });

    return {
        jobId,
        state: final.state,
        files: final.state === 'completed' ? files : [],
        promptId,
        warnings,
        error: final.error,
        timings: { queueMs, runMs },
    };
}

/** Terminal-only job states (queued/running never escape driveToTerminal). */
type TerminalJobState = 'completed' | 'failed' | 'cancelled';

/** All settle paths funnel through this deferred to guarantee single cleanup. */
async function driveToTerminal(
    deps: RunJobDeps,
    ws: ComfyWsClient,
    promptId: string,
    jobId: string,
    emitter: LiveEmitter,
    signal: AbortSignal | undefined,
    meta: { generator: string; title?: string },
): Promise<{ state: TerminalJobState; error?: string }> {
    return new Promise((resolveFinal) => {
        let settled = false;
        const timeoutHandle = setTimeout(
            () => settle('failed', `任务超时(>${Math.round(deps.timeoutMs / 1000)}s),已发送 interrupt`),
            deps.timeoutMs,
        );

        const cleanup = () => {
            clearTimeout(timeoutHandle);
            cancelHooks.delete(jobId);
            if (signal) signal.removeEventListener('abort', onAbort);
            clearInterval(pollInterval);
            ws.onJson = () => {};
            ws.onBinary = () => {};
        };

        function settle(state: TerminalJobState, error?: string): void {
            if (settled) return;
            settled = true;
            cleanup();
            resolveFinal({ state, error });
        }

        // Interrupt + await confirmation (max 5s) — used by abort & timeout.
        const interruptAndSettle = (state: TerminalJobState, error: string | undefined) => {
            void interruptPrompt(deps.baseUrl, promptId);
            // ComfyUI confirms with execution_interrupted; the WS handler will
            // settle sooner when it arrives. Hard cap 5s:
            setTimeout(() => settle(state, error), 5_000);
        };

        const onAbort = () => interruptAndSettle('cancelled', undefined);
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        cancelHooks.set(jobId, onAbort);

        // 2s fallback polling (docs/10 §5): completion detection survives WS loss.
        let pollErrors = 0;
        const pollInterval = setInterval(async () => {
            try {
                const entry = await fetchHistory(deps.baseUrl, promptId);
                pollErrors = 0;
                if (entry?.status?.completed) settle('completed');
            } catch {
                pollErrors += 1;
                if (pollErrors >= 15) settle('failed', 'ComfyUI history 请求连续失败(30s),任务状态未知');
            }
        }, 2_000);

        ws.onJson = (event) => {
            switch (event.type) {
                case 'execution_start':
                    break;
                case 'executing': {
                    const node = event.data.node;
                    if (typeof node === 'string' && node !== '') {
                        emitter.phase = node;
                        deps.emitFrame({
                            kind: 'job',
                            jobId,
                            state: 'running',
                            generator: meta.generator,
                            title: meta.title,
                            phase: node,
                            promptId,
                        });
                        deps.onUpdate?.({ content: [], details: emitter.details() });
                    }
                    break;
                }
                case 'progress': {
                    const value = typeof event.data.value === 'number' ? event.data.value : 0;
                    const max = typeof event.data.max === 'number' ? event.data.max : 0;
                    emitter.progress(value, max);
                    break;
                }
                case 'execution_error': {
                    const nodeType = typeof event.data.node_type === 'string' ? event.data.node_type : '?';
                    const message =
                        typeof event.data.exception_message === 'string' ? event.data.exception_message : '未知错误';
                    const traceback = typeof event.data.traceback === 'string' ? event.data.traceback : '';
                    settle(
                        'failed',
                        `节点 ${nodeType} 执行失败: ${message}${traceback ? `\n${traceback.slice(0, 800)}` : ''}`,
                    );
                    break;
                }
                case 'execution_interrupted':
                    settle('cancelled');
                    break;
                default:
                    break; // executed / execution_cached / progress_state / status / feature_flags → ignore
            }
        };

        ws.onBinary = (image) => {
            void emitter.preview(image);
        };

        ws.onDone = () => {
            // Reconnect (inside ComfyWsClient) already happened once; from here
            // on pure polling decides the outcome.
            deps.warn('comfyui: WebSocket 已断开,继续使用轮询检测完成状态');
        };
    });
}

async function interruptPrompt(baseUrl: string, promptId: string): Promise<void> {
    try {
        await fetch(`${baseUrl}/interrupt`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt_id: promptId }),
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        /* best effort */
    }
}

async function waitForWsOpen(ws: ComfyWsClient, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolveOpen) => {
        if (ws.alive) {
            resolveOpen(true);
            return;
        }
        const timer = setTimeout(() => finish(false), timeoutMs);
        const onOpen = () => finish(true);
        const prevDone = ws.onDone;
        const finish = (result: boolean) => {
            clearTimeout(timer);
            ws.onDone = prevDone;
            ws.onOpen = () => {};
            resolveOpen(result);
        };
        ws.onOpen = onOpen;
        ws.onDone = () => {
            prevDone();
            finish(false);
        };
    });
}

/* ------------------------------------------------------------------ */
/*  Harvest (docs/10 §3 step 7, docs/20 D6)                           */
/* ------------------------------------------------------------------ */

async function harvestOutputs(
    deps: RunJobDeps,
    promptId: string,
    outDirAbs: string,
    nameRaw: string | undefined,
    warnings: string[],
    emitter: LiveEmitter,
): Promise<ComfyFileRef[]> {
    // /history may not be updated at the exact same moment the completion event
    // arrives — retry a couple of times before giving up.
    let history = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        history = await fetchHistory(deps.baseUrl, promptId).catch(() => null);
        if (history && Object.keys(history.outputs ?? {}).length > 0) break;
        await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!history) {
        warnings.push('无法读取 ComfyUI history,未返回输出文件');
        return [];
    }
    const harvested = collectOutputRefs(history);
    if (harvested.length === 0) {
        warnings.push('ComfyUI history 中没有输出文件(检查生成器的输出节点)');
        return [];
    }

    const baseName = nameRaw !== undefined ? (sanitizeNameComponent(nameRaw) ?? undefined) : undefined;
    const resolvedTotal = harvested.length;

    const files: ComfyFileRef[] = [];
    for (let ordinal = 0; ordinal < harvested.length; ordinal += 1) {
        const item = harvested[ordinal]!;
        try {
            const fileRef = await downloadAndSave(deps.baseUrl, deps.workspace, item, outDirAbs, baseName, ordinal);
            files.push(fileRef);
            emitter.saving(item.ref.filename);
        } catch (error) {
            warnings.push(`下载 ${item.ref.filename} 失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (files.length !== resolvedTotal) {
        warnings.push(`${resolvedTotal - files.length} 个输出文件下载失败`);
    }
    return files;
}

/** Compose the final content text for a finished job (docs/10 §3 step 9). */
export function composeResultText(result: JobResult): string {
    const lines: string[] = [];
    if (result.state === 'completed') {
        lines.push(
            `✅ 生成完成(${(result.timings.runMs / 1000).toFixed(1)}s${result.timings.queueMs > 500 ? `,排队 ${(result.timings.queueMs / 1000).toFixed(1)}s` : ''})${result.promptId ? ` · ${result.promptId}` : ''}`,
        );
        for (const file of result.files) lines.push(`- ${file.path}`);
    } else if (result.state === 'cancelled') {
        lines.push(`⏹ 任务已取消: ${result.jobId}`);
    } else {
        lines.push(`❌ 任务失败: ${result.error ?? '未知错误'}`);
        lines.push(`(jobId ${result.jobId})`);
    }
    for (const warning of result.warnings) lines.push(`⚠ ${warning}`);
    return lines.join('\n');
}

/** structuredContent shape shared with the generate tool outputSchema (docs/10 §3 step 9). */
export function composeStructured(result: JobResult, generator: string): Record<string, unknown> {
    return {
        jobId: result.jobId,
        generator,
        state: result.state,
        files: result.files,
        promptId: result.promptId,
        timings: result.timings,
        ...(result.error ? { error: result.error } : {}),
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
}

/** Command-frame handler wiring (docs/10 §7): channel cmd → queue.cancel. */
export function makeCommandHandler(queue: SessionQueue, baseUrl: string, warn: Warn): (data: unknown) => void {
    return (data) => {
        if (!data || typeof data !== 'object') return;
        const frame = data as Partial<CommandFrame>;
        if (frame.kind !== 'cmd') return;
        if (frame.action === 'cancel') {
            const cancelled = queue.cancel(frame.jobId);
            if (cancelled !== null) {
                warn(`comfyui: 面板请求取消 ${cancelled}`);
            } else if (!frame.jobId) {
                // Nothing of ours runs — fall back to a global ComfyUI interrupt.
                void globalInterrupt(baseUrl);
                warn('comfyui: 面板请求全局 interrupt');
            }
        }
        // "refresh" is handled server-side; nothing to do here.
    };
}
