import { createHash } from 'node:crypto';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    truncateSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
    PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
    type PiWebHostPiSessionConnection,
    type PiWebHostPiSessionEventsV1,
    type PiWebServerPlugin,
    type ProjectInput,
    type ServerPluginActivation,
    type ServerPluginActivationContext,
    type ServerPluginPeerChannel,
    type ServerPluginPeerChannelOpenContext,
    type ServerPluginPeerRequestContext,
} from '@jmfederico/pi-web/server-plugin-api';
import {
    COMFYUI_CHANNEL,
    type BrowserFrame,
    type ComfyJobRecord,
    type ComfyJobState,
    type ComfySummary,
    type ExtensionFrame,
} from '../../shared/protocol.js';

/* ------------------------------------------------------------------ */
/*  Json helpers                                                       */
/* ------------------------------------------------------------------ */

type JsonValue = Parameters<ServerPluginPeerChannelOpenContext['send']>[0];

function toJson<T>(value: T): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sha12(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ */
/*  Per-workspace in-memory store + jsonl persistence                  */
/* ------------------------------------------------------------------ */

interface WorkspaceStore {
    records: Map<string, ComfyJobRecord>;
    /** State snapshot per job, to decide when a jsonl line is worth writing. */
    persistedState: Map<string, string>;
    lastProgress: Map<string, { value: number; max: number }>;
    lastPhase: Map<string, string>;
    generatorCount?: number;
}

interface WorkspaceRef {
    projectPath: string;
    workspacePath: string;
}

const MAX_LIST = 200;
const HISTORY_TAIL_DEFAULT = 50;
const ROTATE_BYTES = 2_097_152; // 2 MB
const ROTATE_KEEP_RATIO = 0.5;

function storeKey(ref: WorkspaceRef): string {
    return `${sha12(ref.projectPath)}|${sha12(ref.workspacePath)}`;
}

function recordFile(jobsDir: string, ref: WorkspaceRef): string {
    return join(jobsDir, sha12(ref.projectPath), `${sha12(ref.workspacePath)}.jsonl`);
}

function isTerminalState(state: ComfyJobState): boolean {
    return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function compareRecordsDesc(a: ComfyJobRecord, b: ComfyJobRecord): number {
    const at = a.endedAt ?? a.startedAt ?? '';
    const bt = b.endedAt ?? b.startedAt ?? '';
    if (at !== bt) return at < bt ? 1 : -1;
    return a.jobId < b.jobId ? 1 : -1;
}

function sortRecords(records: Iterable<ComfyJobRecord>): ComfyJobRecord[] {
    return [...records].sort(compareRecordsDesc);
}

/** docs/10 §4: job records flow server-side and persist per project+workspace. */
function createComfyStore(): WorkspaceStore {
    return {
        records: new Map(),
        persistedState: new Map(),
        lastProgress: new Map(),
        lastPhase: new Map(),
    };
}

/* ------------------------------------------------------------------ */
/*  Server plugin                                                      */
/* ------------------------------------------------------------------ */

export const comfyuiServerPlugin: PiWebServerPlugin = {
    apiVersion: 3,
    name: 'ComfyUI',
    requires: [PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],

    activate(context: ServerPluginActivationContext): ServerPluginActivation {
        const { dataDirectory, logger, lifetimeSignal } = context;
        const jobsDir = join(dataDirectory, 'jobs');
        mkdirSync(jobsDir, { recursive: true });

        const stores = new Map<string, WorkspaceStore>();
        /** sessionKey → connection (shared across channels of the same session). */
        const connections = new Map<string, PiWebHostPiSessionConnection>();
        const unsubscribers = new Map<string, () => void>();
        /** Per-channel live fanout subscriptions; cleaned up on channel close. */
        const liveUnsubs = new Set<() => void>();
        let eventsV1: PiWebHostPiSessionEventsV1 | null = null;
        let disposed = false;

        /* ---------------- store plumbing ---------------- */

        function getStore(ref: WorkspaceRef): WorkspaceStore {
            const key = storeKey(ref);
            let store = stores.get(key);
            if (!store) {
                store = createComfyStore();
                stores.set(key, store);
                hydrate(store, recordFile(jobsDir, ref));
            }
            return store;
        }

        function hydrate(store: WorkspaceStore, filePath: string): void {
            if (!existsSync(filePath)) return;
            try {
                const lines = readFileSync(filePath, 'utf8').split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const record = JSON.parse(line) as ComfyJobRecord;
                        if (typeof record?.jobId === 'string') store.records.set(record.jobId, record);
                    } catch {
                        /* skip malformed line */
                    }
                }
            } catch (error) {
                logger.warn('comfyui: 历史记录文件读取失败', { error: String(error) });
            }
        }

        function persistRecord(store: WorkspaceStore, ref: WorkspaceRef, record: ComfyJobRecord): void {
            const marker = `${record.state}|${record.endedAt ?? ''}|${record.files.length}|${record.error ?? ''}`;
            if (store.persistedState.get(record.jobId) === marker) return;
            store.persistedState.set(record.jobId, marker);
            const filePath = recordFile(jobsDir, ref);
            try {
                mkdirSync(dirname(filePath), { recursive: true });
                appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
                rotateIfNeeded(filePath);
            } catch (error) {
                logger.warn('comfyui: 任务记录写盘失败', { error: String(error) });
            }
        }

        function rotateIfNeeded(filePath: string): void {
            let size = 0;
            try {
                size = statSync(filePath).size;
            } catch {
                return;
            }
            if (size <= ROTATE_BYTES) return;
            const lines = readFileSync(filePath, 'utf8')
                .split('\n')
                .filter((l) => l.trim());
            const keep = lines.slice(Math.floor(lines.length * ROTATE_KEEP_RATIO));
            const tmp = `${filePath}.tmp`;
            try {
                writeFileSync(tmp, `${keep.join('\n')}\n`, 'utf8');
                renameSync(tmp, filePath);
                logger.info('comfyui: 任务记录已滚动', { kept: keep.length });
            } catch (error) {
                logger.warn('comfyui: 任务记录滚动失败', { error: String(error) });
            }
        }

        /** Update store state from one extension frame; returns true if persisted. */
        function applyFrameToStore(ref: WorkspaceRef, frame: ExtensionFrame): boolean {
            const store = getStore(ref);
            if (frame.kind === 'job') {
                const prev = store.records.get(frame.jobId);
                const record: ComfyJobRecord = {
                    jobId: frame.jobId,
                    generator: frame.generator,
                    state: frame.state,
                    startedAt: frame.startedAt ?? prev?.startedAt,
                    endedAt: frame.endedAt,
                    error: frame.error,
                    promptId: frame.promptId ?? prev?.promptId,
                    files: prev?.files ?? [],
                    ...(frame.title ? { title: frame.title } : prev?.title ? { title: prev.title } : {}),
                };
                if (frame.phase && !isTerminalState(frame.state)) store.lastPhase.set(frame.jobId, frame.phase);
                if (isTerminalState(frame.state)) {
                    const prevPhase = store.lastPhase.get(frame.jobId);
                    if (prevPhase && frame.state === 'failed') record.error = record.error ?? prevPhase;
                    store.lastProgress.delete(frame.jobId);
                }
                store.records.set(frame.jobId, record);
                persistRecord(store, ref, record);
                trimRecords(store, MAX_LIST * 2);
                return true;
            }
            if (frame.kind === 'progress') {
                store.lastProgress.set(frame.jobId, { value: frame.value, max: frame.max });
                return false;
            }
            if (frame.kind === 'outputs') {
                const record = store.records.get(frame.jobId);
                if (record) {
                    record.files = frame.files;
                    store.records.set(frame.jobId, record);
                    persistRecord(store, ref, record);
                    return true;
                }
                return false;
            }
            if (frame.kind === 'generators') {
                store.generatorCount = frame.list.length;
                return false;
            }
            // preview frames are not persisted
            return false;
        }

        function trimRecords(store: WorkspaceStore, max: number): void {
            if (store.records.size <= max) return;
            const ordered = sortRecords(store.records.values());
            store.records.clear();
            for (const record of ordered.slice(0, max)) store.records.set(record.jobId, record);
        }

        function summaryOf(store: WorkspaceStore): ComfySummary {
            const records = sortRecords(store.records.values());
            const active = records.find((r) => r.state === 'running' || r.state === 'queued') ?? undefined;
            const progress = active ? store.lastProgress.get(active.jobId) : undefined;
            const summary: ComfySummary = {
                queueLen: active ? 1 : 0,
                generatorCount: store.generatorCount,
            };
            if (active) {
                summary.active = {
                    jobId: active.jobId,
                    generator: active.generator,
                    state: active.state,
                    phase: store.lastPhase.get(active.jobId),
                    value: progress?.value,
                    max: progress?.max,
                };
            }
            return summary;
        }

        /* ---------------- pi-session events ---------------- */

        async function connectSession(
            project: ProjectInput,
            workspaceId: string,
            sessionId: string,
        ): Promise<PiWebHostPiSessionConnection> {
            const key = `${project.id}/${workspaceId}/${sessionId}`;
            const existing = connections.get(key);
            if (existing) return existing;
            if (!eventsV1) throw new Error('插件尚未完成启动,无法连接会话事件');
            const connection = await eventsV1.connect({ projectId: project.id, workspaceId, sessionId });
            connections.set(key, connection);
            const signal = connection.signal;
            const onAbort = () => {
                connections.delete(key);
                const unsub = unsubscribers.get(key);
                if (unsub) {
                    unsub();
                    unsubscribers.delete(key);
                }
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
            return connection;
        }

        /** Subscribe once per session; frames feed every open live channel + the store. */
        function ensureSessionSubscription(
            project: ProjectInput,
            workspaceId: string,
            workspacePath: string,
            sessionId: string,
        ): void {
            const key = `${project.id}/${workspaceId}/${sessionId}`;
            if (unsubscribers.has(key)) return;
            const ref: WorkspaceRef = { projectPath: project.path, workspacePath };
            const handler = (data: unknown) => {
                try {
                    applyFrameToStore(ref, data as ExtensionFrame);
                } catch (error) {
                    logger.warn('comfyui: 帧处理失败', { error: String(error) });
                }
            };
            void connectSession(project, workspaceId, sessionId)
                .then((connection) => {
                    const unsub = connection.on(COMFYUI_CHANNEL, handler);
                    unsubscribers.set(key, () => {
                        unsub();
                    });
                })
                .catch((error) => {
                    logger.warn('comfyui: 会话事件订阅失败', { sessionId, error: String(error) });
                });
        }

        /* ---------------- lifecycle ---------------- */

        const activation: ServerPluginActivation = {
            start({ capabilities }) {
                eventsV1 = capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
                logger.info('comfyui: 服务端插件已启动', { pluginId: context.pluginId });
            },

            peer: {
                request: async (rc: ServerPluginPeerRequestContext): Promise<JsonValue> => {
                    const ref: WorkspaceRef = { projectPath: rc.project.path, workspacePath: rc.workspace.path };
                    try {
                        if (rc.operation === 'summary') {
                            return toJson(summaryOf(getStore(ref)));
                        }
                        if (rc.operation === 'list') {
                            const store = getStore(ref);
                            const input = (rc.input ?? {}) as { limit?: number };
                            let limit =
                                typeof input.limit === 'number' && Number.isFinite(input.limit)
                                    ? Math.floor(input.limit)
                                    : HISTORY_TAIL_DEFAULT;
                            if (limit < 1) limit = 1;
                            if (limit > MAX_LIST) limit = MAX_LIST;
                            return toJson(sortRecords(store.records.values()).slice(0, limit));
                        }
                        if (rc.operation === 'cancel') {
                            const input = (rc.input ?? {}) as { jobId?: string; sessionId?: string };
                            const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
                            if (!sessionId) return toJson({ ok: false, error: '需要当前会话 ID 才能发送取消命令' });
                            const connection = await connectSession(rc.project, rc.workspace.id, sessionId);
                            const frame: BrowserFrame = {
                                kind: 'cmd',
                                action: 'cancel',
                                ...(input.jobId ? { jobId: input.jobId } : {}),
                            };
                            connection.emit(COMFYUI_CHANNEL, frame);
                            return toJson({ ok: true });
                        }
                        if (rc.operation === 'history-clear') {
                            const store = getStore(ref);
                            store.records.clear();
                            store.persistedState.clear();
                            store.lastProgress.clear();
                            store.lastPhase.clear();
                            store.generatorCount = undefined;
                            const filePath = recordFile(jobsDir, ref);
                            try {
                                truncateSync(filePath, 0);
                            } catch {
                                /* file may not exist */
                            }
                            return toJson({ ok: true });
                        }
                        return toJson({ ok: false, error: `未知操作:${rc.operation}` });
                    } catch (error) {
                        return toJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
                    }
                },

                openChannel: (ctx): MaybePromiseChannel => {
                    const ref: WorkspaceRef = { projectPath: ctx.project.path, workspacePath: ctx.workspace.path };
                    const input = (ctx.input ?? {}) as { sessionId?: string };
                    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';

                    return (async (): Promise<ServerPluginPeerChannel> => {
                        let unsubscribe: (() => void) | null = null;
                        if (sessionId) {
                            ensureSessionSubscription(ctx.project, ctx.workspace.id, ctx.workspace.path, sessionId);
                            try {
                                const connection = await connectSession(ctx.project, ctx.workspace.id, sessionId);
                                // Re-broadcast live frames to this browser channel.
                                unsubscribe = connection.on(COMFYUI_CHANNEL, (data: unknown) => {
                                    try {
                                        ctx.send(toJson(data));
                                    } catch {
                                        /* host queue overflow closes the channel */
                                    }
                                });
                                liveUnsubs.add(unsubscribe);
                            } catch (error) {
                                try {
                                    ctx.send(
                                        toJson({
                                            kind: 'error',
                                            message: `无法订阅会话事件:${error instanceof Error ? error.message : String(error)}`,
                                        }),
                                    );
                                } catch {
                                    /* channel may already be closed */
                                }
                            }
                        }
                        // Seed with recent history regardless of live subscription.
                        try {
                            ctx.send(
                                toJson({
                                    kind: 'history',
                                    records: sortRecords(getStore(ref).records.values()).slice(0, HISTORY_TAIL_DEFAULT),
                                }),
                            );
                        } catch {
                            /* channel may already be closed */
                        }
                        const channelUnsub = unsubscribe;
                        const channel: ServerPluginPeerChannel = {
                            receive(data, _signal) {
                                // Browser frames arrive over peer.request; unknown frames are ignored.
                                logger.debug('comfyui: 忽略浏览器帧', { data: toJson(data) });
                            },
                            close() {
                                if (channelUnsub) {
                                    liveUnsubs.delete(channelUnsub);
                                    channelUnsub();
                                }
                            },
                        };
                        return channel;
                    })();
                },
            },

            async dispose(signal) {
                if (disposed) return;
                disposed = true;
                void signal;
                for (const unsub of unsubscribers.values()) {
                    try {
                        unsub();
                    } catch {
                        /* already gone */
                    }
                }
                unsubscribers.clear();
                for (const unsub of liveUnsubs) {
                    try {
                        unsub();
                    } catch {
                        /* already gone */
                    }
                }
                liveUnsubs.clear();
                for (const connection of connections.values()) {
                    try {
                        connection.close();
                    } catch {
                        /* already gone */
                    }
                }
                connections.clear();
                logger.info('comfyui: 服务端插件已释放');
            },

            health() {
                return { status: 'healthy' as const, message: 'ComfyUI 任务历史与实时帧通道就绪' };
            },
        };

        if (lifetimeSignal.aborted) void activation.dispose?.(lifetimeSignal);
        else lifetimeSignal.addEventListener('abort', () => void activation.dispose?.(lifetimeSignal), { once: true });

        return activation;
    },
};

type MaybePromiseChannel = ServerPluginPeerChannel | Promise<ServerPluginPeerChannel>;

export default comfyuiServerPlugin;
