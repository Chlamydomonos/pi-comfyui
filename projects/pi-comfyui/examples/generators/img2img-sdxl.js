// img2img-sdxl.js —— SDXL 图生图示例(与 docs/20 §9 一致;自包含,禁止 import)
export default {
    name: 'img2img-sdxl',
    title: 'SDXL 图生图',
    description: '以工作区图片为底进行 img2img;image 必填(工作区相对路径),strength 控制重绘幅度',
    params: {
        type: 'object',
        properties: {
            image: { type: 'string', description: '工作区内图片相对路径,如 refs/sketch.png' },
            prompt: { type: 'string' },
            negative: { type: 'string', default: '' },
            strength: { type: 'number', default: 0.6, minimum: 0, maximum: 1, description: '1=完全重画,0=不动原图' },
        },
        required: ['image', 'prompt'],
    },
    build(params, ctx) {
        return {
            prompt: {
                1: {
                    class_type: 'CheckpointLoaderSimple',
                    inputs: { ckpt_name: 'waiIllustriousSDXL_v160.safetensors' },
                },
                2: { class_type: 'LoadImageFromPath', inputs: { image: ctx.resolvePath(params.image) } },
                3: { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
                4: { class_type: 'CLIPTextEncode', inputs: { text: params.negative, clip: ['1', 1] } },
                5: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
                6: {
                    class_type: 'KSampler',
                    inputs: {
                        seed: Math.floor(Math.random() * 2 ** 31),
                        steps: 30,
                        cfg: 7.0,
                        sampler_name: 'euler',
                        scheduler: 'normal',
                        denoise: params.strength,
                        model: ['1', 0],
                        positive: ['3', 0],
                        negative: ['4', 0],
                        latent_image: ['5', 0],
                    },
                },
                7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
                8: { class_type: 'SaveImage', inputs: { filename_prefix: `pi/${ctx.token}`, images: ['7', 0] } },
            },
        };
    },
};
