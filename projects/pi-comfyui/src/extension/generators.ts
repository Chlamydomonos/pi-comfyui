import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import type { GeneratorContext, GeneratorPrompt } from './generator-types.js';

/**
 * Generator file loader (docs/10 §4, docs/20).
 *
 * A generator directory (default `<generator_dir>`, see loadGenerators opts)
 * contains flat `*.js` files exporting a default object:
 *   { name?, title?, description?, params: {type:"object",...}, build(ctx) → prompt }
 *
 * Import/require are forbidden (files are data graphs with a build shim);
 * compiled via jiti with mtime caching; pure-JSON-Schema params validated by
 * our own mini validator (typebox Value.Default ignores plain JSON Schema).
 */

export interface LoadedGenerator {
    name: string;
    title?: string;
    description?: string;
    /** The raw `params` JSON Schema object (validated shape). */
    params: Record<string, unknown>;
    /** The `build` function from the file: (params, ctx) → { prompt }. */
    build: (params: Record<string, unknown>, ctx: GeneratorContext) => unknown;
    filePath: string;
    mtimeMs: number;
}

export interface InvalidGeneratorFile {
    file: string;
    error: string;
}

export interface LoadResult {
    generators: LoadedGenerator[];
    invalid: InvalidGeneratorFile[];
}

export function isValidGeneratorName(name: string): boolean {
    return /^[a-z][a-z0-9-]{0,63}$/.test(name);
}

const GENERATOR_FILE = /\.js$/i;
// Statement-level scan: lines *starting* with import/`export import`, or a
// dynamic `import(...)` / `require(...)` call on the right side of an
// assignment. Comments mentioning the word (e.g. 禁止 import) do not match.
const FORBIDDEN_IMPORT = /(^|[\r\n])\s*(import[\s(*"'{`]|export\s+import\b)|=\s*(async\s+)?(require|import)\s*\(/;

/** jiti loader instance — created once per process. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jitiLoader: any | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getJiti(): any {
    if (!jitiLoader) {
        jitiLoader = createJiti(import.meta.url, { cache: false });
    }
    return jitiLoader;
}

const moduleCache = new Map<string, { mtimeMs: number; entry: LoadedGenerator | null }>();

function validateModule(filePath: string, source: string, mod: unknown, fallbackName: string): LoadedGenerator {
    if (!mod || typeof mod !== 'object' || typeof (mod as { default?: unknown }).default !== 'object') {
        throw new Error('缺少 default 导出对象');
    }
    const g = (mod as { default: Record<string, unknown> }).default;
    const declared = typeof g.name === 'string' && g.name !== '' ? g.name : fallbackName;
    if (!isValidGeneratorName(declared)) {
        throw new Error(`name "${declared}" 不合法(须匹配 [a-z][a-z0-9-]{0,63})`);
    }
    if (g.title !== undefined && typeof g.title !== 'string') throw new Error('title 必须是字符串');
    if (g.description !== undefined && typeof g.description !== 'string') throw new Error('description 必须是字符串');
    if (!g.params || typeof g.params !== 'object' || (g.params as { type?: unknown }).type !== 'object') {
        throw new Error('缺 params:{type:"object" schema}');
    }
    if (typeof g.build !== 'function') throw new Error('缺 build(ctx) 函数');
    return {
        name: declared,
        title: g.title as string | undefined,
        description: g.description as string | undefined,
        params: g.params as Record<string, unknown>,
        build: g.build as (params: Record<string, unknown>, ctx: GeneratorContext) => unknown,
        filePath,
        mtimeMs: statSync(filePath).mtimeMs,
    };
}

async function loadGeneratorFile(filePath: string, fallbackName: string): Promise<LoadedGenerator> {
    const stat = statSync(filePath);
    const cached = moduleCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        if (cached.entry === null) throw new Error('生成器文件此前加载失败'); // deterministic rethrow
        return cached.entry;
    }
    const source = readFileSync(filePath, 'utf8');
    if (GENERATOR_FILE.test(filePath) === false) throw new Error('不是 .js 文件');
    if (FORBIDDEN_IMPORT.test(source)) {
        throw new Error('生成器文件禁止 import/require(必须是纯 JSON 生成器)');
    }
    try {
        const mod: unknown = await getJiti().import(filePath);
        const entry = validateModule(filePath, source, mod, fallbackName);
        moduleCache.set(filePath, { mtimeMs: stat.mtimeMs, entry });
        return entry;
    } catch (error) {
        moduleCache.set(filePath, { mtimeMs: stat.mtimeMs, entry: null });
        throw error instanceof Error ? error : new Error(String(error));
    }
}

/**
 * Load all generators from a directory. Cache lives across calls (mtime
 * checks). Files are flat `*.js`; subdirectories ignored.
 */
export async function loadGenerators(generatorDir: string): Promise<LoadResult> {
    const result: LoadResult = { generators: [], invalid: [] };
    let entries: string[];
    try {
        entries = readdirSync(generatorDir, { withFileTypes: true })
            .filter((e) => e.isFile() && GENERATOR_FILE.test(e.name))
            .map((e) => e.name)
            .sort();
    } catch {
        return result; // missing directory → empty
    }
    for (const name of entries) {
        const filePath = join(generatorDir, name);
        try {
            result.generators.push(await loadGeneratorFile(filePath, name.replace(/\.js$/i, '')));
        } catch (error) {
            result.invalid.push({ file: name, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return result;
}

export const GENERATOR_DIR_NAME = 'generators';
/** Default generator directory (docs/10 §4, docs/20 D2): <workspace>/.pi/comfyui/generators */
export function defaultGeneratorDir(workspace: string): string {
    return join(resolve(workspace), '.pi', 'comfyui', GENERATOR_DIR_NAME);
}

/** Guard that `path` is absolute or resolvable relative workspace path for input files. */
export function resolveInputPath(workspace: string, path: string): string {
    if (isAbsolute(path)) return path;
    return join(resolve(workspace), path);
}

/* ------------------------------------------------------------------ */
/* Mini validator for pure-JSON-Schema params (docs/20 §3)            */
/* ------------------------------------------------------------------ */

export interface ValidateResult {
    ok: boolean;
    /** Deep-merged object with defaults applied (when ok). */
    value?: Record<string, unknown>;
    /** Human-readable errors (when not ok). */
    errors?: string[];
}

export type JsonSchema = Record<string, unknown>;

function schemaType(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.find((v) => typeof v === 'string') as string | undefined;
    return undefined;
}

function checkScalar(schema: JsonSchema, value: unknown, path: string, errors: string[]): boolean {
    const type = schemaType(schema.type);
    const enumValues = schema.enum;
    if (Array.isArray(enumValues) && !enumValues.includes(value)) {
        errors.push(`${path}: 枚举值无效(允许 ${enumValues.map((v) => JSON.stringify(v)).join(', ')})`);
        return false;
    }
    if (type === undefined) return true; // unconstrained
    switch (type) {
        case 'string':
            if (typeof value !== 'string') {
                errors.push(`${path}: 需要字符串`);
                return false;
            }
            break;
        case 'number':
            if (typeof value !== 'number' || Number.isNaN(value)) {
                errors.push(`${path}: 需要数字`);
                return false;
            }
            break;
        case 'integer':
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                errors.push(`${path}: 需要整数`);
                return false;
            }
            break;
        case 'boolean':
            if (typeof value !== 'boolean') {
                errors.push(`${path}: 需要布尔值`);
                return false;
            }
            break;
        case 'array':
            if (!Array.isArray(value)) {
                errors.push(`${path}: 需要数组`);
                return false;
            }
            break;
        case 'null':
            if (value !== null) {
                errors.push(`${path}: 需要 null`);
                return false;
            }
            break;
        default:
            // object handled by caller; any other json-schema type is accepted as-is
            break;
    }
    if (typeof value === 'number') {
        const min = schema.minimum;
        if (typeof min === 'number' && value < min) {
            errors.push(`${path}: 最小值 ${min} 得到 ${value}`);
            return false;
        }
        const max = schema.maximum;
        if (typeof max === 'number' && value > max) {
            errors.push(`${path}: 最大值 ${max} 得到 ${value}`);
            return false;
        }
    }
    return true;
}

/**
 * Validate `params` against the generator's JSON Schema (subset: object props,
 * type, enum, minimum/maximum, required, nested one level of object) and
 * deep-merge defaults. Unknown keys pass through (lenient, docs/20 §3.2).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateAndApplyDefaults(schema: JsonSchema, params: unknown): ValidateResult {
    if (!isRecord(schema) || schema.type !== 'object') return { ok: true, value: {} };
    const errors: string[] = [];
    const properties = (schema.properties ?? {}) as JsonSchema;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const raw = isRecord(params) ? params : {};
    const output: Record<string, unknown> = { ...raw };

    for (const key of required) {
        if (raw[key] === undefined) errors.push(`$.${key}: 缺失必填字段`);
    }
    if (errors.length > 0) return { ok: false, errors };

    for (const key of Object.keys(properties)) {
        const propSchema = properties[key];
        const value = raw[key];
        if (value === undefined) {
            if (isRecord(propSchema) && propSchema.default !== undefined) {
                output[key] =
                    typeof propSchema.default === 'object' && propSchema.default !== null
                        ? structuredClone(propSchema.default)
                        : propSchema.default;
            }
            continue;
        }
        if (!isRecord(propSchema)) continue; // unconstrained
        if (propSchema.type === 'object' && isRecord(value)) {
            const nested = validateAndApplyDefaults(
                { ...(propSchema as JsonSchema), properties: (propSchema.properties ?? {}) as JsonSchema },
                value,
            );
            if (!nested.ok) {
                for (const e of nested.errors!) errors.push(`${key}.${e}`);
                continue;
            }
            output[key] = nested.value;
            // re-check nested required handled inside; merge fine
            continue;
        }
        checkScalar(schemaObject(propSchema), value, `$.${key}`, errors);
    }
    return errors.length === 0 ? { ok: true, value: output } : { ok: false, errors };
}

function schemaObject(value: unknown): JsonSchema {
    return isRecord(value) ? (value as JsonSchema) : {};
}

/** Serialize validation errors into one line for tool output. */
export function formatParamsErrors(errors: string[]): string {
    return errors.join('; ');
}
