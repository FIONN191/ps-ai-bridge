// 千问模式引擎（data/workflows/custom_nodes/v7_mapping/make_qwen_presets.py --engine-js 生成，别手改）
window.__V7_QWEN_ENGINE__ = {
 "schema": "wheelchair-v7-qwen-engine",
 "version": 1,
 "refMax": 5,
 "engines": {
  "t2i": {
   "schema": "wheelchair-v7-comfyui-preset",
   "version": 1,
   "id": "v7map-qwen21-t2i",
   "platformPresetId": "qwen21-t2i",
   "title": "千问2.1 文生图",
   "category": "",
   "provider": "comfyui",
   "sourceKind": "comfyui",
   "sourceName": "ComfyUI V7 映射",
   "source": "comfyui-v7-mapping",
   "migrationState": "comfyui-mapped",
   "needsReview": false,
   "content": "",
   "workflow": {
    "1": {
     "class_type": "UNETLoader",
     "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
     }
    },
    "2": {
     "class_type": "QwenImage21Cache",
     "inputs": {
      "model": [
       "1",
       0
      ],
      "device": "auto",
      "dtype": "default"
     }
    },
    "3": {
     "class_type": "CLIPLoader",
     "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
     }
    },
    "4": {
     "class_type": "VAELoader",
     "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
     }
    },
    "9": {
     "class_type": "VAEDecode",
     "inputs": {
      "samples": [
       "8",
       0
      ],
      "vae": [
       "4",
       0
      ]
     }
    },
    "10": {
     "class_type": "V7MapOutput",
     "inputs": {
      "images": [
       "9",
       0
      ]
     }
    },
    "20": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": 1024,
      "key": "resolution",
      "label": "画质（长边 1024=1K / 2048=2K）",
      "min": 1024,
      "max": 2048,
      "role": "分辨率(计价)"
     },
     "_meta": {
      "title": "V7 参数·画质"
     }
    },
    "22": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": -1,
      "key": "seed",
      "label": "种子",
      "min": -1,
      "max": 9007199254740991,
      "role": "种子"
     },
     "_meta": {
      "title": "V7 参数·种子"
     }
    },
    "7": {
     "class_type": "TextEncodeQwenImage21",
     "inputs": {
      "clip": [
       "3",
       0
      ],
      "vae": [
       "4",
       0
      ],
      "prompt": [
       "21",
       0
      ],
      "negative_prompt": "",
      "resolution": 0
     }
    },
    "23": {
     "class_type": "V7MapChoice",
     "inputs": {
      "value": "1:1",
      "key": "aspectRatio",
      "label": "宽高比",
      "options": "1:1\nAuto\n9:16\n16:9\n2:3\n3:2\n3:4\n4:3\n4:5\n5:4\n21:9\n9:21\n2:1\n1:2\n3:1\n1:3",
      "role": "普通"
     },
     "_meta": {
      "title": "V7 参数·比例"
     }
    },
    "30": {
     "class_type": "V7AspectSize",
     "inputs": {
      "aspect": [
       "23",
       0
      ],
      "long_side": [
       "20",
       0
      ]
     }
    },
    "31": {
     "class_type": "EmptyLatentImage",
     "inputs": {
      "width": [
       "30",
       0
      ],
      "height": [
       "30",
       1
      ],
      "batch_size": 1
     }
    },
    "8": {
     "class_type": "KSampler",
     "inputs": {
      "model": [
       "2",
       0
      ],
      "seed": [
       "22",
       0
      ],
      "steps": 25,
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0,
      "positive": [
       "7",
       0
      ],
      "negative": [
       "7",
       1
      ],
      "latent_image": [
       "31",
       0
      ]
     }
    },
    "21": {
     "class_type": "V7MapPrompt",
     "inputs": {
      "value": "",
      "role": "正向(软件输入框)",
      "key": "extraText",
      "label": "画面描述",
      "max_chars": 2000
     },
     "_meta": {
      "title": "V7 提示词"
     }
    }
   },
   "inputNodeIds": [],
   "referenceNodeIds": [],
   "outputNodeIds": [
    "10"
   ],
   "promptBindings": [],
   "parameterBindings": [
    {
     "key": "resolution",
     "nodeId": "20",
     "input": "value",
     "type": "number",
     "label": "画质（长边 1024=1K / 2048=2K）",
     "min": 1024,
     "max": 2048,
     "step": 1,
     "integer": true,
     "default": 1024
    },
    {
     "key": "positivePrompt",
     "nodeId": "21",
     "input": "value",
     "type": "string",
     "label": "画面描述",
     "editor": "textarea",
     "transient": true,
     "default": "",
     "source": "prompt",
     "maxLength": 2000
    },
    {
     "key": "seed",
     "nodeId": "22",
     "input": "value",
     "type": "number",
     "label": "种子",
     "min": -1,
     "max": 9007199254740991,
     "step": 1,
     "integer": true,
     "randomizeWhen": -1,
     "default": -1
    },
    {
     "key": "aspectRatio",
     "nodeId": "23",
     "input": "value",
     "type": "string",
     "label": "宽高比",
     "selectable": true,
     "options": [
      "1:1",
      "Auto",
      "9:16",
      "16:9",
      "2:3",
      "3:2",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "21:9",
      "9:21",
      "2:1",
      "1:2",
      "3:1",
      "1:3"
     ],
     "default": "1:1"
    }
   ],
   "batchBinding": null,
   "parameters": {
    "resolution": 1024,
    "seed": -1
   },
   "mapping": {
    "version": 1,
    "workflowSha256": "ba09fad8528e43b2a2522fe6d31183adc2dbcf91a4b923a684a9b4101237a761"
   }
  },
  "edit": {
   "schema": "wheelchair-v7-comfyui-preset",
   "version": 1,
   "id": "v7map-qwen21-edit",
   "platformPresetId": "qwen21-edit",
   "title": "千问2.1 改图",
   "category": "",
   "provider": "comfyui",
   "sourceKind": "comfyui",
   "sourceName": "ComfyUI V7 映射",
   "source": "comfyui-v7-mapping",
   "migrationState": "comfyui-mapped",
   "needsReview": false,
   "content": "",
   "workflow": {
    "1": {
     "class_type": "UNETLoader",
     "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
     }
    },
    "2": {
     "class_type": "QwenImage21Cache",
     "inputs": {
      "model": [
       "1",
       0
      ],
      "device": "auto",
      "dtype": "default"
     }
    },
    "3": {
     "class_type": "CLIPLoader",
     "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
     }
    },
    "4": {
     "class_type": "VAELoader",
     "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
     }
    },
    "5": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "主图(PS抓图)",
      "v7_order": 1
     }
    },
    "6": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "5",
       0
      ],
      "max_side": [
       "20",
       0
      ],
      "max_pixels": 0
     }
    },
    "7": {
     "class_type": "TextEncodeQwenImage21",
     "inputs": {
      "clip": [
       "3",
       0
      ],
      "vae": [
       "4",
       0
      ],
      "images.image_1": [
       "6",
       0
      ],
      "prompt": [
       "21",
       0
      ],
      "negative_prompt": "",
      "resolution": 0
     }
    },
    "8": {
     "class_type": "KSampler",
     "inputs": {
      "model": [
       "2",
       0
      ],
      "seed": [
       "22",
       0
      ],
      "steps": 25,
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0,
      "positive": [
       "7",
       0
      ],
      "negative": [
       "7",
       1
      ],
      "latent_image": [
       "7",
       2
      ]
     }
    },
    "9": {
     "class_type": "VAEDecode",
     "inputs": {
      "samples": [
       "8",
       0
      ],
      "vae": [
       "4",
       0
      ]
     }
    },
    "10": {
     "class_type": "V7MapOutput",
     "inputs": {
      "images": [
       "9",
       0
      ]
     }
    },
    "20": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": 1024,
      "key": "resolution",
      "label": "画质（长边 1024=1K / 2048=2K）",
      "min": 1024,
      "max": 2048,
      "role": "分辨率(计价)"
     },
     "_meta": {
      "title": "V7 参数·画质"
     }
    },
    "21": {
     "class_type": "V7MapPrompt",
     "inputs": {
      "value": "",
      "role": "正向(软件输入框)",
      "key": "extraText",
      "label": "改图要求",
      "max_chars": 2000
     },
     "_meta": {
      "title": "V7 提示词"
     }
    },
    "22": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": -1,
      "key": "seed",
      "label": "种子",
      "min": -1,
      "max": 9007199254740991,
      "role": "种子"
     },
     "_meta": {
      "title": "V7 参数·种子"
     }
    }
   },
   "inputNodeIds": [
    "5"
   ],
   "referenceNodeIds": [],
   "outputNodeIds": [
    "10"
   ],
   "promptBindings": [],
   "parameterBindings": [
    {
     "key": "resolution",
     "nodeId": "20",
     "input": "value",
     "type": "number",
     "label": "画质（长边 1024=1K / 2048=2K）",
     "min": 1024,
     "max": 2048,
     "step": 1,
     "integer": true,
     "default": 1024
    },
    {
     "key": "positivePrompt",
     "nodeId": "21",
     "input": "value",
     "type": "string",
     "label": "改图要求",
     "editor": "textarea",
     "transient": true,
     "default": "",
     "source": "prompt",
     "maxLength": 2000
    },
    {
     "key": "seed",
     "nodeId": "22",
     "input": "value",
     "type": "number",
     "label": "种子",
     "min": -1,
     "max": 9007199254740991,
     "step": 1,
     "integer": true,
     "randomizeWhen": -1,
     "default": -1
    }
   ],
   "batchBinding": null,
   "parameters": {
    "resolution": 1024,
    "seed": -1
   },
   "mapping": {
    "version": 1,
    "workflowSha256": "8ac1b9c0a62ad46cec728b0acaac09378de2d762e0f6b25ecd13d7c9bc0c34cf"
   }
  },
  "ref1": {
   "schema": "wheelchair-v7-comfyui-preset",
   "version": 1,
   "id": "v7map-qwen21-edit-ref1",
   "platformPresetId": "qwen21-edit-ref1",
   "title": "千问2.1 改图（主图 + 1 张参考图）",
   "category": "",
   "provider": "comfyui",
   "sourceKind": "comfyui",
   "sourceName": "ComfyUI V7 映射",
   "source": "comfyui-v7-mapping",
   "migrationState": "comfyui-mapped",
   "needsReview": false,
   "content": "",
   "workflow": {
    "1": {
     "class_type": "UNETLoader",
     "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
     }
    },
    "2": {
     "class_type": "QwenImage21Cache",
     "inputs": {
      "model": [
       "1",
       0
      ],
      "device": "auto",
      "dtype": "default"
     }
    },
    "3": {
     "class_type": "CLIPLoader",
     "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
     }
    },
    "4": {
     "class_type": "VAELoader",
     "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
     }
    },
    "9": {
     "class_type": "VAEDecode",
     "inputs": {
      "samples": [
       "8",
       0
      ],
      "vae": [
       "4",
       0
      ]
     }
    },
    "10": {
     "class_type": "V7MapOutput",
     "inputs": {
      "images": [
       "9",
       0
      ]
     }
    },
    "20": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": 1024,
      "key": "resolution",
      "label": "画质（长边 1024=1K / 2048=2K）",
      "min": 1024,
      "max": 2048,
      "role": "分辨率(计价)"
     },
     "_meta": {
      "title": "V7 参数·画质"
     }
    },
    "22": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": -1,
      "key": "seed",
      "label": "种子",
      "min": -1,
      "max": 9007199254740991,
      "role": "种子"
     },
     "_meta": {
      "title": "V7 参数·种子"
     }
    },
    "5": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "主图(PS抓图)",
      "v7_order": 1
     }
    },
    "6": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "5",
       0
      ],
      "max_side": [
       "20",
       0
      ],
      "max_pixels": 0
     }
    },
    "8": {
     "class_type": "KSampler",
     "inputs": {
      "model": [
       "2",
       0
      ],
      "seed": [
       "22",
       0
      ],
      "steps": 25,
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0,
      "positive": [
       "7",
       0
      ],
      "negative": [
       "7",
       1
      ],
      "latent_image": [
       "7",
       2
      ]
     }
    },
    "21": {
     "class_type": "V7MapPrompt",
     "inputs": {
      "value": "",
      "role": "正向(软件输入框)",
      "key": "extraText",
      "label": "改图要求",
      "max_chars": 2000
     },
     "_meta": {
      "title": "V7 提示词"
     }
    },
    "41": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 2
     },
     "_meta": {
      "title": "V7 参考图 1"
     }
    },
    "51": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "41",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "7": {
     "class_type": "TextEncodeQwenImage21",
     "inputs": {
      "clip": [
       "3",
       0
      ],
      "vae": [
       "4",
       0
      ],
      "images.image_1": [
       "6",
       0
      ],
      "prompt": [
       "21",
       0
      ],
      "negative_prompt": "",
      "resolution": 0,
      "images.image_2": [
       "51",
       0
      ]
     }
    }
   },
   "inputNodeIds": [
    "5"
   ],
   "referenceNodeIds": [
    "41"
   ],
   "outputNodeIds": [
    "10"
   ],
   "promptBindings": [],
   "parameterBindings": [
    {
     "key": "resolution",
     "nodeId": "20",
     "input": "value",
     "type": "number",
     "label": "画质（长边 1024=1K / 2048=2K）",
     "min": 1024,
     "max": 2048,
     "step": 1,
     "integer": true,
     "default": 1024
    },
    {
     "key": "positivePrompt",
     "nodeId": "21",
     "input": "value",
     "type": "string",
     "label": "改图要求",
     "editor": "textarea",
     "transient": true,
     "default": "",
     "source": "prompt",
     "maxLength": 2000
    },
    {
     "key": "seed",
     "nodeId": "22",
     "input": "value",
     "type": "number",
     "label": "种子",
     "min": -1,
     "max": 9007199254740991,
     "step": 1,
     "integer": true,
     "randomizeWhen": -1,
     "default": -1
    }
   ],
   "batchBinding": null,
   "parameters": {
    "resolution": 1024,
    "seed": -1
   },
   "mapping": {
    "version": 1,
    "workflowSha256": "e464536584b795d641ed122fd6f7b7f4efa61ace3bde9fea0c5ece21aa63aa7c"
   }
  },
  "ref2": {
   "schema": "wheelchair-v7-comfyui-preset",
   "version": 1,
   "id": "v7map-qwen21-edit-ref2",
   "platformPresetId": "qwen21-edit-ref2",
   "title": "千问2.1 改图（主图 + 2 张参考图）",
   "category": "",
   "provider": "comfyui",
   "sourceKind": "comfyui",
   "sourceName": "ComfyUI V7 映射",
   "source": "comfyui-v7-mapping",
   "migrationState": "comfyui-mapped",
   "needsReview": false,
   "content": "",
   "workflow": {
    "1": {
     "class_type": "UNETLoader",
     "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
     }
    },
    "2": {
     "class_type": "QwenImage21Cache",
     "inputs": {
      "model": [
       "1",
       0
      ],
      "device": "auto",
      "dtype": "default"
     }
    },
    "3": {
     "class_type": "CLIPLoader",
     "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
     }
    },
    "4": {
     "class_type": "VAELoader",
     "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
     }
    },
    "9": {
     "class_type": "VAEDecode",
     "inputs": {
      "samples": [
       "8",
       0
      ],
      "vae": [
       "4",
       0
      ]
     }
    },
    "10": {
     "class_type": "V7MapOutput",
     "inputs": {
      "images": [
       "9",
       0
      ]
     }
    },
    "20": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": 1024,
      "key": "resolution",
      "label": "画质（长边 1024=1K / 2048=2K）",
      "min": 1024,
      "max": 2048,
      "role": "分辨率(计价)"
     },
     "_meta": {
      "title": "V7 参数·画质"
     }
    },
    "22": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": -1,
      "key": "seed",
      "label": "种子",
      "min": -1,
      "max": 9007199254740991,
      "role": "种子"
     },
     "_meta": {
      "title": "V7 参数·种子"
     }
    },
    "5": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "主图(PS抓图)",
      "v7_order": 1
     }
    },
    "6": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "5",
       0
      ],
      "max_side": [
       "20",
       0
      ],
      "max_pixels": 0
     }
    },
    "8": {
     "class_type": "KSampler",
     "inputs": {
      "model": [
       "2",
       0
      ],
      "seed": [
       "22",
       0
      ],
      "steps": 25,
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0,
      "positive": [
       "7",
       0
      ],
      "negative": [
       "7",
       1
      ],
      "latent_image": [
       "7",
       2
      ]
     }
    },
    "21": {
     "class_type": "V7MapPrompt",
     "inputs": {
      "value": "",
      "role": "正向(软件输入框)",
      "key": "extraText",
      "label": "改图要求",
      "max_chars": 2000
     },
     "_meta": {
      "title": "V7 提示词"
     }
    },
    "41": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 2
     },
     "_meta": {
      "title": "V7 参考图 1"
     }
    },
    "51": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "41",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "42": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 3
     },
     "_meta": {
      "title": "V7 参考图 2"
     }
    },
    "52": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "42",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "7": {
     "class_type": "TextEncodeQwenImage21",
     "inputs": {
      "clip": [
       "3",
       0
      ],
      "vae": [
       "4",
       0
      ],
      "images.image_1": [
       "6",
       0
      ],
      "prompt": [
       "21",
       0
      ],
      "negative_prompt": "",
      "resolution": 0,
      "images.image_2": [
       "51",
       0
      ],
      "images.image_3": [
       "52",
       0
      ]
     }
    }
   },
   "inputNodeIds": [
    "5"
   ],
   "referenceNodeIds": [
    "41",
    "42"
   ],
   "outputNodeIds": [
    "10"
   ],
   "promptBindings": [],
   "parameterBindings": [
    {
     "key": "resolution",
     "nodeId": "20",
     "input": "value",
     "type": "number",
     "label": "画质（长边 1024=1K / 2048=2K）",
     "min": 1024,
     "max": 2048,
     "step": 1,
     "integer": true,
     "default": 1024
    },
    {
     "key": "positivePrompt",
     "nodeId": "21",
     "input": "value",
     "type": "string",
     "label": "改图要求",
     "editor": "textarea",
     "transient": true,
     "default": "",
     "source": "prompt",
     "maxLength": 2000
    },
    {
     "key": "seed",
     "nodeId": "22",
     "input": "value",
     "type": "number",
     "label": "种子",
     "min": -1,
     "max": 9007199254740991,
     "step": 1,
     "integer": true,
     "randomizeWhen": -1,
     "default": -1
    }
   ],
   "batchBinding": null,
   "parameters": {
    "resolution": 1024,
    "seed": -1
   },
   "mapping": {
    "version": 1,
    "workflowSha256": "160959c4ba2451b234b0c56280d17e83d9a0d9fdfc699c12c7b6b040b4d6a32f"
   }
  },
  "ref3": {
   "schema": "wheelchair-v7-comfyui-preset",
   "version": 1,
   "id": "v7map-qwen21-edit-ref3",
   "platformPresetId": "qwen21-edit-ref3",
   "title": "千问2.1 改图（主图 + 3 张参考图）",
   "category": "",
   "provider": "comfyui",
   "sourceKind": "comfyui",
   "sourceName": "ComfyUI V7 映射",
   "source": "comfyui-v7-mapping",
   "migrationState": "comfyui-mapped",
   "needsReview": false,
   "content": "",
   "workflow": {
    "1": {
     "class_type": "UNETLoader",
     "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
     }
    },
    "2": {
     "class_type": "QwenImage21Cache",
     "inputs": {
      "model": [
       "1",
       0
      ],
      "device": "auto",
      "dtype": "default"
     }
    },
    "3": {
     "class_type": "CLIPLoader",
     "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
     }
    },
    "4": {
     "class_type": "VAELoader",
     "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
     }
    },
    "9": {
     "class_type": "VAEDecode",
     "inputs": {
      "samples": [
       "8",
       0
      ],
      "vae": [
       "4",
       0
      ]
     }
    },
    "10": {
     "class_type": "V7MapOutput",
     "inputs": {
      "images": [
       "9",
       0
      ]
     }
    },
    "20": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": 1024,
      "key": "resolution",
      "label": "画质（长边 1024=1K / 2048=2K）",
      "min": 1024,
      "max": 2048,
      "role": "分辨率(计价)"
     },
     "_meta": {
      "title": "V7 参数·画质"
     }
    },
    "22": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": -1,
      "key": "seed",
      "label": "种子",
      "min": -1,
      "max": 9007199254740991,
      "role": "种子"
     },
     "_meta": {
      "title": "V7 参数·种子"
     }
    },
    "5": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "主图(PS抓图)",
      "v7_order": 1
     }
    },
    "6": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "5",
       0
      ],
      "max_side": [
       "20",
       0
      ],
      "max_pixels": 0
     }
    },
    "8": {
     "class_type": "KSampler",
     "inputs": {
      "model": [
       "2",
       0
      ],
      "seed": [
       "22",
       0
      ],
      "steps": 25,
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0,
      "positive": [
       "7",
       0
      ],
      "negative": [
       "7",
       1
      ],
      "latent_image": [
       "7",
       2
      ]
     }
    },
    "21": {
     "class_type": "V7MapPrompt",
     "inputs": {
      "value": "",
      "role": "正向(软件输入框)",
      "key": "extraText",
      "label": "改图要求",
      "max_chars": 2000
     },
     "_meta": {
      "title": "V7 提示词"
     }
    },
    "41": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 2
     },
     "_meta": {
      "title": "V7 参考图 1"
     }
    },
    "51": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "41",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "42": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 3
     },
     "_meta": {
      "title": "V7 参考图 2"
     }
    },
    "52": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "42",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "43": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 4
     },
     "_meta": {
      "title": "V7 参考图 3"
     }
    },
    "53": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "43",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "7": {
     "class_type": "TextEncodeQwenImage21",
     "inputs": {
      "clip": [
       "3",
       0
      ],
      "vae": [
       "4",
       0
      ],
      "images.image_1": [
       "6",
       0
      ],
      "prompt": [
       "21",
       0
      ],
      "negative_prompt": "",
      "resolution": 0,
      "images.image_2": [
       "51",
       0
      ],
      "images.image_3": [
       "52",
       0
      ],
      "images.image_4": [
       "53",
       0
      ]
     }
    }
   },
   "inputNodeIds": [
    "5"
   ],
   "referenceNodeIds": [
    "41",
    "42",
    "43"
   ],
   "outputNodeIds": [
    "10"
   ],
   "promptBindings": [],
   "parameterBindings": [
    {
     "key": "resolution",
     "nodeId": "20",
     "input": "value",
     "type": "number",
     "label": "画质（长边 1024=1K / 2048=2K）",
     "min": 1024,
     "max": 2048,
     "step": 1,
     "integer": true,
     "default": 1024
    },
    {
     "key": "positivePrompt",
     "nodeId": "21",
     "input": "value",
     "type": "string",
     "label": "改图要求",
     "editor": "textarea",
     "transient": true,
     "default": "",
     "source": "prompt",
     "maxLength": 2000
    },
    {
     "key": "seed",
     "nodeId": "22",
     "input": "value",
     "type": "number",
     "label": "种子",
     "min": -1,
     "max": 9007199254740991,
     "step": 1,
     "integer": true,
     "randomizeWhen": -1,
     "default": -1
    }
   ],
   "batchBinding": null,
   "parameters": {
    "resolution": 1024,
    "seed": -1
   },
   "mapping": {
    "version": 1,
    "workflowSha256": "5c5558a29383f89fbc252ed220c0e18678491e12abda620fe85206a2fc95699e"
   }
  },
  "ref4": {
   "schema": "wheelchair-v7-comfyui-preset",
   "version": 1,
   "id": "v7map-qwen21-edit-ref4",
   "platformPresetId": "qwen21-edit-ref4",
   "title": "千问2.1 改图（主图 + 4 张参考图）",
   "category": "",
   "provider": "comfyui",
   "sourceKind": "comfyui",
   "sourceName": "ComfyUI V7 映射",
   "source": "comfyui-v7-mapping",
   "migrationState": "comfyui-mapped",
   "needsReview": false,
   "content": "",
   "workflow": {
    "1": {
     "class_type": "UNETLoader",
     "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
     }
    },
    "2": {
     "class_type": "QwenImage21Cache",
     "inputs": {
      "model": [
       "1",
       0
      ],
      "device": "auto",
      "dtype": "default"
     }
    },
    "3": {
     "class_type": "CLIPLoader",
     "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
     }
    },
    "4": {
     "class_type": "VAELoader",
     "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
     }
    },
    "9": {
     "class_type": "VAEDecode",
     "inputs": {
      "samples": [
       "8",
       0
      ],
      "vae": [
       "4",
       0
      ]
     }
    },
    "10": {
     "class_type": "V7MapOutput",
     "inputs": {
      "images": [
       "9",
       0
      ]
     }
    },
    "20": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": 1024,
      "key": "resolution",
      "label": "画质（长边 1024=1K / 2048=2K）",
      "min": 1024,
      "max": 2048,
      "role": "分辨率(计价)"
     },
     "_meta": {
      "title": "V7 参数·画质"
     }
    },
    "22": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": -1,
      "key": "seed",
      "label": "种子",
      "min": -1,
      "max": 9007199254740991,
      "role": "种子"
     },
     "_meta": {
      "title": "V7 参数·种子"
     }
    },
    "5": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "主图(PS抓图)",
      "v7_order": 1
     }
    },
    "6": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "5",
       0
      ],
      "max_side": [
       "20",
       0
      ],
      "max_pixels": 0
     }
    },
    "8": {
     "class_type": "KSampler",
     "inputs": {
      "model": [
       "2",
       0
      ],
      "seed": [
       "22",
       0
      ],
      "steps": 25,
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0,
      "positive": [
       "7",
       0
      ],
      "negative": [
       "7",
       1
      ],
      "latent_image": [
       "7",
       2
      ]
     }
    },
    "21": {
     "class_type": "V7MapPrompt",
     "inputs": {
      "value": "",
      "role": "正向(软件输入框)",
      "key": "extraText",
      "label": "改图要求",
      "max_chars": 2000
     },
     "_meta": {
      "title": "V7 提示词"
     }
    },
    "41": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 2
     },
     "_meta": {
      "title": "V7 参考图 1"
     }
    },
    "51": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "41",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "42": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 3
     },
     "_meta": {
      "title": "V7 参考图 2"
     }
    },
    "52": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "42",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "43": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 4
     },
     "_meta": {
      "title": "V7 参考图 3"
     }
    },
    "53": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "43",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "44": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 5
     },
     "_meta": {
      "title": "V7 参考图 4"
     }
    },
    "54": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "44",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "7": {
     "class_type": "TextEncodeQwenImage21",
     "inputs": {
      "clip": [
       "3",
       0
      ],
      "vae": [
       "4",
       0
      ],
      "images.image_1": [
       "6",
       0
      ],
      "prompt": [
       "21",
       0
      ],
      "negative_prompt": "",
      "resolution": 0,
      "images.image_2": [
       "51",
       0
      ],
      "images.image_3": [
       "52",
       0
      ],
      "images.image_4": [
       "53",
       0
      ],
      "images.image_5": [
       "54",
       0
      ]
     }
    }
   },
   "inputNodeIds": [
    "5"
   ],
   "referenceNodeIds": [
    "41",
    "42",
    "43",
    "44"
   ],
   "outputNodeIds": [
    "10"
   ],
   "promptBindings": [],
   "parameterBindings": [
    {
     "key": "resolution",
     "nodeId": "20",
     "input": "value",
     "type": "number",
     "label": "画质（长边 1024=1K / 2048=2K）",
     "min": 1024,
     "max": 2048,
     "step": 1,
     "integer": true,
     "default": 1024
    },
    {
     "key": "positivePrompt",
     "nodeId": "21",
     "input": "value",
     "type": "string",
     "label": "改图要求",
     "editor": "textarea",
     "transient": true,
     "default": "",
     "source": "prompt",
     "maxLength": 2000
    },
    {
     "key": "seed",
     "nodeId": "22",
     "input": "value",
     "type": "number",
     "label": "种子",
     "min": -1,
     "max": 9007199254740991,
     "step": 1,
     "integer": true,
     "randomizeWhen": -1,
     "default": -1
    }
   ],
   "batchBinding": null,
   "parameters": {
    "resolution": 1024,
    "seed": -1
   },
   "mapping": {
    "version": 1,
    "workflowSha256": "b34d5b385d33848ed9a34e46a5fb9f4644ded8b67dcb26de1d1aec05806fe6a6"
   }
  },
  "ref5": {
   "schema": "wheelchair-v7-comfyui-preset",
   "version": 1,
   "id": "v7map-qwen21-edit-ref5",
   "platformPresetId": "qwen21-edit-ref5",
   "title": "千问2.1 改图（主图 + 5 张参考图）",
   "category": "",
   "provider": "comfyui",
   "sourceKind": "comfyui",
   "sourceName": "ComfyUI V7 映射",
   "source": "comfyui-v7-mapping",
   "migrationState": "comfyui-mapped",
   "needsReview": false,
   "content": "",
   "workflow": {
    "1": {
     "class_type": "UNETLoader",
     "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
     }
    },
    "2": {
     "class_type": "QwenImage21Cache",
     "inputs": {
      "model": [
       "1",
       0
      ],
      "device": "auto",
      "dtype": "default"
     }
    },
    "3": {
     "class_type": "CLIPLoader",
     "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
     }
    },
    "4": {
     "class_type": "VAELoader",
     "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
     }
    },
    "9": {
     "class_type": "VAEDecode",
     "inputs": {
      "samples": [
       "8",
       0
      ],
      "vae": [
       "4",
       0
      ]
     }
    },
    "10": {
     "class_type": "V7MapOutput",
     "inputs": {
      "images": [
       "9",
       0
      ]
     }
    },
    "20": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": 1024,
      "key": "resolution",
      "label": "画质（长边 1024=1K / 2048=2K）",
      "min": 1024,
      "max": 2048,
      "role": "分辨率(计价)"
     },
     "_meta": {
      "title": "V7 参数·画质"
     }
    },
    "22": {
     "class_type": "V7MapInt",
     "inputs": {
      "value": -1,
      "key": "seed",
      "label": "种子",
      "min": -1,
      "max": 9007199254740991,
      "role": "种子"
     },
     "_meta": {
      "title": "V7 参数·种子"
     }
    },
    "5": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "主图(PS抓图)",
      "v7_order": 1
     }
    },
    "6": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "5",
       0
      ],
      "max_side": [
       "20",
       0
      ],
      "max_pixels": 0
     }
    },
    "8": {
     "class_type": "KSampler",
     "inputs": {
      "model": [
       "2",
       0
      ],
      "seed": [
       "22",
       0
      ],
      "steps": 25,
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0,
      "positive": [
       "7",
       0
      ],
      "negative": [
       "7",
       1
      ],
      "latent_image": [
       "7",
       2
      ]
     }
    },
    "21": {
     "class_type": "V7MapPrompt",
     "inputs": {
      "value": "",
      "role": "正向(软件输入框)",
      "key": "extraText",
      "label": "改图要求",
      "max_chars": 2000
     },
     "_meta": {
      "title": "V7 提示词"
     }
    },
    "41": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 2
     },
     "_meta": {
      "title": "V7 参考图 1"
     }
    },
    "51": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "41",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "42": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 3
     },
     "_meta": {
      "title": "V7 参考图 2"
     }
    },
    "52": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "42",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "43": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 4
     },
     "_meta": {
      "title": "V7 参考图 3"
     }
    },
    "53": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "43",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "44": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 5
     },
     "_meta": {
      "title": "V7 参考图 4"
     }
    },
    "54": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "44",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "45": {
     "class_type": "V7MapImage",
     "inputs": {
      "image": "example.png",
      "v7_role": "参考图",
      "v7_order": 6
     },
     "_meta": {
      "title": "V7 参考图 5"
     }
    },
    "55": {
     "class_type": "V7MapLimitSize",
     "inputs": {
      "image": [
       "45",
       0
      ],
      "max_side": 1024,
      "max_pixels": 0
     }
    },
    "7": {
     "class_type": "TextEncodeQwenImage21",
     "inputs": {
      "clip": [
       "3",
       0
      ],
      "vae": [
       "4",
       0
      ],
      "images.image_1": [
       "6",
       0
      ],
      "prompt": [
       "21",
       0
      ],
      "negative_prompt": "",
      "resolution": 0,
      "images.image_2": [
       "51",
       0
      ],
      "images.image_3": [
       "52",
       0
      ],
      "images.image_4": [
       "53",
       0
      ],
      "images.image_5": [
       "54",
       0
      ],
      "images.image_6": [
       "55",
       0
      ]
     }
    }
   },
   "inputNodeIds": [
    "5"
   ],
   "referenceNodeIds": [
    "41",
    "42",
    "43",
    "44",
    "45"
   ],
   "outputNodeIds": [
    "10"
   ],
   "promptBindings": [],
   "parameterBindings": [
    {
     "key": "resolution",
     "nodeId": "20",
     "input": "value",
     "type": "number",
     "label": "画质（长边 1024=1K / 2048=2K）",
     "min": 1024,
     "max": 2048,
     "step": 1,
     "integer": true,
     "default": 1024
    },
    {
     "key": "positivePrompt",
     "nodeId": "21",
     "input": "value",
     "type": "string",
     "label": "改图要求",
     "editor": "textarea",
     "transient": true,
     "default": "",
     "source": "prompt",
     "maxLength": 2000
    },
    {
     "key": "seed",
     "nodeId": "22",
     "input": "value",
     "type": "number",
     "label": "种子",
     "min": -1,
     "max": 9007199254740991,
     "step": 1,
     "integer": true,
     "randomizeWhen": -1,
     "default": -1
    }
   ],
   "batchBinding": null,
   "parameters": {
    "resolution": 1024,
    "seed": -1
   },
   "mapping": {
    "version": 1,
    "workflowSha256": "410439aa165a50bc82b6b1c9cbd8253576020dcc27a03ca2972a5c7f4fc91961"
   }
  }
 }
};
