"""独立环境的「加速层」：装 CUDA 版 PyTorch，让 4 个要显卡的模型能用。

═══════════════════════════════════════════════════════════════════════════
 这个文件解决的是【唯一】那个拦路的问题
═══════════════════════════════════════════════════════════════════════════

2026-10-08 实测（这台机器）：
  · 隔离环境里【没装 torch】→ 引擎探到 caps.torch=false caps.cuda=false
  · 引擎于是把这 4 个模型标成 broken：
      segment-sapiens  人体解析 / matte-vitmatte 细边 /
      sam3-text 文字选区 / tween-base 过渡帧
  · 它们的【文件一个都不缺】（跑引擎自己的 MODELS 表读过：ok=16 broken=0 missing=0）
  · 于是档位掉成 0：细边 0 / 文字选区 0 / 过渡帧 0，加速档永远"未装"
  ⇒ 缺口只有 torch 一个。装上，整条链一起亮。

⚠⚠ 三条铁律（不许违反）
  1. **不碰 requirements.txt**。基础依赖清单是被 sha256 钉死的（Manager.digest），
     动它会让【所有已装好的用户环境】判定为 ENVIRONMENT_BROKEN、被迫重装。
     加速层走独立的 marker，只增不改。
  2. **不猜版本**。候选（torch 版本 + CUDA 通道）从高到低挨个试，
     每个都先用 `pip --dry-run` 问 pip"这个组合在本机装得上吗"，
     装得上才真装。问不出来就往下退，而不是硬装一个可能不兼容的。
  3. **装完必须真验证**：`torch.cuda.is_available()` 要 True 且能摸到设备。
     只要这一条不过，就【不算装好】（状态记 pending + 记原因），
     绝不让用户看到"已就绪"却发现跑不动。

为什么候选要挨个试（而不是写死一个）：
  · 引擎 matting_server.py:79 的注释记着一次真实事故：
    ORT 1.29 要 CUDA 13，而机器上 torch 自带的是 CUDA 12.8，文件名对不上、白折腾。
  ⇒ 说明这台机器上"哪个组合配得上"是会变的，所以要问本机 pip，不许凭记忆写死。
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# ⚠ 只认这个下限：低于它的 CUDA 带不动 0.8B 的人体解析（引擎注释里写过 0.8B 纯 CPU 要几十秒）
MIN_COMPUTE = (7, 0)

# 加速层的标记文件名（跟基础环境的 .v7-environment.json 并列，互不覆盖）
ACCEL_MARKER = ".v7-accel.json"

# pip 找 CUDA 轮子的地方
TORCH_INDEX = "https://download.pytorch.org/whl/{channel}"

# ── 候选：从新到旧、从高到低 ──────────────────────────────────────────────
# ⚠⚠ 2026-10-08 改成【先问官方源、问不出来才用这份兜底】。
#   为什么不能只留这份写死的清单：它会过期。
#   PyTorch 官方源上的 torch 版本是会被撤掉的（老版本只留几个），
#   而 CUDA 通道也会跟着驱动换代。写死的结果是：**几个月后所有用户的一键加速全部失效，
#   直到我发一个新版软件** —— 而"用户到手就能用、不用等我发版"正是这件事的目的。
#   ⇒ 正常路径：pip index versions torch --index-url <通道> 问出真实可用的版本，取最新几个。
#     这份清单只在"问不出来"时兜底（老 pip / 网络抖动 / 源改版）。
#   ⚠⚠ 通道顺序【不能写死成"从新到旧"】—— 老卡会因此白试一轮、还看不懂为什么。
#     依据是 PyTorch 官方发布说明（2026-01-15）：
#       cu126（12.6.3）：Maxwell 5.0 · Pascal 6.0 · Volta 7.0 · Turing 7.5 · Ampere 8.x · Hopper 9.0
#       cu128（12.8.1）：**Turing 7.5 起** —— 砍掉了 Maxwell / Pascal / Volta
#       https://dev-discuss.pytorch.org/t/dropping-volta-support-from-cuda-12-8-binaries-for-release-2-11/3290
#     ⇒ 老卡（算力 < 7.5）只有一个能用的通道：cu126。
#       按"从新到旧"试的话第一轮 cu128 必然失败，用户看到的是一句看不懂的英文，
#       而不是"你这张卡要退回 cu126"。实际顺序由 channels_for_gpu() 按算力决定。
ACCEL_CHANNELS = ("cu128", "cu126", "cu118")


def channels_for_gpu(gpu, log=None):
    """按这张卡的算力，把通道排成"该先试哪个"的顺序。

    ⚠ 通道和显卡架构是【硬绑定】的，不是"新的一定好"：
      给一张 Pascal（6.1）装 cu128 是【装不上】，不是"装了慢一点"。
    ⚠ 问不出算力（老驱动 / nvidia-smi 没给 compute_cap）时按"从新到旧"排 ——
      这是安全的默认：真不兼容时 pip 会说装不上，我们再退下一档。
    """
    compute = gpu.get("compute") if isinstance(gpu, dict) else None
    if not compute:
        if log:
            log("问不出显卡算力，通道按从新到旧试")
        return ACCEL_CHANNELS
    major, minor = compute[0], compute[1]
    sm = major + minor / 10.0
    if sm >= 7.5:                       # Turing 及以上
        if log:
            log("算力 %d.%d（Turing 及以上）→ 用最新的 cu128" % (major, minor))
        return ("cu128", "cu126", "cu118")
    if log:
        log("算力 %d.%d（比 Turing 老）→ cu128 从 2.11 起不再支持你这代卡，直接用 cu126"
            % (major, minor))
    return ("cu126", "cu118")


# ⚠ 每个通道最多试几个版本。不设上限的话，一个装不上的组合会让用户白等好几轮。
ACCEL_VERSIONS_PER_CHANNEL = 3
# 兜底的已知组合（2026-10-08 实测 cu128 上就是这几个）
ACCEL_FALLBACK_VERSIONS = ("2.11.0", "2.10.0", "2.9.1")


class AccelError(Exception):
    """加速层自己的错误；code 直接给用户看的那句话用。"""

    def __init__(self, message, code="ACCEL_FAILED"):
        super().__init__(message)
        self.code = code


# ⚠ 给用户看的那句话（异常原文只进日志）。和 managed_environment.PUBLIC_ERRORS 同一套词。
PUBLIC_ERRORS = {
    "ACCEL_FAILED": "加速包没装上，细边 / 文字选区 / 过渡帧 / 人体解析还是用不了。可以稍后重试。",
    "ACCEL_NO_GPU": "这台机器没检测到可用的 NVIDIA 显卡，装加速包也没有意义。",
    "ACCEL_NETWORK": "连不上 PyTorch 官方源（要下约 3GB），请检查网络或代理后重试。",
    "ACCEL_NO_BUILD": "PyTorch 官方源上没有适合这台机器的版本，加速档暂时开不了。",
    "ACCEL_VERIFY": "加速包装上了，但验证没通过（摸不到显卡），所以不算装好。请重试或检查显卡驱动。",
    "ACCEL_DISK_LOW": "磁盘空间不够装加速包（约 4.2 GiB），请释放空间后重试。",
    "ACCEL_UNINSTALL": "加速包没拆干净，请重试，或在设置里直接重建独立环境。",
    "ACCEL_NEEDS_ENVIRONMENT": "要先把核心环境准备好，才能装加速包。",
}


# ══════════════════════════════════════════════════════════════════════════
#  ① 探测本机显卡
# ══════════════════════════════════════════════════════════════════════════
def probe_gpu():
    """问 nvidia-smi 要显卡型号 / 显存 / 驱动 / 算力。

    ⚠ 拿不到就【如实说没有】，绝不猜、绝不假装有。
      没有 N 卡 ⇒ 加速层没意义 ⇒ 上层直接报 unavailable，省掉 3GB 下载。
    """
    info = {"present": False, "name": "", "vramGB": 0, "driver": "", "compute": None, "reason": ""}
    exe = shutil.which("nvidia-smi")
    if not exe:
        info["reason"] = "这台机器上没有 nvidia-smi（没有 NVIDIA 显卡驱动）"
        return info
    queries = ("name,memory.total,driver_version,compute_cap", "name,memory.total,driver_version")
    last = ""
    for query in queries:
        try:
            done = subprocess.run(
                [exe, "--query-gpu=%s" % query, "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=20, check=False,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
        except (OSError, subprocess.SubprocessError) as error:
            last = str(error)
            continue
        line = (done.stdout or "").strip().splitlines()
        if done.returncode != 0 or not line:
            last = (done.stderr or "").strip() or ("nvidia-smi 退出码 %s" % done.returncode)
            continue
        parts = [p.strip() for p in line[0].split(",")]
        if len(parts) < 3:
            last = "nvidia-smi 输出看不懂：%s" % line[0]
            continue
        info["present"] = True
        info["name"] = parts[0]
        try:
            info["vramGB"] = round(int(float(parts[1])) / 1024.0, 1)
        except ValueError:
            info["vramGB"] = 0
        info["driver"] = parts[2]
        if len(parts) >= 4:
            matched = re.match(r"(\d+)\.(\d+)", parts[3])
            if matched:
                info["compute"] = (int(matched.group(1)), int(matched.group(2)))
        return info
    info["reason"] = "nvidia-smi 用不了：%s" % (last or "没有可用输出")
    return info


def accel_availability():
    """能不能开加速 -- 给界面用的一句话结论（不下载、不安装，纯探测）。"""
    gpu = probe_gpu()
    if not gpu["present"]:
        return {"available": False, "reason": gpu["reason"], "gpu": gpu}
    if gpu["compute"] and gpu["compute"] < MIN_COMPUTE:
        return {
            "available": False,
            "reason": "显卡算力 %d.%d 太低，PyTorch 官方轮子不支持（要 %d.%d 以上）"
                      % (gpu["compute"][0], gpu["compute"][1], MIN_COMPUTE[0], MIN_COMPUTE[1]),
            "gpu": gpu,
        }
    return {"available": True, "reason": "", "gpu": gpu}


# ══════════════════════════════════════════════════════════════════════════
#  ② 选组合：挨个问 pip --dry-run，"这个装得上吗"
# ══════════════════════════════════════════════════════════════════════════
def _pip_base(python):
    return [str(python), "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-input"]

_PIP_TRANSIENT = ("timed out", "timeout", "connection", "temporarily", "ssl", "proxy", "network", "resolve", "403", "429", "5xx")
# "没有这个版本"和"网络不通"要分开：前者该退下一个候选，后者该直接告诉用户。
_PIP_MISSING = ("no matching distribution", "from versions", "could not find a version")
_VERSION_LINE = re.compile(r"^\s*Available versions:\s*(.+)$", re.MULTILINE)
# ⚠ "2.11.0+cu128" 这种带本地版本号的：pip index 输出的是纯 "2.11.0"，
#   但万一它带了后缀，也要能抠出主版本去拼 spec。
_VERSION_TOKEN = re.compile(r"\b(\d+\.\d+\.\d+)\b")


def _cancelled(error):
    """runner 抛的是宿主那个 Cancelled（用户点了取消）—— 它必须往上抛，不能被当成"候选不匹配"。"""
    return getattr(error, "code", "") == "ENVIRONMENT_CANCELLED"


def _available_versions(python, channel, runner, log):
    """问官方源：这个通道上有哪些 torch 版本。

    ⚠ 问不出来就返回空元组（调用方退回兜底清单）—— **绝不因为"问不到"就放弃整件事**。
    """
    index = TORCH_INDEX.format(channel=channel)
    try:
        output = runner(
            _pip_base(python) + ["index", "versions", "torch", "--index-url", index],
            "index-%s" % channel,
        )
    except Exception as error:
        if _cancelled(error):
            raise
        log("问不到 %s 上有哪些版本（%s），退回兜底清单" % (channel, str(error)[:120]))
        return ()
    matched = _VERSION_LINE.search(str(output or ""))
    if not matched:
        log("问不到 %s 上的版本列表（输出里没有 Available versions 那一行）" % channel)
        return ()
    found = []
    for token in _VERSION_TOKEN.findall(matched.group(1)):
        if token not in found:
            found.append(token)
    if found:
        log("%s 上有这些版本：%s" % (channel, ", ".join(found[:6])))
    return tuple(found[:ACCEL_VERSIONS_PER_CHANNEL])


def candidates(python, runner, log):
    """按"通道从该先试的到后试的、版本从新到旧"铺出候选。

    ⚠ 顺序的语义（2026-10-08 修）：
      · 通道顺序由【这张卡的算力】决定（见 channels_for_gpu）——
        新卡先试 cu128，老卡直接上 cu126（cu128 从 2.11 起不支持它）。
      · 同一通道内先试最新版本，装不上才退老版本。
    """
    gpu = probe_gpu()
    out = []
    for channel in channels_for_gpu(gpu, log):
        versions = _available_versions(python, channel, runner, log)
        if not versions:
            versions = ACCEL_FALLBACK_VERSIONS
        for version in versions:
            if (version, channel) not in out:
                out.append((version, channel))
    return tuple(out)


def resolve(python, runner, log):
    """返回 {"torch": 版本, "channel": 通道, "index": 索引地址}；一个都装不上就抛 AccelError。

    runner(arguments, tag) 由调用方给（它负责超时 / 取消 / 写日志 / 进程归属），
    本模块不自己起进程 —— 这样"取消准备"能连 pip 一起收干净。
    """
    attempts = []
    tried = 0
    for torch_version, channel in candidates(python, runner, log):
        index = TORCH_INDEX.format(channel=channel)
        spec = "torch==%s+%s" % (torch_version, channel)
        arguments = _pip_base(python) + [
            "install", "--only-binary=:all:", "--no-cache-dir", "--timeout", "30", "--retries", "2",
            "--dry-run", "--extra-index-url", index, spec,
        ]
        tried += 1
        log("问 pip：%s（索引 %s）" % (spec, index))
        try:
            runner(arguments, "dry-run-%s-%s" % (torch_version, channel))
        except Exception as error:
            if _cancelled(error):
                raise
            text = str(error)
            attempts.append("%s → %s" % (spec, text))
            lowered = text.lower()
            if any(word in lowered for word in _PIP_TRANSIENT) and not any(word in lowered for word in _PIP_MISSING):
                # ⚠ 网络问题换版本也没用 —— 直接把话说明白（别让用户等一串超时）
                raise AccelError(
                    "连不上 PyTorch 官方源，装不了加速包。请检查网络/代理后重试。原话：%s" % text,
                    "ACCEL_NETWORK",
                )
            continue
        log("  ✔ 装得上：%s" % spec)
        return {"torch": torch_version, "channel": channel, "index": index}
    raise AccelError(
        "试过 %d 个 PyTorch 版本组合，本机一个都装不上。最后一次的原因：%s"
        % (tried, attempts[-1] if attempts else "没有可用输出"),
        "ACCEL_NO_BUILD",
    )


# ══════════════════════════════════════════════════════════════════════════
#  ③ 真装
# ══════════════════════════════════════════════════════════════════════════
def installed(python, runner):
    """环境里现在装的 torch 是什么（没装就 None）。

    ⚠⚠ 2026-10-08：原来这里是 `except Exception: return None` —— 把失败【吞掉了】。
      后果：环境里明明有 torch，一次偶发失败（子进程起不来 / 超时）就让界面显示
      "还没装"，而且日志里一个字都没有，谁都查不出来。
      ⇒ 失败至少要说出来（打一行），让"没装"和"没问出来"能区分开。
    """
    code = (
        "import json\n"
        "try:\n"
        "    import torch\n"
        "    print('ACCEL_INFO=' + json.dumps({\n"
        "        'version': torch.__version__,\n"
        "        'cuda_version': getattr(torch.version, 'cuda', None),\n"
        "        'cuda': bool(torch.cuda.is_available()),\n"
        "        'device': (torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''),\n"
        "        'capability': (list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else None),\n"
        "    }))\n"
        "except Exception:\n"
        "    print('ACCEL_INFO=null')\n"
    )
    try:
        output = runner([str(python), "-I", "-c", code], "accel-info")
    except Exception as error:
        print("[加速] 问 torch 版本没成功：%s" % str(error)[:160])
        return None
    for line in str(output or "").splitlines():
        if line.startswith("ACCEL_INFO="):
            payload = line[len("ACCEL_INFO="):].strip()
            if payload and payload != "null":
                try:
                    return json.loads(payload)
                except ValueError as error:
                    print("[加速] torch 自述解析不了：%s" % str(error)[:160])
                    return None
            print("[加速] 环境里 import torch 失败（ACCEL_INFO=null）")
            return None
    print("[加速] 子进程没有输出 ACCEL_INFO 那一行（输出长度 %d）" % len(str(output or "")))
    return None


def _catch(output):
    """从 runner 的输出里把 ACCEL_* 标记行捞出来。"""
    found = {}
    for line in str(output or "").splitlines():
        for key in ("ACCEL_INFO", "ACCEL_VERIFY", "ACCEL_DEPS"):
            prefix = key + "="
            if line.startswith(prefix):
                found[key] = line[len(prefix):].strip()
    return found


def verify(python, runner, expected_version, log):
    """装完真跑一次 CUDA：这一步不过就【不算装好】。"""
    script = (
        "import sys, json\n"
        "out = {'ok': False, 'reason': '', 'torch': '', 'cuda_version': None,\n"
        "       'cuda': False, 'device': '', 'capability': None, 'vramGB': 0, 'device_count': 0}\n"
        "try:\n"
        "    import torch\n"
        "    out['torch'] = torch.__version__\n"
        "    out['cuda_version'] = getattr(torch.version, 'cuda', None)\n"
        "    out['cuda'] = bool(torch.cuda.is_available())\n"
        "    out['device_count'] = int(torch.cuda.device_count())\n"
        "    if out['cuda']:\n"
        "        out['device'] = torch.cuda.get_device_name(0)\n"
        "        out['capability'] = list(torch.cuda.get_device_capability(0))\n"
        "        out['vramGB'] = round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1)\n"
        "    elif not out['cuda_version']:\n"
        "        out['reason'] = ('装上的 torch 是【CPU 版】（%s），没有 CUDA 支持'\n"
        "                         % torch.__version__)\n"
        "    else:\n"
        "        out['reason'] = ('torch %s 带 CUDA %s，但摸不到显卡（驱动或显存有问题）'\n"
        "                         % (torch.__version__, out['cuda_version']))\n"
        "except Exception as error:\n"
        "    out['reason'] = 'import torch 就失败了：%s' % error\n"
        "if out['cuda']:\n"
        "    out['ok'] = True\n"
        "print('ACCEL_VERIFY=' + json.dumps(out))\n"
    )
    text = runner([str(python), "-I", "-c", script], "accel-verify")
    raw = _catch(text).get("ACCEL_VERIFY")
    if not raw:
        raise AccelError("装完验证没拿到结果（子进程没有输出可读的验证行）", "ACCEL_VERIFY")
    try:
        result = json.loads(raw)
    except ValueError:
        raise AccelError("装完验证的输出看不懂：%s" % raw[:200], "ACCEL_VERIFY")
    if not result.get("ok"):
        raise AccelError(result.get("reason") or "装完验证没通过", "ACCEL_VERIFY")
    if expected_version and not str(result.get("torch", "")).startswith(expected_version):
        # ⚠ 装出来的版本和挑的不是一个：不推翻（它确实能跑 CUDA），但要在日志里留痕
        log("⚠ 实际装上的 torch 是 %s，挑的是 %s" % (result.get("torch"), expected_version))
    log("✔ 验证通过：torch %s / CUDA %s / %s / 算力 %s / 显存 %sGB"
        % (result.get("torch"), result.get("cuda_version"), result.get("device"),
           result.get("capability"), result.get("vramGB")))
    return result


def install(python, root, runner, log, probe_model=None):
    """完整装一遍：PyTorch + ONNX 显卡后端。返回写进 marker 的字典。

    ⚠ 两样都要（见 ORT_BACKENDS 上面的长注释）：
      · PyTorch/CUDA —— 给 Sapiens / SAM3 / ViTMatte / 过渡帧
      · ONNX 显卡 provider —— 给抠像 / 人体解析 / 分割 / SAM2（这些是 ONNX 模型）
      只装 torch 的话，那 4 个新模型活了，但**主力功能还在 CPU 上**。

    probe_model：给一个真的 .onnx 文件路径，ONNX 那边就能"真建会话"验证。
    """
    availability = accel_availability()
    if not availability["available"]:
        raise AccelError(availability["reason"], "ACCEL_NO_GPU")
    gpu = availability["gpu"]

    already = installed(python, runner)
    if already and already.get("cuda"):
        log("环境里已经有能用的 CUDA torch：%s / %s" % (already.get("version"), already.get("device")))
        record = _record(already, gpu)
    else:
        channel = resolve(python, runner, log)
        spec = "torch==%s+%s" % (channel["torch"], channel["channel"])
        log("开始安装 %s（约 3GB，慢慢下，中途可以取消）" % spec)
        runner(
            _pip_base(python) + [
                "install", "--only-binary=:all:", "--no-cache-dir", "--timeout", "30", "--retries", "2",
                "--extra-index-url", channel["index"], spec,
            ],
            "install-torch",
        )
        log("装完了，跑一次真验证（要真摸到显卡才算数）")
        result = verify(python, runner, channel["torch"], log)
        result["channel"] = channel["channel"]
        record = _record(result, gpu)

    # ── ONNX 显卡后端（第二样）─────────────────────────────────────────
    # ⚠ 偏好取 ORT_BACKENDS 的第一个（DirectML）：它零配置、Windows 自带、
    #   对 A 卡/核显/N 卡都能用。CUDA 那个要用户自己装 CUDA 13 + cuDNN 9，
    #   实测在这台机器上装了也回落到 CPU（见 ORT_BACKENDS 上面的长注释）。
    ort = probe_onnx(python, runner) or {}
    preferred = ORT_BACKENDS[0][1]
    if (ort.get("usable") or {}).get(preferred) == preferred:
        log("ONNX 显卡后端已经就绪：%s（%s）" % (preferred, ort.get("package")))
        record["onnxProvider"] = preferred
        record["onnxPackage"] = ort.get("package") or ""
    else:
        backend = install_onnx_backend(python, runner, log, probe_model)
        record["onnxProvider"] = backend["provider"]
        record["onnxPackage"] = backend["package"]
        record["onnxNote"] = backend.get("note") or ""
    return record


def _record(result, gpu):
    """把一次探测/验证的结果整理成 marker 里的样子。

    ⚠⚠ 2026-10-08 修：这个函数原来只读 result["torch"]，而 installed() 返回的键叫
      **"version"**（它是照着 torch.__version__ 的名字来的）——
      于是"复用已有安装"那条路上版本号被静默丢成 ""，界面上写的是
      "已就绪（NVIDIA GeForce RTX 5090 · torch ）"，看着像没装。
      两条路喂进来的形状不一样，这里必须两种键都认。
      （正常路径喂的是 verify() 的结果，键叫 torch，所以一直没暴露。）
    """
    torch_version = result.get("torch") or result.get("version") or ""
    cuda_version = result.get("cuda_version") or result.get("cuda") or ""
    return {
        "torch": str(torch_version),
        "cuda": str(cuda_version),
        "device": str(result.get("device") or gpu.get("name") or ""),
        "capability": result.get("capability"),
        "vramGB": result.get("vramGB") or gpu.get("vramGB") or 0,
        "driver": gpu.get("driver") or "",
        "channel": result.get("channel") or "",
        # ⚠ ONNX 那两样要原样带过去：_record 会被 install 之外的地方调用
        #   （比如自愈、复用已有安装），漏了它们会把 ONNX 后端的信息抹掉。
        "onnxProvider": result.get("onnxProvider") or "",
        "onnxPackage": result.get("onnxPackage") or "",
        "onnxNote": result.get("onnxNote") or "",
    }


# 加速层【自己装进去】的东西。卸载只碰这些名字，绝不 pip uninstall 用户的其它包。
ACCEL_PACKAGES = ("torch", "filelock", "sympy", "networkx", "jinja2", "MarkupSafe", "mpmath", "fsspec")

# ══════════════════════════════════════════════════════════════════════════
#  ONNX 的显卡后端（第二样东西）
# ══════════════════════════════════════════════════════════════════════════
# ☠☠ 2026-10-08 查出来的：基础依赖装的是 `onnxruntime`，而它**只有 CPU provider**。
#   实测（隔离环境 1.30.0）：
#       ort.get_available_providers() = ['AzureExecutionProvider', 'CPUExecutionProvider']
#   而引擎的候选顺序是 DmlExecutionProvider → CUDAExecutionProvider → CPU
#   （multi_engine_server.py:678）—— 前两个都不在 ⇒ **抠像/人体解析/分割/SAM2 全在 CPU 上跑**。
#   引擎文件头写的设计本来是"ONNX(DirectML) 跑老模型，PyTorch(CUDA) 跑新模型"，
#   也就是说：**它一直只实现了后半句**。跟"没装 torch"是同一类缺陷。
#
# ⚠⚠ 换包必须【先卸再装】，不能直接装：
#   `onnxruntime` 和 `onnxruntime-gpu` / `onnxruntime-directml` 是**不同的包名、
#   同一个 import 名**。两个都在 site-packages 里 ⇒ import onnxruntime 会撞上
#   "找不到模块"或加载到错的那个，最后连引擎都起不来。
#   实测：pip install onnxruntime-gpu **不会**自动卸掉 onnxruntime
#   （dry-run 只说 "Would install onnxruntime-gpu-1.30.0"，一个 uninstall 都没提）。
ORT_CPU_PACKAGE = "onnxruntime"
ORT_BACKENDS = (
    # (pip 包名, 要验的 provider, 说明)
    # ⚠⚠ 顺序有意义：**DirectML 排第一**。
    #   实测（这台机器，2026-10-08）onnxruntime-gpu 1.30.0 在启动时报：
    #       Failed to create CUDAExecutionProvider.
    #       Require cuDNN 9.* and CUDA 13.*, and the latest MSVC runtime.
    #   而机器上 torch 自带的是 CUDA 12.8 ⇒ **装上也用不了**，还会把能用的 CPU 版顶掉。
    #   ONNX 的 CUDA provider 依赖的是【系统级】CUDA + cuDNN（要用户自己装、还要配 PATH），
    #   DirectML 是 **Windows 内置**的（随 DirectX 12 走）⇒ 对用户零配置。
    #   而这台机器上 torch 的 CUDA 是打在包里的，跟 ONNX 那条路互不相干
    #   —— "torch 能用显卡"不等于"ONNX 能用显卡"。
    #   ⇒ 先试 DirectML（零配置、面最广），不行再试 CUDA（要系统 CUDA 13）。
    ("onnxruntime-directml", "DmlExecutionProvider", r"任意显卡（DirectML：A 卡 / 核显 / N 卡都能用，Windows 自带）"),
    ("onnxruntime-gpu", "CUDAExecutionProvider", r"NVIDIA 显卡（⚠ 需要系统里装 CUDA 13 + cuDNN 9）"),
)


def probe_onnx(python, runner):
    """问这个环境：onnxruntime 有哪些 provider、【真建一个会话】能不能用显卡，装的是哪个包。

    ⚠⚠ 2026-10-08 教训（这条差点让我把一个坏环境当成好的交给用户）：
      最开始的版本只读 ort.get_available_providers()，看到列表里有
      CUDAExecutionProvider 就判"✔ 就绪"。结果引擎一起来就报：
          Failed to create CUDAExecutionProvider.
          Require cuDNN 9.* and CUDA 13.*
      ——**provider "在列表里"和"真能用"是两件事**：
        列表来自编译期（onnxruntime-gpu 包里就有这个 .dll），
        真正加载要系统盘上有 CUDA 13 + cuDNN 9。
      ⇒ 判据改成【真建一个会话，看它最终落到哪个 provider】——
        和引擎自己挑 provider 的办法一模一样（multi_engine_server.py:681）。
        这样才是"实测"，不是"看名单"。
    """
    code = (
        "import json\n"
        "out = {'installed': False, 'providers': [], 'package': '', 'usable': {}}\n"
        "try:\n"
        "    import onnxruntime as ort\n"
        "    out['installed'] = True\n"
        "    out['providers'] = list(ort.get_available_providers())\n"
        "    out['version'] = ort.__version__\n"
        "    for pkg in ('onnxruntime-directml', 'onnxruntime-gpu', 'onnxruntime'):\n"
        "        try:\n"
        "            from importlib.metadata import distribution\n"
        "            distribution(pkg)\n"
        "            out['package'] = pkg\n"
        "            break\n"
        "        except Exception:\n"
        "            continue\n"
        "    # 真建会话：拿当前目录能拿到的【最小】模型试，它加载最快\n"
        "    import glob, os\n"
        "    probe = os.environ.get('V7_ORT_PROBE', '')\n"
        "    if not probe or not os.path.isfile(probe):\n"
        "        probe = ''\n"
        "    if probe:\n"
        "        so = ort.SessionOptions()\n"
        "        so.log_severity_level = 4\n"
        "        for p in ('DmlExecutionProvider', 'CUDAExecutionProvider', 'CPUExecutionProvider'):\n"
        "            if p not in out['providers']:\n"
        "                out['usable'][p] = '不在可用列表里'\n"
        "                continue\n"
        "            try:\n"
        "                session = ort.InferenceSession(probe, sess_options=so, providers=[p])\n"
        "                got = session.get_providers()[0]\n"
        "                del session\n"
        "                out['usable'][p] = got\n"
        "            except Exception as error:\n"
        "                out['usable'][p] = 'FAIL: ' + str(error)[:160]\n"
        "except Exception as error:\n"
        "    out['reason'] = str(error)[:200]\n"
        "print('ONNX_INFO=' + json.dumps(out))\n"
    )
    try:
        output = runner([str(python), "-I", "-c", code], "onnx-info")
    except Exception as error:
        print("[加速] 问 onnxruntime 情况没成功：%s" % str(error)[:160])
        return None
    for line in str(output or "").splitlines():
        if line.startswith("ONNX_INFO="):
            try:
                return json.loads(line[len("ONNX_INFO="):].strip())
            except ValueError:
                return None
    return None


def onnx_provider_works(python, runner, provider, probe_model=None):
    """这个 provider 在这台机器上【真的能用】吗（真建会话，落点也必须是它）。

    返回 (能用吗, 说明)。⚠ probe_model 没给就只做"包在不在"这种弱判断 ——
    调用方必须知道自己在做弱判断，不能拿它当"已验证"。
    """
    info = probe_onnx(python, runner) or {}
    if provider not in (info.get("providers") or []):
        return False, "provider 不在可用列表里（装的是 %s）" % (info.get("package") or "未知包")
    usable = (info.get("usable") or {}).get(provider)
    if usable is None:
        # 没给探针模型 ⇒ 只能弱判断
        return True, "只能确认它在可用列表里（没有探针模型，没建会话实测）"
    if usable == provider:
        return True, "实测建会话落在 %s" % provider
    return False, "建会话没能用上它：%s" % usable


def install_onnx_backend(python, runner, log, probe_model=None):
    """把 ONNX 的 CPU provider 换成显卡 provider。

    ⚠ 顺序讲究：**先装新的、验通了、再卸旧的**（而不是先卸）。
      先卸的话，中间任何一步失败（网络断、轮子装不上）都会让用户
      **连 CPU 都用不成** —— 那是把"慢"换成"坏"，比不装更糟。
      ⚠ 但"两个共存"也不行（同一个 import 名会撞）。
      ⇒ 所以：先卸 CPU 版（它已经在 requirements 里钉着，随时能装回来）
        → 装显卡版 → **真建会话**验证落到那个 provider
        → 验不过就把 CPU 版装回去（不留一个起不来的环境）。

    probe_model 给的话，验证是"真建会话"；没给就是弱判断（见 onnx_provider_works）。
    """
    info = probe_onnx(python, runner) or {}
    already_ok = []
    for _package, provider, _note in ORT_BACKENDS:
        if provider in (info.get("usable") or {}) and (info["usable"][provider] == provider):
            already_ok.append(provider)
    if already_ok:
        package = info.get("package") or ""
        log("ONNX 显卡后端已经能用了：%s（%s）" % (already_ok[0], package))
        return {"package": package, "provider": already_ok[0], "note": "已经就绪"}

    gpu = probe_gpu()
    usable = []
    for package, provider, note in ORT_BACKENDS:
        if provider == "CUDAExecutionProvider" and not gpu["present"]:
            continue          # 没 N 卡就别碰 CUDA 那个包
        usable.append((package, provider, note))
    if not usable:
        log("没有可用的显卡，ONNX 保持 CPU 版")
        return {"package": ORT_CPU_PACKAGE, "provider": "CPUExecutionProvider", "note": "没有可用的显卡"}

    pip = _pip_base(python)
    last = ""
    for package, provider, note in usable:
        log("装 ONNX 显卡后端：%s（%s）" % (package, note))
        # ① 先卸掉 CPU 版（不同包名、同一个 import 名，必须腾位置）
        try:
            runner(pip + ["uninstall", "-y", ORT_CPU_PACKAGE], "uninstall-onnx-cpu")
        except Exception as error:
            log("  卸 %s 时有点问题（继续）：%s" % (ORT_CPU_PACKAGE, str(error)[:140]))
        # ② 装显卡版
        try:
            runner(pip + ["install", "--only-binary=:all:", "--no-cache-dir", "--timeout", "30",
                          "--retries", "2", package], "install-" + package)
        except Exception as error:
            last = str(error)[:200]
            log("  %s 装不上：%s" % (package, last))
            continue
        # ③ 真建会话验证（装了 ≠ 能用；provider 在列表里 ≠ 能用）
        works, why = onnx_provider_works(python, runner, provider, probe_model)
        if works:
            log("  ✔ %s 就绪：%s" % (package, why))
            return {"package": package, "provider": provider, "note": why}
        last = "%s 装了但用不了：%s" % (package, why)
        log("  ✘ " + last)
        # ④ 这个包留在环境里只会碍事（它顶掉了 CPU 版却用不了）⇒ 先卸掉再试下一个
        try:
            runner(pip + ["uninstall", "-y", package], "uninstall-" + package)
        except Exception as error:
            log("  卸 %s 时有点问题（继续）：%s" % (package, str(error)[:140]))

    # ⑤ 一个都没成 ⇒ 把 CPU 版装回去，别让用户停在一个起不来的环境
    log("显卡后端都没成，把 CPU 版装回去（环境要能用）")
    try:
        runner(pip + ["install", "--only-binary=:all:", "--no-cache-dir", "--timeout", "30",
                      "--retries", "2", "--index-url", "https://pypi.org/simple", ORT_CPU_PACKAGE],
               "restore-onnx-cpu")
    except Exception as error:
        log("⚠ 连 CPU 版都没装回来：%s" % str(error)[:160])
    return {"package": ORT_CPU_PACKAGE, "provider": "CPUExecutionProvider", "note": last or "显卡后端不可用"}


def uninstall(python, environment_directory, runner, log):
    """关掉加速：把加速层装进去的东西拆掉，并把 marker 清掉。

    ⚠ 为什么要整包卸载（而不是只清 marker）：
       只清 marker 的话，torch 还在环境里，引擎一探 CAPS.torch 还是 true ——
       用户点了"关闭加速"却发现档位照旧，那是骗人。
    ⚠ 卸载是幂等的：没装就什么都不做、直接成功。
    ⚠ ONNX 那边是"换回去"而不是"删掉"：引擎必须有 onnxruntime 才能跑，
      所以拆掉显卡版之后要把 CPU 版装回来（见 ORT_BACKENDS 上面的注释）。
    """
    current = installed(python, runner)
    log("正在拆加速包…")
    # ⚠ 一个个 uninstall，允许"某个包不存在"（pip 会返回非 0）——
    #   所以这里不能用 runner 的失败即抛语义，而是把它当成"没这个包，跳过"。
    for name in ACCEL_PACKAGES:
        try:
            runner([str(python), "-I", "-m", "pip", "--isolated", "--disable-pip-version-check",
                    "--no-input", "uninstall", "-y", name], "uninstall-" + name)
        except Exception as error:
            log("  %s 跳过（%s）" % (name, str(error)[:120]))

    # ── ONNX 换回 CPU 版 ────────────────────────────────────────────────
    # ⚠⚠ 2026-10-08：这一步【允许失败】，不能让它把整个"关闭加速"顶掉。
    #   为什么：Windows 上换 onnxruntime 要覆盖 capi\*.dll，只要还有进程占着
    #   （引擎、torch 子进程、甚至只是句柄没释放），pip 就 WinError 5 拒绝访问。
    #   实测过一次：引擎在跑时 pip 换 ONNX 后端必失败。
    #   ⇒ 宿主已经在关闭加速前先停引擎了（main.rs 的 removeaccel 分支），
    #     但"停干净"和"文件句柄真释放"之间还有时间差 ⇒ 这里必须容错：
    #     换不回去就【在日志里说清楚、继续往下走】，让 marker 被清掉、
    #     界面如实显示"加速档没装"，而不是弹一个看不懂的错、什么都不做。
    ort = probe_onnx(python, runner) or {}
    if ort.get("package") not in (ORT_CPU_PACKAGE, "", None):
        for package, _provider, _note in ORT_BACKENDS:
            try:
                runner([str(python), "-I", "-m", "pip", "--isolated", "--disable-pip-version-check",
                        "--no-input", "uninstall", "-y", package], "uninstall-" + package)
            except Exception as error:
                log("  %s 跳过（%s）" % (package, str(error)[:120]))
        log("把 ONNX 装回 CPU 版")
        try:
            runner([str(python), "-I", "-m", "pip", "--isolated", "--disable-pip-version-check",
                    "--no-input", "install", "--only-binary=:all:", "--no-cache-dir", "--timeout", "30",
                    "--retries", "2", "--index-url", "https://pypi.org/simple", ORT_CPU_PACKAGE],
                   "restore-onnx-cpu")
        except Exception as error:
            log("⚠ ONNX 没换回 CPU 版（多半是还有进程占着它的 .dll）：%s" % str(error)[:200])
            log("  ⇒ 引擎下次启动会用当前这个包；如果起不来，点「准备环境」重建一次即可。")

    # ── windows 上 pip uninstall 会留残骸（文件被占用时改名成 ~xxx 再删，删不掉就留着）──
    # ⚠ 不清的话：4GB 的残骸留在磁盘上，而且下次装会因为目录已存在而报错。
    leftovers = cleanup_leftovers(environment_directory, log)

    left = installed(python, runner)
    if left:
        raise AccelError(
            "加速包没拆干净（还能 import 到 torch %s）。请重试，或在设置里直接重建独立环境。"
            % left.get("version"), "ACCEL_UNINSTALL")
    if leftovers:
        raise AccelError(
            "加速包拆掉了，但有 %d 个残骸目录删不掉（多半还有进程占着）。"
            "请先关掉正在跑的引擎再试一次。" % leftovers, "ACCEL_UNINSTALL")
    clear_marker(environment_directory)
    log("加速包已拆掉，环境回到只用处理器的状态")
    return {"removed": bool(current), "reason": ""}


def cleanup_leftovers(environment_directory, log):
    """清 pip 卸载留下的 `~xxx` 残骸目录。返回没删掉的个数。

    ⚠ 为什么专门做这件事：Windows 上 pip 卸载大包（torch 4GB）时，
      文件被进程占用 ⇒ pip 把目录【改名】成 `~orch` 再删，改名成功、删除失败，
      于是留下一个 4GB 的 `~orch`。它既不被 import 到（不叫 torch 了），
      又占着 4GB，还会让下一次安装出怪问题。
    ⚠ 只删"以 ~ 开头的目录"，而且必须在 site-packages 里 —— 不许误删别的东西。
    """
    import shutil as _shutil
    site = Path(environment_directory) / ("Lib/site-packages" if os.name == "nt" else "lib/python%d.%d/site-packages" % sys.version_info[:2])
    if not site.is_dir():
        return 0
    failed = 0
    for entry in site.iterdir():
        if not entry.is_dir() or not entry.name.startswith("~"):
            continue
        try:
            _shutil.rmtree(entry)
            log("清掉卸载残骸：%s" % entry.name)
        except OSError as error:
            failed += 1
            log("残骸删不掉（被占用）：%s —— %s" % (entry.name, str(error)[:120]))
    return failed


# ══════════════════════════════════════════════════════════════════════════
#  ④ marker 读写 + 状态（给 /health 那个 "accel" 字段用）
# ══════════════════════════════════════════════════════════════════════════
def marker_path(environment_directory):
    return Path(environment_directory) / ACCEL_MARKER


def read_marker(environment_directory):
    path = marker_path(environment_directory)
    try:
        if not path.is_file() or path.stat().st_size > 65536:
            return {}
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_marker(environment_directory, record):
    path = marker_path(environment_directory)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def clear_marker(environment_directory):
    try:
        marker_path(environment_directory).unlink(missing_ok=True)
    except OSError:
        pass


def status(environment_directory, python=None):
    """加速层现在什么状态。永远返回一个字典，界面不用做空判断。

    installed  装好了且验证过能摸到显卡
    pending    环境在，但 torch 没装 / 装了没用（要修）
    unsupported 这台机器没有能用的 N 卡，加速层没意义
    absent     环境本身还没有

    ⚠ python 参数（可选）：给了它就能"自愈" —— 记录里没有版本号、但环境里
      其实有能用的 CUDA torch 时，去问一句然后【把记录补好】。
      为什么需要：记录可能因为一次失败、一次手动 pip、或老版本的 bug 而残缺，
      缺了它的后果是界面上永远写"没装"，而用户明明装好了（静默失效）。
    """
    if not environment_directory or not Path(environment_directory).is_dir():
        return {"state": "absent", "available": False, "reason": "", "torch": "", "cuda": "", "device": ""}
    record = read_marker(environment_directory)
    availability = accel_availability()

    # ── 自愈：记录残缺但东西其实在 ──────────────────────────────────
    if python and (not record.get("torch") or not record.get("cuda") or not record.get("device")):
        if availability["available"]:
            try:
                live = installed(python, _subprocess_runner)
            except Exception:
                live = None
            if live and live.get("cuda"):
                healed = _record(live, availability["gpu"])
                try:
                    write_marker(environment_directory, healed)
                    record = healed
                except OSError:
                    record = healed          # 写不进去也先用这次探测结果说话

    if record.get("torch") and record.get("cuda") and record.get("device"):
        return {
            "state": "installed", "available": True, "reason": "",
            "torch": record["torch"], "cuda": record["cuda"], "device": record["device"],
            "vramGB": record.get("vramGB") or 0, "channel": record.get("channel") or "",
            # ONNX 显卡后端（抠像/人体解析/分割/SAM2 用不用显卡看这一项）
            "onnxProvider": record.get("onnxProvider") or "",
            "onnxPackage": record.get("onnxPackage") or "",
            "onnxNote": record.get("onnxNote") or "",
        }
    if not availability["available"]:
        return {
            "state": "unsupported", "available": False, "reason": availability["reason"],
            "torch": "", "cuda": "", "device": "", "gpu": availability["gpu"].get("name", ""),
        }
    return {
        "state": "pending", "available": True,
        "reason": record.get("reason") or "加速包还没装（装上之后细边 / 文字选区 / 过渡帧 / 人体解析就能用）",
        "torch": record.get("torch") or "", "cuda": record.get("cuda") or "",
        "device": record.get("device") or availability["gpu"].get("name", ""),
        "vramGB": availability["gpu"].get("vramGB") or 0,
    }


def _subprocess_runner(arguments, tag):
    """只给"自愈探测"用的一次性 runner（status 是只读路径，不该带取消/日志那套）。"""
    done = subprocess.run(arguments, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=40, check=False,
                          creationflags=0x08000000 if os.name == "nt" else 0)
    if done.returncode:
        raise RuntimeError("exit %s" % done.returncode)
    return done.stdout or ""


def failure(root, error):
    """加速层失败时给上层的统一形状（和 engine_environment.failure 对齐）。

    ⚠ 界面上那句话用【我们自己写的中文】，不要拿异常原文去顶上 ——
      异常里带的是 pip 的英文原话，用户看不懂（本项目"机制词只进日志"那条）。
    """
    code = getattr(error, "code", "ACCEL_FAILED")
    message = PUBLIC_ERRORS.get(code) or PUBLIC_ERRORS["ACCEL_FAILED"]
    return {
        "ok": False, "state": "error", "ready": False, "python": None, "root": str(root),
        "code": code, "error": message, "detail": str(error),
    }
