import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { viewFile, type ComfyOutputRef, type HistoryEntry } from './comfy-client.js';
import type { ComfyFileRef } from '../shared/protocol.js';

export interface HarvestedFile {
    node: string;
    key: string;
    index: number;
    ref: ComfyOutputRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten a /history entry into output file references (docs/40 §5): any key
 * whose value is an array of objects with a `filename` string; only entries
 * with type === "output"; sorted by node id (string asc) → key → index.
 */
export function collectOutputRefs(history: HistoryEntry): HarvestedFile[] {
    const nodeIds = Object.keys(history.outputs ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const files: HarvestedFile[] = [];
    for (const nodeId of nodeIds) {
        const nodeOutputs = history.outputs[nodeId]!;
        for (const key of Object.keys(nodeOutputs).sort()) {
            const value = nodeOutputs[key];
            if (!Array.isArray(value)) continue;
            value.forEach((item, index) => {
                if (!isRecord(item)) return;
                const { filename, subfolder, type } = item as Record<string, unknown>;
                if (typeof filename !== 'string' || filename === '') return;
                if (type !== 'output') return;
                files.push({
                    node: nodeId,
                    key,
                    index,
                    ref: {
                        filename,
                        subfolder: typeof subfolder === 'string' ? subfolder : undefined,
                        type: typeof type === 'string' ? type : undefined,
                    },
                });
            });
        }
    }
    return files;
}

const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.json': 'application/json',
};

export function inferMime(filename: string): string {
    return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve `dir` against `cwd` and reject anything that escapes the workspace
 * (relative `..` climbs and absolute paths outside cwd both return null).
 */
export function safeResolveDir(cwd: string, dir: string): string | null {
    const resolved = resolve(cwd, dir);
    const root = resolve(cwd);
    if (resolved === root) return null;
    if (!resolved.startsWith(root + (root.endsWith(sep) ? '' : sep))) return null;
    return resolved;
}

/** base.ext → base-2.ext → base-3.ext …, collision-free on disk. */
export function uniqueOutputPath(dir: string, base: string, ext: string): string {
    let candidate = join(dir, `${base}${ext}`);
    let n = 2;
    while (existsSync(candidate)) {
        candidate = join(dir, `${base}-${n}${ext}`);
        n += 1;
    }
    return candidate;
}

/**
 * Download one output ref and write it into the workspace (docs/10 §3 step 7,
 * docs/20 D6). `nameOverride` renames: single file keeps the name, extra files
 * get -2/-3 suffixes; without override the original basename is kept.
 */
export async function downloadAndSave(
    baseUrl: string,
    cwd: string,
    harvested: HarvestedFile,
    outDirAbs: string,
    nameOverride: string | undefined,
    ordinal: number,
): Promise<ComfyFileRef> {
    const bytes = await viewFile(baseUrl, harvested.ref);
    const srcExt = extname(harvested.ref.filename).toLowerCase() || '.bin';
    let base: string;
    let ext = srcExt;
    if (nameOverride) {
        base = basename(nameOverride);
        const overrideExt = extname(base).toLowerCase();
        if (overrideExt) {
            base = basename(base, overrideExt); // strip a given extension; source ext wins
        }
        const suffix = ordinal > 0 ? `-${ordinal + 1}` : '';
        base = `${base}${suffix}`;
    } else {
        base = basename(harvested.ref.filename, extname(harvested.ref.filename));
    }
    const target = uniqueOutputPath(outDirAbs, base, ext);
    mkdirSync(outDirAbs, { recursive: true });
    writeFileSync(target, bytes);
    return {
        path: relative(cwd, target).split(sep).join('/'),
        size: bytes.byteLength,
        mime: inferMime(target),
        subfolder: harvested.ref.subfolder,
        type: harvested.ref.type,
    };
}

/** Guard against path traversal in `output.name`/`output.dir` (no separators/.. inside name). */
export function sanitizeNameComponent(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === '.' || trimmed === '..') return null;
    if (trimmed.includes('/') || trimmed.includes('\\')) return null;
    if (isAbsolute(trimmed)) return null;
    return trimmed;
}
