import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ComfyConfig {
    baseUrl: string;
    timeoutMs: number;
    outputDir: string;
    previewMaxSize: number;
    previewIntervalMs: number;
    previewBytes: number;
    tools: string[];
    maxQueue: number;
}

export const DEFAULT_CONFIG: ComfyConfig = {
    baseUrl: 'http://127.0.0.1:4100',
    timeoutMs: 900_000,
    outputDir: 'comfyui-output',
    previewMaxSize: 512,
    previewIntervalMs: 800,
    previewBytes: 196_608,
    tools: ['generate', 'list'],
    maxQueue: 2,
};

export const ALL_TOOL_NAMES = ['generate', 'list', 'status', 'cancel'] as const;

type Warn = (message: string) => void;

/** Cached raw JSON per file path. `value: null` means "bad file, cached as failed". */
interface CacheEntry {
    mtimeMs: number;
    value: unknown | null;
}

const cache = new Map<string, CacheEntry>();

function readJsonFile(path: string, warn: Warn): unknown | null {
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(path).mtimeMs;
    } catch {
        return null; // missing file — not an error
    }
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    let value: unknown | null = null;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        warn(`comfyui 配置解析失败 (${path}): ${error instanceof Error ? error.message : String(error)}`);
        value = null;
    }
    cache.set(path, { mtimeMs, value });
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown, key: string, warn: Warn, min: number, max: number): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        warn(`comfyui 配置键 ${key} 无效(${value}),已忽略`);
        return undefined;
    }
    return value;
}

function asString(value: unknown, key: string, warn: Warn): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
        warn(`comfyui 配置键 ${key} 无效(${JSON.stringify(value)}),已忽略`);
        return undefined;
    }
    return value;
}

/**
 * Two-level config: global `~/.pi/agent/comfyui.json`, then workspace
 * `<cwd>/.pi/comfyui.json`. Shallow merge; unknown/mis-typed keys warn+skip.
 * Both layers are mtime-cached (docs/10 §2).
 */
export function loadConfig(cwd: string, warn: Warn, homeDir: string = homedir()): ComfyConfig {
    const globalFile = join(homeDir, '.pi', 'agent', 'comfyui.json');
    const workspaceFile = join(cwd, '.pi', 'comfyui.json');

    let merged: Record<string, unknown> = {};
    for (const file of [globalFile, workspaceFile]) {
        const raw = readJsonFile(file, warn);
        if (raw === null) continue;
        if (!isRecord(raw)) {
            warn(`comfyui 配置文件必须是对象 (${file}),已忽略`);
            continue;
        }
        merged = { ...merged, ...raw };
    }

    const cfg: ComfyConfig = { ...DEFAULT_CONFIG };

    const baseUrl = asString(merged.baseUrl, 'baseUrl', warn);
    if (baseUrl) {
        try {
            void new URL(baseUrl);
            cfg.baseUrl = baseUrl;
        } catch {
            warn(`comfyui 配置键 baseUrl 不是合法 URL(${baseUrl}),已忽略`);
        }
    }

    const num = (key: keyof ComfyConfig & string) => {
        const v = asPositiveInt(merged[key], key, warn, 1, Number.MAX_SAFE_INTEGER);
        if (v !== undefined) (cfg as unknown as Record<string, unknown>)[key] = v;
    };
    num('timeoutMs');
    num('previewMaxSize');
    num('previewIntervalMs');
    num('previewBytes');

    const maxQueue = asPositiveInt(merged.maxQueue, 'maxQueue', warn, 1, 16);
    if (maxQueue !== undefined) cfg.maxQueue = maxQueue;

    const outputDir = asString(merged.outputDir, 'outputDir', warn);
    if (outputDir) cfg.outputDir = outputDir;

    if (merged.tools !== undefined) {
        if (!Array.isArray(merged.tools) || merged.tools.some((t) => typeof t !== 'string')) {
            warn(`comfyui 配置键 tools 必须是字符串数组,已忽略`);
        } else {
            const allowed = merged.tools.filter((t): t is (typeof ALL_TOOL_NAMES)[number] =>
                (ALL_TOOL_NAMES as readonly string[]).includes(t as string),
            );
            if (allowed.length === 0) {
                warn(`comfyui 配置键 tools 没有有效条目,使用默认值`);
            } else {
                cfg.tools = [...new Set(allowed)];
            }
        }
    }

    return cfg;
}

export function normalizeBaseUrl(baseUrl: string): { host: string; url: URL } {
    const url = new URL(baseUrl);
    url.hash = '';
    url.search = '';
    url.pathname = '';
    return { url, host: url.origin }; // ws://host/ws and http://host/... build from this
}
