import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

/**
 * ComfyUI HTTP + WebSocket client (docs/10 §5, docs/40 §4).
 *
 * Fixed per-call HTTP timeouts (independent of config.timeoutMs):
 * submit 30s · /view 120s · /history 10s.
 */

export class ComfyHttpError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, body: string) {
        super(`ComfyUI HTTP ${status}: ${truncate(body, 300)}`);
        this.status = status;
        this.body = body;
        this.name = 'ComfyHttpError';
    }
}

export function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}…(truncated)`;
}

export interface ComfyOutputRef {
    filename: string;
    subfolder?: string;
    type?: string;
}

async function httpJson<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
): Promise<{ status: number; body: T | null; text: string }> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body: T | null = null;
    try {
        body = text ? (JSON.parse(text) as T) : null;
    } catch {
        body = null;
    }
    return { status: response.status, body, text };
}

export interface PromptSubmission {
    promptId: string;
    number: number;
    /** Non-empty means some nodes failed validation — treat as a warning. */
    nodeErrors: NodeErrors;
}

export interface NodeErrors {
    [nodeId: string]: {
        errors: { message: string; details?: string; extra_info?: { input_name?: string } }[];
        class_type?: string;
    };
}

/** POST /prompt — 400 → ComfyHttpError with full node_errors attached via `body`. */
export async function submitPrompt(
    baseUrl: string,
    prompt: unknown,
    clientId: string,
    extraData?: Record<string, unknown>,
): Promise<PromptSubmission> {
    const payload: Record<string, unknown> = { prompt, client_id: clientId };
    if (extraData) payload.extra_data = extraData;
    const { status, body, text } = await httpJson<{
        prompt_id?: string;
        number?: number;
        error?: { type?: string; message?: string; details?: string };
        node_errors?: NodeErrors;
    }>(
        `${baseUrl}/prompt`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
        30_000,
    );
    if (status !== 200 || !body?.prompt_id) {
        const errType = body?.error?.type ? `${body.error.type}: ` : '';
        const errMsg = body?.error?.message ?? text;
        throw new ComfyHttpError(
            status,
            `提交失败(${status}) ${errType}${errMsg}${body?.node_errors ? ` | node_errors ${JSON.stringify(body.node_errors)}` : ''}`,
        );
    }
    return {
        promptId: body.prompt_id,
        number: body.number ?? 0,
        nodeErrors: body.node_errors ?? {},
    };
}

/** GET /view → raw bytes of one output file. */
export async function viewFile(baseUrl: string, ref: ComfyOutputRef): Promise<Uint8Array> {
    const u = new URL(`${baseUrl}/view`);
    u.searchParams.set('filename', ref.filename);
    if (ref.subfolder) u.searchParams.set('subfolder', ref.subfolder);
    if (ref.type) u.searchParams.set('type', ref.type);
    const response = await fetch(u, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new ComfyHttpError(response.status, `下载 ${ref.filename} 失败`);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
}

export interface HistoryEntry {
    outputs: Record<string, Record<string, unknown>>;
    status?: { completed?: boolean; status_obj?: { completed?: boolean; status_str?: string } };
}

/** GET /history/{promptId} → single entry or null (not found / not yet present). */
export async function fetchHistory(baseUrl: string, promptId: string): Promise<HistoryEntry | null> {
    const { status, body } = await httpJson<Record<string, HistoryEntry>>(
        `${baseUrl}/history/${encodeURIComponent(promptId)}`,
        { method: 'GET' },
        10_000,
    );
    if (status !== 200 || !body) return null;
    const entry = body[promptId];
    return entry ?? null;
}

export interface QueuePayload {
    queue_running?: unknown[];
    queue_pending?: unknown[];
}

export interface SystemStats {
    system?: { os?: string; comfyui_version?: string; python_version?: string; pytorch_version?: string };
    devices?: {
        name?: string;
        type?: string;
        index?: number;
        vram_total?: number;
        vram_free?: number;
        torch_vram_free?: number;
    }[];
}

/** GET /queue and /system_stats for the status tool. */
export async function fetchQueueAndStats(
    baseUrl: string,
): Promise<{ queue: QueuePayload | null; stats: SystemStats | null }> {
    const [{ body: queue }, { body: stats }] = await Promise.all([
        httpJson<QueuePayload>(`${baseUrl}/queue`, { method: 'GET' }, 10_000),
        httpJson<SystemStats>(`${baseUrl}/system_stats`, { method: 'GET' }, 10_000),
    ]);
    return { queue, stats };
}

export function comfyWsUrl(baseUrl: string, clientId: string): string {
    const url = new URL(baseUrl);
    const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${url.host}/ws?clientId=${encodeURIComponent(clientId)}`;
}

export interface PreviewImage {
    mime: 'image/jpeg' | 'image/png';
    data: Uint8Array;
}

/** ComfyUI WS text events we care about (docs/40 §4.2). */
export interface ComfyWsEvent {
    type: string;
    data: Record<string, unknown>;
}

/**
 * WebSocket connection with one-shot reconnect (3s backoff). The first text
 * message we send is `feature_flags` (docs/40 §4.1: connect BEFORE POST
 * /prompt and reply to the flag negotiation).
 */
export class ComfyWsClient {
    readonly clientId: string;
    private ws: WebSocket | null = null;
    private closed = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private usedReconnect = false;

    onJson: (event: ComfyWsEvent) => void = () => {};
    onBinary: (image: PreviewImage) => void = () => {};
    onOpen: () => void = () => {};
    /** Called when the socket gives up for good (either connect or post-reconnect). */
    onDone: () => void = () => {};

    constructor(private readonly url: string) {
        this.clientId = randomUUID();
    }

    start(): void {
        this.connect();
    }

    get alive(): boolean {
        return this.ws !== null && this.ws.readyState === 1; // WebSocket.OPEN
    }

    private connect(): void {
        if (this.closed) return;
        const ws = new WebSocket(this.url);
        try {
            this.ws = ws;
        } catch (error) {
            console.error('comfyui: ws setup failed', error);
            this.onDone();
            return;
        }
        ws.on('open', () => {
            // ComfyUI negotiates capabilities via this message (docs/40 §4.1).
            ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
            this.onOpen();
        });
        ws.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
                const image = parseBinaryFrame(data);
                if (image) this.onBinary(image);
                return;
            }
            try {
                const parsed = JSON.parse(data.toString('utf8')) as ComfyWsEvent;
                if (parsed && typeof parsed.type === 'string') {
                    this.onJson({ type: parsed.type, data: parsed.data ?? {} });
                }
            } catch {
                /* ignore malformed text frames */
            }
        });
        ws.on('error', () => {}); // errors are surfaced via close
        ws.on('close', () => this.handleClose());
    }

    private handleClose(): void {
        this.ws = null;
        if (this.closed) {
            this.onDone();
            return;
        }
        if (!this.usedReconnect) {
            this.usedReconnect = true;
            this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
            return;
        }
        this.onDone();
    }

    close(): void {
        this.closed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const ws = this.ws;
        this.ws = null;
        if (ws && ws.readyState !== 3) ws.close(1000);
    }
}

/** [4B event_type][payload] — type 1: [4B mime][img], type 4: [4B metaLen][meta JSON][img]. */
export function parseBinaryFrame(buffer: Buffer): PreviewImage | null {
    if (buffer.length < 8) return null;
    const eventType = buffer.readUInt32BE(0);
    if (eventType === 1) {
        const typeNum = buffer.readUInt32BE(4);
        const mime = typeNum === 2 ? 'image/png' : 'image/jpeg';
        return { mime, data: buffer.subarray(8) };
    }
    if (eventType === 4) {
        const metaLen = buffer.readUInt32BE(4);
        if (8 + metaLen > buffer.length) return null;
        let mime: 'image/jpeg' | 'image/png' = 'image/jpeg';
        try {
            const meta = JSON.parse(buffer.subarray(8, 8 + metaLen).toString('utf8')) as { image_type?: string };
            if (meta.image_type === 'png') mime = 'image/png';
        } catch {
            /* default jpeg */
        }
        return { mime, data: buffer.subarray(8 + metaLen) };
    }
    return null;
}

/** POST /interrupt with no prompt_id → interrupt ComfyUI's currently-running prompt. */
export async function globalInterrupt(baseUrl: string): Promise<void> {
    await fetch(`${baseUrl}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
}
