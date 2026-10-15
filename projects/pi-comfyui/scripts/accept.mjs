// scripts/accept.mjs — live acceptance against a running ComfyUI (docs/50 §4).
// Usage: node scripts/accept.mjs [workspace=/root/pi-comfyui-accept] [baseUrl=http://127.0.0.1:4100]
//
// Covers: status · list_generators · real txt2img (submit/WS track/preview/harvest/save)
//         · img2img (ctx.resolvePath path-loading node) · session cancel · queue overflow
//         · error paths (unknown generator / bad params / output.dir escape).
import { createJiti } from 'jiti';
import { cpSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const wsRoot = process.argv[2] ?? '/root/pi-comfyui-accept';
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:4100';
const jiti = createJiti(import.meta.url);

const listMod = await jiti.import(join(packageRoot, 'src/extension/list.ts'));
const statusMod = await jiti.import(join(packageRoot, 'src/extension/status.ts'));
const generateMod = await jiti.import(join(packageRoot, 'src/extension/generate.ts'));

let failures = 0;
const check = (name, ok, detail = '') => {
    if (ok) console.log(`  ok ${name}`);
    else {
        failures += 1;
        console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- prepare acceptance workspace ---------- */
const genDir = join(wsRoot, '.pi', 'comfyui', 'generators');
mkdirSync(genDir, { recursive: true });
cpSync(join(packageRoot, 'examples', 'generators'), genDir, { recursive: true, force: true });
console.log(`workspace: ${wsRoot}\nbaseUrl:   ${baseUrl}\n`);

/* ---------- deps + queue ---------- */
const previewCount = { n: 0 };
const frames = [];
const deps = {
    baseUrl,
    timeoutMs: 600_000,
    outputDir: 'comfyui-output',
    previewMaxSize: 512,
    previewIntervalMs: 300,
    previewBytes: 1_200_000,
    workspace: wsRoot,
    emitFrame(frame) {
        frames.push(frame);
        if (frame.kind === 'preview') {
            previewCount.n += 1;
            return;
        }
        const bits = [
            frame.kind,
            frame.state ?? frame.action ?? frame.message ?? '',
            frame.phase ?? frame.generator ?? '',
        ];
        console.log(`  [frame] ${bits.filter(Boolean).join(' ')}`);
    },
    warn: (m) => console.log(`  [warn] ${m}`),
};
const queue = new generateMod.SessionQueue(2, deps);

/* ---------- 1. status ---------- */
console.log('─ status');
try {
    const st = await statusMod.collectStatus(baseUrl);
    console.log(`  ${st.text}`);
    check('status devices present', Array.isArray(st.details.devices) && st.details.devices.length > 0);
} catch (error) {
    check('status reachable', false, String(error));
}

/* ---------- 2. list_generators ---------- */
console.log('─ list_generators');
const ls = await listMod.collectGenerators(wsRoot);
console.log(
    ls.text
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
);
check(
    'two valid generators',
    ls.details.generators.length === 2 && ls.details.generators.every((g) => g.valid),
    JSON.stringify(ls.details.generators.map((g) => `${g.name}:${g.valid}`)),
);

/* ---------- 3. real txt2img ---------- */
console.log('─ generate: txt2img-sdxl (defaults + output.name)');
const t0 = Date.now();
const r1 = await queue.enqueue(
    {
        generator: 'txt2img-sdxl',
        params: {
            prompt: 'masterpiece, best quality, a cute cat astronaut floating in space, earth below, starry sky',
        },
        output: { name: 'accept-cat' },
    },
    undefined,
    '猫宇航员',
    (u) => {
        const d = u.details;
        if (d.state === 'running' && d.value === undefined) return; // phase spam → skip
        console.log(
            `  [update] ${d.state} ${d.phase ?? ''} ${d.value !== undefined ? `${d.value}/${d.max ?? '?'}` : ''}`,
        );
    },
);
console.log(
    `  ${generateMod.composeResultText(r1).split('\n').join('\n  ')}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
check('txt2img completed', r1.state === 'completed', JSON.stringify({ state: r1.state, error: r1.error }));
check(
    'txt2img files saved on disk',
    r1.files.length > 0 &&
        r1.files.every((f) => {
            try {
                return statSync(join(wsRoot, f.path)).size > 0;
            } catch {
                return false;
            }
        }),
    JSON.stringify(r1.files),
);
check(
    'terminal job frame emitted',
    frames.some((f) => f.kind === 'job' && f.state === 'completed'),
);
check(
    'outputs frame emitted',
    frames.some((f) => f.kind === 'outputs' && Array.isArray(f.files)),
);
check(
    'progress pushed via onUpdate',
    previewCount.n > 0 || frames.some((f) => f.kind === 'progress'),
    `preview frames: ${previewCount.n}`,
);

/* ---------- 4. img2img (path-loading node, feeds on previous output) ---------- */
if (r1.state === 'completed' && r1.files.length > 0) {
    console.log('─ generate: img2img-sdxl (input = previous output)');
    const r2 = await queue.enqueue(
        {
            generator: 'img2img-sdxl',
            params: {
                image: r1.files[0].path,
                prompt: 'masterpiece, best quality, a cute cat astronaut on the moon, helmet visor reflecting earth',
                strength: 0.35,
            },
            output: { name: 'accept-img2img' },
        },
        undefined,
        'img2img',
    );
    console.log(`  ${generateMod.composeResultText(r2).split('\n').join('\n  ')}`);
    check('img2img completed', r2.state === 'completed', JSON.stringify({ state: r2.state, error: r2.error }));
    check(
        'img2img file saved',
        r2.files.length > 0 &&
            r2.files.every((f) => {
                try {
                    return statSync(join(wsRoot, f.path)).size > 0;
                } catch {
                    return false;
                }
            }),
    );
} else {
    console.log('─ img2img skipped (source job failed)');
    failures += 1;
}

/* ---------- 5. session cancel (active job → interrupt) ---------- */
console.log('─ cancel: active job');
const longPending = queue.enqueue(
    { generator: 'txt2img-sdxl', params: { prompt: 'long run for cancel test', steps: 100 } },
    undefined,
    'cancel-target',
);
await sleep(6_000);
const queuedFrame = [...frames].reverse().find((f) => f.kind === 'job' && f.state === 'queued');
check('cancel target jobId known', Boolean(queuedFrame));
const cancelledId = queuedFrame ? queue.cancel(queuedFrame.jobId) : null;
check('queue.cancel returned target', cancelledId !== null, String(cancelledId));
const r3 = await longPending;
console.log(`  → ${r3.state} ${r3.error ?? ''}`);
check('cancel → cancelled', r3.state === 'cancelled', JSON.stringify({ state: r3.state, error: r3.error }));

/* ---------- 6. queue overflow (maxQueue=2) ---------- */
console.log('─ queue overflow');
const a = queue.enqueue({ generator: 'txt2img-sdxl', params: { prompt: 'overflow a', steps: 100 } }, undefined, 'a');
const b = queue.enqueue({ generator: 'txt2img-sdxl', params: { prompt: 'overflow b', steps: 100 } }, undefined, 'b');
let overflowMsg = '';
try {
    await queue.enqueue({ generator: 'txt2img-sdxl', params: { prompt: 'overflow c' } }, undefined, 'c');
} catch (error) {
    overflowMsg = error instanceof Error ? error.message : String(error);
}
console.log(`  → ${overflowMsg}`);
check('third enqueue rejected', overflowMsg.includes('队列已满'), overflowMsg);
await sleep(1_000);
const idA = [...frames].reverse().find((f) => f.kind === 'job' && f.state === 'queued' && f.title === 'a')?.jobId;
const idB = [...frames].reverse().find((f) => f.kind === 'job' && f.state === 'queued' && f.title === 'b')?.jobId;
if (idA) queue.cancel(idA);
if (idB) queue.cancel(idB);
const [ra, rb] = await Promise.all([a, b]);
check('both overflow jobs cancelled', ra.state === 'cancelled' && rb.state === 'cancelled');

/* ---------- 7. error paths ---------- */
console.log('─ error paths');
const expectReject = async (promise, needle, name) => {
    try {
        await promise;
        check(name, false, 'resolved instead of rejecting');
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        check(name, msg.includes(needle), msg);
    }
};
await expectReject(queue.enqueue({ generator: 'nope' }, undefined, 'e1'), '未找到', 'unknown generator rejected');
await expectReject(
    queue.enqueue({ generator: 'txt2img-sdxl', params: {} }, undefined, 'e2'),
    '参数无效',
    'missing prompt rejected',
);
await expectReject(
    queue.enqueue(
        { generator: 'txt2img-sdxl', params: { prompt: 'x' }, output: { dir: '../escape' } },
        undefined,
        'e3',
    ),
    'output.dir',
    'dir escape rejected',
);

/* ---------- summary ---------- */
console.log(`\nframes total: ${frames.length} (preview: ${previewCount.n})`);
console.log(failures === 0 ? 'acceptance: ALL PASSED' : `acceptance: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
