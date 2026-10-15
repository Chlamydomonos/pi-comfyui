import { loadGenerators, defaultGeneratorDir } from './generators.js';

export interface GeneratorSummary {
    name: string;
    title?: string;
    description?: string;
    paramsSchema: Record<string, unknown>;
    valid: boolean;
    error?: string;
}

export interface ListDetails {
    generators: GeneratorSummary[];
}

/** comfyui_list_generators: collect generator summaries + content text. */
export async function collectGenerators(workspace: string): Promise<{ text: string; details: ListDetails }> {
    const { generators, invalid } = await loadGenerators(defaultGeneratorDir(workspace));
    const items: GeneratorSummary[] = generators.map((g) => ({
        name: g.name,
        title: g.title,
        description: g.description,
        paramsSchema: g.params,
        valid: true,
    }));
    for (const i of invalid) items.push({ name: i.file, paramsSchema: {}, valid: false, error: i.error });
    const details: ListDetails = { generators: items };
    const lines: string[] = [];
    if (details.generators.length === 0) {
        lines.push(`未找到任何生成器。请在工作区 generators/ 目录放置 *.js 文件(参考 examples/generators/)。`);
    }
    for (const g of generators) {
        const label = g.title ?? g.name;
        lines.push(
            `- ${g.name}${g.title !== g.name ? ` (${label})` : ''}${g.description ? ` — ${g.description}` : ''}`,
        );
    }
    for (const bad of invalid) {
        lines.push(`! ${bad.file}: ${bad.error}`);
    }
    return { text: lines.join('\n'), details };
}
