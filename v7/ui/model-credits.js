/* ⭐ 2026-10-18 用到的模型清单（用户：「我们使用了哪些模型需要在关于软件里面详细的列出来」）。
 *   在「设置 → 关于软件 → 用到的模型」里显示；也给安装包里的许可证说明用。
 *   来源：docs/183（每个模型的官方出处）+ 10-18 现查官方模型库的 license 字段；云端实际装的文件见 docs/245。
 *   ⚠ 规矩：
 *     · 只写事实：许可证名、作者、我们拿它干什么、跑在哪；不确定的写「待核实」，不猜；
 *     · 模型的名字照官方写（这是说明出处，许可证允许的「描述性使用」），但软件的功能名不用别人的商标当主名；
 *     · 加 / 换模型时一定改这里，不然「关于软件」就是在骗人。
 */
(function (root) {
  'use strict';
  var M = [
    // ── 云端出图（ComfyUI，算力机）──
    { group: '云端出图', name: 'Qwen-Image 2.1', by: '阿里巴巴通义实验室', use: '改图 / 文生图（软件里叫「研究出图」）', where: '云端',
      license: 'Qwen RESEARCH LICENSE（仅限研究与评估，非商业）', url: 'https://huggingface.co/Qwen/Qwen-Image-2.1', nonCommercial: true },
    { group: '云端出图', name: 'Qwen-Image-Edit-2511', by: '阿里巴巴通义实验室', use: '改图', where: '云端', license: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen-Image-Edit-2511' },
    { group: '云端出图', name: 'Qwen-Image-Edit-2511-Lightning（4 步加速）', by: 'lightx2v', use: '上面那个改图模型的加速版', where: '云端', license: 'Apache-2.0', url: 'https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning' },
    { group: '云端出图', name: 'Qwen2.5-VL-7B / Qwen3-VL-8B（文本编码器）', by: '阿里巴巴通义实验室', use: '出图模型读提示词用', where: '云端', license: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct' },
    { group: '云端出图', name: 'SD1.5 / SDXL 社区模型与 LoRA（majicMIX、XXMix、LEOSAM 等）', by: '各社区作者', use: '云端预设（Forge 类工作流）', where: '云端', license: '各作者自定（CreativeML OpenRAIL-M 等）待逐个核实', url: '' },
    // ── 外挂能力（云端外挂 / 本机引擎）──
    { group: '外挂能力', name: 'BiRefNet（轻量 / 标准 / 高精三档）', by: 'ZhengPeng7 等', use: '抠像', where: '云端 / 本机', license: 'MIT', url: 'https://huggingface.co/ZhengPeng7/BiRefNet' },
    { group: '外挂能力', name: 'SAM 2（tiny / base+ / large）', by: 'Meta', use: '指哪抠哪', where: '云端 / 本机', license: 'Apache-2.0', url: 'https://huggingface.co/facebook/sam2-hiera-large' },
    { group: '外挂能力', name: 'SAM 3', by: 'Meta', use: '文字找东西（说出要选什么）', where: '云端 / 本机', license: 'SAM License（允许商用，分发须附协议）', url: 'https://huggingface.co/facebook/sam3' },
    { group: '外挂能力', name: 'Sapiens2 人体解析 0.8B', by: 'Meta', use: '人体解析（分出头发、皮肤、衣服…）', where: '云端 / 本机', license: 'Sapiens2 License（Meta 自定；禁止用于深度伪造等，详见原文）', url: 'https://huggingface.co/facebook/sapiens2-seg-0.8b' },
    { group: '外挂能力', name: 'SCHP 人体解析（ATR / LIP）', by: 'Peike Li 等', use: '人体解析（轻量）', where: '云端 / 本机', license: 'MIT（代码）；训练数据集为学术用途，待核实', url: 'https://huggingface.co/Longcat2957/humanparsing-onnx' },
    { group: '外挂能力', name: 'SegFormer-B2 衣物解析', by: 'mattmdjaga', use: '人体解析（衣物）', where: '云端 / 本机', license: 'MIT', url: 'https://huggingface.co/mattmdjaga/segformer_b2_clothes' },
    { group: '外挂能力', name: 'ViTMatte', by: '华中科技大学 hustvl', use: '细边（头发丝）', where: '云端 / 本机', license: 'Apache-2.0', url: 'https://huggingface.co/hustvl/vitmatte-base-composition-1k' },
    { group: '外挂能力', name: 'RIFE 4.9', by: 'hzwer（Practical-RIFE）', use: '过渡帧（调强度预览）', where: '云端 / 本机', license: 'MIT', url: 'https://github.com/hzwer/Practical-RIFE' }
  ];
  var NOTE = '以上模型都不是修图轮椅训练的，版权归各自作者。修图轮椅只是调用它们，并按各自的许可证使用；许可证原文在安装目录的 licenses 文件夹里。'
    + '标了「非商业」的模型（Qwen-Image 2.1）在修图轮椅里免费提供，仅供学习交流，用户自行对生成内容负责，不得用于商业用途。';
  root.V7ModelCredits = Object.freeze({ list: M, note: NOTE });
})(typeof window !== 'undefined' ? window : globalThis);
