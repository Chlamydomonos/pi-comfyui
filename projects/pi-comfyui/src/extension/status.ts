import { fetchQueueAndStats, type QueuePayload, type SystemStats } from './comfy-client.js';

export interface StatusDetails {
    queueRunning: number;
    queuePending: number;
    devices: { name?: string; type?: string; vramFree?: number; vramTotal?: number }[];
    server?: string;
}

function fmtBytes(bytes: number | undefined): string | undefined {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** comfyui_status: /queue + /system_stats snapshot. */
export async function collectStatus(baseUrl: string): Promise<{ text: string; details: StatusDetails }> {
    const { queue, stats } = await fetchQueueAndStats(baseUrl);
    if (queue === null && stats === null) {
        throw new Error(`ComfyUI 无响应(${baseUrl}/queue、/system_stats 均失败)`);
    }
    const running = countEntries(queue?.queue_running);
    const pending = countEntries(queue?.queue_pending);
    const devices = (stats?.devices ?? []).map((d) => ({
        name: d.name,
        type: d.type,
        vramFree: d.vram_free ?? d.torch_vram_free,
        vramTotal: d.vram_total,
    }));
    const details: StatusDetails = {
        queueRunning: running,
        queuePending: pending,
        devices,
        server: stats?.system?.comfyui_version,
    };
    const parts: string[] = [`队列:执行 ${running} · 等待 ${pending}`];
    if (details.server) parts.push(`ComfyUI v${details.server}`);
    for (const d of devices) {
        const free = fmtBytes(d.vramFree);
        const total = fmtBytes(d.vramTotal);
        if (d.name)
            parts.push(
                `GPU ${d.name}${d.type ? `(${d.type})` : ''}${free ? ` — VRAM 空${free}${total ? ` / 共 ${total}` : ''}` : ''}`,
            );
    }
    return { text: parts.join('\n'), details };
}

function countEntries(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}
