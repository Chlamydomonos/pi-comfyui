// txt2img-sdxl.js —— SDXL 文生图示例(与 docs/20 §2 一致;自包含,禁止 import)
export default {
    name: 'txt2img-sdxl',
    title: 'SDXL 文生图',
    description: '用 SDXL 生成静态图片;prompt 必填',
    params: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: '正向提示词' },
            negative: { type: 'string', default: '', description: '负向提示词' },
            width: { type: 'integer', default: 1024, minimum: 256, maximum: 2048 },
            height: { type: 'integer', default: 1024, minimum: 256, maximum: 2048 },
            steps: { type: 'integer', default: 30, minimum: 1, maximum: 100 },
            seed: { type: 'integer', minimum: 0, description: '缺省为随机' },
        },
        required: ['prompt'],
    },
    build(params, ctx) {
        return {
            prompt: {
                1: {
                    class_type: 'CheckpointLoaderSimple',
                    inputs: { ckpt_name: 'waiIllustriousSDXL_v160.safetensors' },
                },
                2: { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
                3: { class_type: 'CLIPTextEncode', inputs: { text: params.negative, clip: ['1', 1] } },
                4: {
                    class_type: 'EmptyLatentImage',
                    inputs: { width: params.width, height: params.height, batch_size: 1 },
                },
                5: {
                    class_type: 'KSampler',
                    inputs: {
                        seed: params.seed ?? Math.floor(Math.random() * 2 ** 31),
                        steps: params.steps,
                        cfg: 7.0,
                        sampler_name: 'euler',
                        scheduler: 'normal',
                        denoise: 1.0,
                        model: ['1', 0],
                        positive: ['2', 0],
                        negative: ['3', 0],
                        latent_image: ['4', 0],
                    },
                },
                6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
                7: { class_type: 'SaveImage', inputs: { filename_prefix: `pi/${ctx.token}`, images: ['6', 0] } },
            },
        };
    },
};
