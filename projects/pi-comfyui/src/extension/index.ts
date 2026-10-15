import { Type } from 'typebox';
import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionContext,
    ExtensionFactory,
    ExtensionToolContext,
    ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { loadConfig, normalizeBaseUrl, type ComfyConfig } from './config.js';
import {
    SessionQueue,
    composeResultText,
    composeStructured,
    makeCommandHandler,
    type GenerateDetails,
    type JobResult,
    type RunJobDeps,
} from './generate.js';
import { collectGenerators, type ListDetails } from './list.js';
import { collectStatus, type StatusDetails } from './status.js';
import { handleCancel, type CancelOutcome } from './cancel.js';
import { COMFYUI_CHANNEL, type CommandFrame, type ComfyJobRecord, type ExtensionFrame } from '../shared/protocol.js';

/* ------------------------------------------------------------------ */
/*  Tool parameter schemas (docs/10 §3.2)                             */
/* ------------------------------------------------------------------ */

const generateParams = Type.Object({
    generator: Type.String({ description: '生成器名称(generators/*.js 的 name,见 comfyui_list_generators)' }),
    params: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: '生成器参数(按所选生成器的 schema)' }),
    ),
    output: Type.Optional(
        Type.Object({
            dir: Type.Optional(Type.String({ description: '输出目录(工作区相对;默认取 comfyui 配置 outputDir)' })),
            name: Type.Optional(Type.String({ description: '输出文件名去扩展名;多产物自动 -2/-3 后缀' })),
        }),
    ),
});

const emptyParams = Type.Object({});

const cancelParams = Type.Object({
    jobId: Type.Optional(Type.String({ description: '要取消的任务 ID(comfyui_generate 返回);缺省 = 当前任务' })),
});

/** Details type of comfyui_generate (also the outputSchema's Static). */
const generateOutputSchema = Type.Object({
    jobId: Type.String(),
    promptId: Type.Optional(Type.String()),
    generator: Type.String(),
    state: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled')]),
    files: Type.Array(
        Type.Object({
            path: Type.String(),
            size: Type.Optional(Type.Number()),
            mime: Type.Optional(Type.String()),
            subfolder: Type.Optional(Type.String()),
            type: Type.Optional(Type.String()),
        }),
    ),
    timings: Type.Object({
        queueMs: Type.Number(),
        runMs: Type.Number(),
    }),
    error: Type.Optional(Type.String()),
});

type GenerateOutput = {
    jobId: string;
    promptId?: string;
    generator: string;
    state: 'completed' | 'failed' | 'cancelled';
    files: {
        path: string;
        size?: number;
        mime?: string;
        subfolder?: string;
        type?: string;
    }[];
    timings: { queueMs: number; runMs: number };
    error?: string;
};

const TOOL_NAMESPACE = { name: 'comfyui', description: 'ComfyUI 图像/视频生成本地工作流' } as const;

/* ------------------------------------------------------------------ */
/*  Extension                                                         */
/* ------------------------------------------------------------------ */

interface SessionState {
    cwd: string;
    cfg: ComfyConfig;
    baseUrl: string;
    queue: SessionQueue;
    /** Last non-terminal or terminal job seen, for the panel summary. */
    lastRecord: ComfyJobRecord | null;
    unsubscribeCmd: () => void;
    generatorCount?: number;
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
    let session: SessionState | null = null;

    const warn = (message: string) => {
        // pi.ui? Not every mode has UI; console goes to the runtime log.
        console.warn(`[pi-comfyui] ${message}`);
    };

    const emitFrame = (frame: ExtensionFrame) => {
        // Feed job/progress/outputs frames to live records + the shared channel.
        updateLastRecord(frame);
        pi.events.emit(COMFYUI_CHANNEL, frame);
    };

    function updateLastRecord(frame: ExtensionFrame): void {
        if (!session) return;
        if (frame.kind === 'job') {
            const prev = session.lastRecord?.jobId === frame.jobId ? session.lastRecord : null;
            session.lastRecord = {
                jobId: frame.jobId,
                generator: frame.generator,
                title: frame.title ?? prev?.title,
                state: frame.state,
                startedAt: frame.startedAt ?? prev?.startedAt,
                endedAt: frame.endedAt,
                error: frame.error,
                promptId: frame.promptId ?? prev?.promptId,
                files: prev?.files ?? [],
            };
        } else if (frame.kind === 'outputs') {
            if (session.lastRecord?.jobId === frame.jobId) session.lastRecord.files = frame.files;
        }
    }

    async function ensureSession(ctx: ExtensionContext): Promise<SessionState> {
        if (session && session.cwd === ctx.cwd) return session;
        const cfg = loadConfig(ctx.cwd, warn);
        const { url } = normalizeBaseUrl(cfg.baseUrl);
        const deps: RunJobDeps = {
            baseUrl: url.origin,
            timeoutMs: cfg.timeoutMs,
            outputDir: cfg.outputDir,
            previewMaxSize: cfg.previewMaxSize,
            previewIntervalMs: cfg.previewIntervalMs,
            previewBytes: cfg.previewBytes,
            workspace: ctx.cwd,
            emitFrame,
            onUpdate: undefined, // set per-call by the generate tool
            warn,
        };
        const commandHandler = makeCommandHandler;
        void commandHandler;
        const state: SessionState = {
            cwd: ctx.cwd,
            cfg,
            baseUrl: url.origin,
            queue: new SessionQueue(cfg.maxQueue, deps),
            lastRecord: null,
            unsubscribeCmd: pi.events.on(COMFYUI_CHANNEL, (data) => {
                // Docs/10 §7: only cmd frames reach the handler here.
                if (!data || typeof data !== 'object' || (data as CommandFrame).kind !== 'cmd') return;
                makeCommandHandler(state.queue, state.baseUrl, warn)(data);
            }),
        };
        session = state;
        // Per-session active tool set from config (docs/10 §2).
        pi.setActiveTools(cfg.tools.map((t) => `comfyui_${t}`));
        return state;
    }

    pi.on('session_start', async (_event, ctx) => {
        await ensureSession(ctx);
        // Publish an initial generators frame so the panel has data early.
        const { text, details } = await collectGenerators(ctx.cwd);
        void text; // tool-facing; frames below are for the panel
        session!.generatorCount = details.generators.filter((g) => g.valid).length;
        pi.events.emit(COMFYUI_CHANNEL, {
            kind: 'generators',
            list: details.generators
                .filter((g) => g.valid)
                .slice(0, 50)
                .map((g) => ({ name: g.name, title: g.title ?? g.name })),
        });
    });

    pi.on('session_shutdown', () => {
        // Idempotent cleanup; do NOT interrupt the remote job (docs/10 §8).
        session?.unsubscribeCmd();
        session = null;
    });

    /* ---------------------------- tools ---------------------------- */

    /**
     * Shared helper: session queue for the caller. Throws when the session
     * never started (shouldn't happen — tools run after session_start).
     */
    function sessionFor(ctx: ExtensionToolContext): SessionState {
        if (session && session.cwd === ctx.cwd) return session;
        throw new Error('comfyui 会话尚未初始化');
    }

    const generateTool: ToolDefinition<typeof generateParams, GenerateDetails, unknown> = {
        name: 'comfyui_generate',
        label: 'ComfyUI 生成',
        description: [
            '用本地 ComfyUI 运行一个生成器(工作流)生成图像/视频/音频。',
            'generator 取 comfyui_list_generators 中的一个名字;params 按该生成器声明的参数填写。',
            '任务在会话内排队执行,执行中会持续推送进度和预览帧,结束时返回落盘在工作区的文件相对路径。',
        ].join(' '),
        namespace: TOOL_NAMESPACE,
        parameters: generateParams,
        outputSchema: generateOutputSchema,
        execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
            const s = sessionFor(ctx);
            const result: JobResult = await s.queue.enqueue(
                { generator: params.generator, params: params.params, output: params.output },
                signal,
                titleOf(params.generator),
                onUpdate,
            );
            return {
                content: [{ type: 'text', text: composeResultText(result) }],
                details: {
                    jobId: result.jobId,
                    generator: params.generator,
                    state: result.state === 'completed' ? 'completed' : result.state,
                    files: result.files,
                    previewCount: 0,
                    error: result.error,
                },
                structuredContent: composeStructured(result, params.generator),
            } as AgentToolResult<GenerateDetails>;
        },
    };

    const listTool: ToolDefinition<typeof emptyParams, ListDetails, unknown> = {
        name: 'comfyui_list_generators',
        label: 'ComfyUI 生成器列表',
        description: '列出当前工作区可用的 ComfyUI 生成器及其参数。',
        namespace: TOOL_NAMESPACE,
        parameters: emptyParams,
        execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
            const { text, details } = await collectGenerators(ctx.cwd);
            if (session) session.generatorCount = details.generators.filter((g) => g.valid).length;
            pi.events.emit(COMFYUI_CHANNEL, {
                kind: 'generators',
                list: details.generators
                    .filter((g) => g.valid)
                    .slice(0, 50)
                    .map((g) => ({ name: g.name, title: g.title ?? g.name })),
            });
            return { content: [{ type: 'text', text }], details } as AgentToolResult<ListDetails>;
        },
    };

    const statusTool: ToolDefinition<typeof emptyParams, StatusDetails, unknown> = {
        name: 'comfyui_status',
        label: 'ComfyUI 状态',
        description: '查看 ComfyUI 队列与 GPU 状态(/queue + /system_stats)。',
        namespace: TOOL_NAMESPACE,
        parameters: emptyParams,
        execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
            const s = sessionFor(ctx);
            const { text, details } = await collectStatus(s.baseUrl);
            return { content: [{ type: 'text', text }], details } as AgentToolResult<StatusDetails>;
        },
    };

    const cancelTool: ToolDefinition<typeof cancelParams, { action: string; target?: string }, unknown> = {
        name: 'comfyui_cancel',
        label: 'ComfyUI 取消',
        description: '取消当前或指定的生成任务;不带参数时 interrupt ComfyUI 正在执行的当前任务。',
        namespace: TOOL_NAMESPACE,
        parameters: cancelParams,
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const s = sessionFor(ctx);
            const outcome: CancelOutcome = await handleCancel(s.queue, s.baseUrl, params.jobId ?? undefined);
            const text =
                outcome.action === 'job-cancelled'
                    ? `已请求取消 ${outcome.target}`
                    : outcome.action === 'global-interrupt'
                      ? '已请求 ComfyUI interrupt(当前任务)'
                      : outcome.action === 'not-found'
                        ? `未找到任务 ${outcome.target}(可能已完成或不在本会话)`
                        : '无任务可取消';
            return { content: [{ type: 'text', text }], details: outcome } as AgentToolResult<{
                action: string;
                target?: string;
            }>;
        },
    };

    // Official pattern: register every tool first, keep optional ones inactive;
    // session_start then pi.setActiveTools(config.tools).
    // Registered individually — a loop over the array confuses ToolDefinition
    // generic inference (union of unrelated param schemas).
    generateTool.defaultActive = false;
    listTool.defaultActive = false;
    statusTool.defaultActive = false;
    cancelTool.defaultActive = false;
    pi.registerTool(generateTool);
    pi.registerTool(listTool);
    pi.registerTool(statusTool);
    pi.registerTool(cancelTool);
};

function titleOf(generator: string): string {
    return generator;
}

export default extension;
