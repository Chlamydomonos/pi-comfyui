// img2img-sdxl.js —— SDXL 图生图模板(带输入文件 ctx.resolvePath 用法;自包含,禁止 import)
//
// 节点 id 用可读字符串;LoRA 为可选列表,链式叠加(与 txt2img 相同:每级接上一级,下游取链尾)。
export default {
    name: 'img2img-sdxl',
    title: 'SDXL 图生图',
    description:
        '以工作区图片为底进行 img2img;image 必填(工作区相对路径),strength 控制重绘幅度,loras 可选(按序叠加 LoRA)',
    params: {
        type: 'object',
        properties: {
            image: { type: 'string', description: '工作区内图片相对路径,如 refs/sketch.png' },
            prompt: { type: 'string' },
            negative: { type: 'string', default: '' },
            strength: { type: 'number', default: 0.6, minimum: 0, maximum: 1, description: '1=完全重画,0=不动原图' },
            loras: {
                type: 'array',
                default: [],
                maxItems: 5,
                description: '可选 LoRA 列表,按顺序依次叠加;每项形如 {name, strength},name 必填',
                items: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description:
                                'LoRA 文件名(含子目录),如 illustrious/slimeILv3d32.safetensors;清单查 curl -s http://127.0.0.1:4100/object_info/LoraLoader',
                        },
                        strength: {
                            type: 'number',
                            default: 1.0,
                            minimum: -1,
                            maximum: 1.5,
                            description: '默认 1.0;超过 1.2 易崩图',
                        },
                    },
                    required: ['name'],
                },
            },
        },
        required: ['image', 'prompt'],
    },
    build(params, ctx) {
        const graph = {};

        graph.ckpt = {
            class_type: 'CheckpointLoaderSimple',
            inputs: { ckpt_name: 'waiIllustriousSDXL_v160.safetensors' },
        };
        graph.load_img = { class_type: 'LoadImageFromPath', inputs: { image: ctx.resolvePath(params.image) } };

        // LoRA 链(与 txt2img 相同):每级 model+clip 接上一级,链尾供下游;VAE 直接取 checkpoint 口 2。
        // 数组参数校验器只验"是数组":item 不做 schema 校验、item 级 default 不合并 → 这里自行兜底。
        let modelSrc = ['ckpt', 0];
        let clipSrc = ['ckpt', 1];
        (params.loras ?? []).forEach((lora, i) => {
            if (lora == null || typeof lora.name !== 'string' || lora.name === '') {
                throw new Error(`params.loras[${i}] 缺少 name 字符串(须为 {name, strength?})`);
            }
            const id = `lora${i + 1}`;
            const strength = typeof lora.strength === 'number' ? lora.strength : 1.0;
            // 校验器不查 item 范围 → 在这里拦(与 params.items.strength 的 minimum/maximum 保持一致)。
            if (strength < -1 || strength > 1.5) {
                throw new Error(`params.loras[${i}].strength 越界(允许 -1~1.5),得到 ${strength}`);
            }
            graph[id] = {
                class_type: 'LoraLoader',
                inputs: {
                    lora_name: lora.name,
                    strength_model: strength,
                    strength_clip: strength,
                    model: modelSrc,
                    clip: clipSrc,
                },
            };
            modelSrc = [id, 0];
            clipSrc = [id, 1];
        });

        graph.pos = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: clipSrc } };
        graph.neg = { class_type: 'CLIPTextEncode', inputs: { text: params.negative, clip: clipSrc } };
        graph.encode = { class_type: 'VAEEncode', inputs: { pixels: ['load_img', 0], vae: ['ckpt', 2] } };
        graph.ksampler = {
            class_type: 'KSampler',
            inputs: {
                seed: Math.floor(Math.random() * 2 ** 31),
                steps: 30,
                cfg: 7.0,
                sampler_name: 'euler',
                scheduler: 'normal',
                denoise: params.strength,
                model: modelSrc,
                positive: ['pos', 0],
                negative: ['neg', 0],
                latent_image: ['encode', 0],
            },
        };
        graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['ksampler', 0], vae: ['ckpt', 2] } };
        graph.save = { class_type: 'SaveImage', inputs: { filename_prefix: `pi/${ctx.token}`, images: ['decode', 0] } };

        return { prompt: graph };
    },
};
