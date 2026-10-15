// Offline smoke test for pi-comfyui (docs/50 §5):
// - mini param validator (defaults / required / enum / range)
// - generator loader against examples/generators
// - generator build() → graph sanity
// - config loading (two-level merge, bad-file tolerance)
// Uses jiti to import TS sources directly — no build step needed.
import { createJiti } from 'jiti';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const jiti = createJiti(import.meta.url);

let failures = 0;
function check(name, condition, detail = '') {
    if (condition) {
        console.log(`  ok ${name}`);
    } else {
        failures += 1;
        console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const protocol = await jiti.import(join(packageRoot, 'src/shared/protocol.ts'));
const config = await jiti.import(join(packageRoot, 'src/extension/config.ts'));
const generators = await jiti.import(join(packageRoot, 'src/extension/generators.ts'));

console.log('─ mini validator');
{
    const schema = {
        type: 'object',
        properties: {
            prompt: { type: 'string' },
            negative: { type: 'string', default: '' },
            width: { type: 'integer', default: 1024, minimum: 256, maximum: 2048 },
            steps: { type: 'integer', default: 30 },
            flavor: { type: 'string', enum: ['a', 'b'], default: 'a' },
        },
        required: ['prompt'],
    };
    const apply = (value) => generators.validateAndApplyDefaults(schema, value);
    const ok = apply({ prompt: 'hi' });
    check(
        'defaults applied',
        ok.ok && ok.value.negative === '' && ok.value.width === 1024 && ok.value.flavor === 'a',
        JSON.stringify(ok),
    );
    const missing = apply({});
    check('required rejected', !missing.ok && (missing.errors ?? []).some((e) => e.includes('prompt')));
    const badEnum = apply({ prompt: 'x', flavor: 'zzz' });
    check('enum rejected', !badEnum.ok);
    const badRange = apply({ prompt: 'x', width: 9999 });
    check('maximum rejected', !badRange.ok);
    const unknownOk = apply({ prompt: 'x', extra: { nested: 1 } });
    check('unknown keys tolerated', unknownOk.ok);
}

console.log('─ protocol constants');
{
    check('COMFYUI_CHANNEL', protocol.COMFYUI_CHANNEL === 'pi-comfyui');
}

console.log('─ generator loading (examples/generators)');
{
    const dir = join(packageRoot, 'examples', 'generators');
    const { generators: loaded, invalid } = await generators.loadGenerators(dir);
    check('no invalid files', invalid.length === 0, JSON.stringify(invalid));
    check('two generators', loaded.length === 2, loaded.map((g) => g.name).join(','));
    const txt2img = loaded.find((g) => g.name === 'txt2img-sdxl');
    check('txt2img present', Boolean(txt2img));
    check(
        'titles present',
        loaded.every((g) => typeof g.title === 'string'),
    );

    // build() produces a graph with an output node
    if (txt2img) {
        const applied = generators.validateAndApplyDefaults(txt2img.params, { prompt: 'sunset pier' });
        check('params validation passes', applied.ok);
        const ctxLike = {
            workspace: packageRoot,
            resolvePath: (p) => join(packageRoot, p),
            token: 'ab12cd',
            now: 'now',
        };
        const result = txt2img.build(applied.value, ctxLike);
        const graph = result.prompt;
        const nodes = Object.values(graph);
        check(
            'graph has SaveImage',
            nodes.some((n) => n.class_type === 'SaveImage'),
        );
        const save = nodes.find((n) => n.class_type === 'SaveImage');
        check('filename_prefix uses ctx.token', save.inputs.filename_prefix === 'pi/ab12cd');
        check('random seed injected', Number.isInteger(graph[5].inputs.seed));
        // resolveInputPath on absolute vs relative
        const abs = join(tmpdir(), 'x.png');
        check('absolute passthrough', generators.resolveInputPath(packageRoot, abs) === abs);
        check(
            'relative resolves under workspace',
            generators.resolveInputPath(packageRoot, 'a/b.png').startsWith(packageRoot),
        );
    }

    const img2img = loaded.find((g) => g.name === 'img2img-sdxl');
    check('img2img present', Boolean(img2img));
    if (img2img) {
        const applied = generators.validateAndApplyDefaults(img2img.params, {
            image: 'refs/sketch.png',
            prompt: 'garden',
        });
        check('img2img strength default 0.6', applied.ok && applied.value.strength === 0.6);
    }
}

console.log('─ generator loader rejects import');
{
    const tmp = mkdtempSync(join(tmpdir(), 'pi-comfyui-smoke-'));
    try {
        const badFile = join(tmp, 'bad-one.js');
        writeFileSync(
            badFile,
            "import { x } from 'other';\nexport default { name: 'bad-one', title: 't', description: 'd', params: { type: 'object' }, build() { return {}; } };\n",
            'utf8',
        );
        const { generators: loaded, invalid } = await generators.loadGenerators(tmp);
        check('import rejected', loaded.length === 0 && invalid.length === 1 && invalid[0].file === 'bad-one.js');
        // name rule
        const badName = join(tmp, 'Bad_Name.js');
        writeFileSync(
            badName,
            "export default { name: 'Bad_Name', title: 't', description: 'd', params: { type: 'object' }, build() { return {}; } };\n",
            'utf8',
        );
        const second = await generators.loadGenerators(tmp);
        check(
            'invalid name rejected',
            second.invalid.some((i) => i.file === 'Bad_Name.js'),
        );
        // build not a function
        const badBuild = join(tmp, 'no-build.js');
        writeFileSync(
            badBuild,
            "export default { name: 'no-build', title: 't', description: 'd', params: { type: 'object' } };\n",
            'utf8',
        );
        const third = await generators.loadGenerators(tmp);
        check(
            'missing build rejected',
            third.invalid.some((i) => i.file === 'no-build.js'),
        );
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

console.log('─ config loading');
{
    const tmp = mkdtempSync(join(tmpdir(), 'pi-comfyui-smoke-cfg-'));
    try {
        const home = join(tmp, 'home');
        const cwd = join(tmp, 'project');
        mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
        mkdirSync(cwd, { recursive: true });
        writeFileSync(
            join(home, '.pi', 'agent', 'comfyui.json'),
            JSON.stringify({
                baseUrl: 'http://127.0.0.1:4100/',
                outputDir: 'out-home',
                tools: ['generate', 'list', 'status', 'cancel', 'ghost'],
                maxQueue: 99,
            }),
            'utf8',
        );
        const warns = [];
        const cfg = config.loadConfig(cwd, (m) => warns.push(m), home);
        check('home baseUrl kept verbatim', cfg.baseUrl === 'http://127.0.0.1:4100/', cfg.baseUrl);
        check('outputDir from home', cfg.outputDir === 'out-home');
        check('unknown tool filtered', cfg.tools.join() === 'generate,list,status,cancel', cfg.tools.join());
        check(
            'maxQueue out of range ignored',
            cfg.maxQueue === 2 && warns.some((m) => m.includes('maxQueue')),
            String(cfg.maxQueue),
        );
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'comfyui.json'), '{ not json', 'utf8');
        const cfg2 = config.loadConfig(cwd, (m) => warns.push(m), home);
        check('bad workspace file ignored', cfg2.outputDir === 'out-home' && warns.length >= 1);
        writeFileSync(
            join(cwd, '.pi', 'comfyui.json'),
            JSON.stringify({ outputDir: 'out-cwd', previewMaxSize: 64 }),
            'utf8',
        );
        const cfg3 = config.loadConfig(cwd, (m) => warns.push(m), home);
        check('workspace overrides home', cfg3.outputDir === 'out-cwd');
        check('untouched key preserved', cfg3.baseUrl === 'http://127.0.0.1:4100/');
        check('int coerce', cfg3.previewMaxSize === 64);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
