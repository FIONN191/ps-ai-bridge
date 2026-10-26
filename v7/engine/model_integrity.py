"""Explicit model checks; a computed digest is not a trusted source digest."""
import gc
import hashlib
import os
import re


def fingerprint(path):
    stat = os.stat(path)
    return (os.path.realpath(path), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def inspect_model(path, expected=None):
    before = fingerprint(path)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    value = digest.hexdigest()
    result = {"sha256": value, "integrity": "unverified", "validation": "not_checked",
              "verificationNote": "已计算文件摘要；没有可信来源摘要，尚不能确认文件与原版一致。"}
    if expected is not None:
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
            raise ValueError("模型目录中的可信摘要配置无效")
        if value != expected.lower():
            raise ValueError("文件 SHA256 与可信来源不符，请重新获取原版文件")
        result.update(integrity="verified", verificationNote="文件 SHA256 与可信来源一致。")
    # Validate ONNX with its runtime on CPU, without allocating GPU memory or executing inference.
    if path.lower().endswith(".onnx"):
        try:
            import onnxruntime as ort
        except ImportError:
            result["validation"] = "runtime_missing"
            result["verificationNote"] += " 尚缺 ONNX Runtime，未检查模型结构。"
        else:
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            options.enable_mem_pattern = False
            session = None
            try:
                session = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
                if not session.get_inputs() or not session.get_outputs():
                    raise ValueError("模型缺少输入或输出")
                result["validation"] = "load_checked"
                result["verificationNote"] += " ONNX 结构加载检查通过，尚未执行推理。"
            finally:
                del session
                gc.collect()
    elif path.lower().endswith(".safetensors"):
        try:
            from safetensors import safe_open
        except ImportError:
            result["validation"] = "runtime_missing"
            result["verificationNote"] += " 尚缺 safetensors，未检查模型结构。"
        else:
            with safe_open(path, framework="numpy") as handle:
                if not list(handle.keys()):
                    raise ValueError("模型不包含张量")
            result["validation"] = "structure_checked"
            result["verificationNote"] += " 张量文件结构检查通过，尚未加载推理模型。"
    else:
        result["verificationNote"] += " 此格式仅检查摘要，不加载可执行的模型内容。"
    if fingerprint(path) != before:
        raise ValueError("检查期间模型文件发生变化，请等待复制完成后重试")
    return result
