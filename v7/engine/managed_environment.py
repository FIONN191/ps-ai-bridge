"""Own the optional V7 Python environment; never install into the bootstrap Python."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

# ⚠⚠ 这行不能省：宿主（engine_environment.rs 的 command()）是用 `-I` 调本文件的，
#   `-I` 会把"脚本所在目录"从 sys.path 里【拿掉】（隔离模式的语义就是别让脚本环境污染解释器）。
#   于是 `import managed_accel` 会 ModuleNotFoundError。
#   实测过一次：不加这行，status 直接崩在 import 上。
#   ⇒ 显式把本文件所在目录放回 sys.path（兄弟模块就在那儿，不涉及外部路径）。
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import managed_accel  # noqa: E402

OWNER = "wheelchair-v7-managed-python"
ROOT_MARKER = ".v7-python-owner.json"
ENV_MARKER = ".v7-environment.json"
# ── 随包自带的免配置运行时（2026-10-08 新增，用户拍板"方案 A：真的 0 操作"）──
#
# 形态：<软件目录>/engine/python/  —— 一个自包含的 Python（官方 embeddable）
#       + 全部依赖预装在 engine/python/Lib/site-packages（含 CUDA torch + DirectML）
# 它由 tools/build-engine-runtime.py 在打包时产出，用户那边【不需要做任何事】。
#
# ⚠ 为什么需要这个 marker：不能只看"python.exe 在不在"就宣布就绪 ——
#   半成品（比如 torch 装失败了）也必须能被识别出来，否则用户看到的是
#   "环境已就绪"但一用就报缺依赖（本项目最忌讳的静默失效）。
#   ⇒ 只有这个 marker 存在（= 构建时逐项 import 验过）才算就绪。
BUNDLED_MARKER = ".v7-runtime-ready.json"


def bundled_python_dir():
    """随包自带的 Python 在哪。找不到返回 None。"""
    # 测试专用：设了 V7_IGNORE_BUNDLED_RUNTIME=1 就当没有自带运行时 —— 测「自己管的环境」那套逻辑时用
    #   （开发机上 engine/python 真有一套，会让那些测试判成 ready）。软件运行时不会设它。
    if os.environ.get("V7_IGNORE_BUNDLED_RUNTIME") == "1":
        return None
    candidate = Path(__file__).resolve().parent / "python"
    return candidate if candidate.is_dir() else None


def bundled_runtime_status():
    """自带运行时的状态。返回 None = 这台机器上没有自带运行时（走老路）。

    就绪的判据（三条都要）：
      ① marker 在（构建脚本写的，代表构建时逐项 import 验过）
      ② marker 说是就绪（ready=true）
      ③ python.exe 真的在
    """
    directory = bundled_python_dir()
    if directory is None:
        return None
    marker_file = directory / BUNDLED_MARKER
    if not marker_file.is_file():
        return None
    try:
        value = read_json(marker_file)
    except (OSError, ValueError):
        return None
    executable = directory / ("python.exe" if os.name == "nt" else "bin/python3")
    if value.get("ready") is not True or not executable.is_file():
        return None
    return {
        "directory": directory,
        "executable": str(executable),
        "record": value,
    }


MIN_FREE_BYTES = 3 * 1024 ** 3
#   老代码只查 2GiB —— 剩 5GB 的用户能过检查、装到一半磁盘满，
#   而报出来的错是"依赖安装失败"，用户根本看不出是空间不够。
#   ⇒ 加速层自己再查一次，门槛挂在"现有占用 + 加速包"上。
ACCEL_FREE_BYTES = 8 * 1024 ** 3
# ⚠⚠ 2026-10-08：原来是 20 分钟，**这是会让慢网用户必然失败的一条**。
#   实测（这台机器，PyTorch 官方源 3.2MB/s）：光准备 + 装加速 = 936 秒 = 15.6 分钟，
#   20 分钟的线只剩 4 分钟余量；下载慢一半的用户直接撞线。
#   而壳那边（engine_environment.rs / engine-environment.cjs）给的是 40 分钟 ——
#   两边不一致 ⇒ 用户看到的是"管理器超时"，不是"网络慢"。
#   ⇒ 提到 40 分钟，和壳对齐。
OPERATION_TIMEOUT = 40 * 60
ENV_NAME = re.compile(r"env-[0-9a-f]{32}\Z")
TOKEN = re.compile(r"[A-Za-z0-9_-]{16,80}\Z")
ALLOWED_REQUIREMENTS = ("numpy>=1.26,<3", "Pillow>=10,<13", "opencv-python>=4.9,<5", "onnxruntime>=1.20,<2")
PUBLIC_ERRORS = {
    "ENVIRONMENT_FAILED": "独立环境操作未完成，请查看安装日志后重试。原有模型不会被卸载。",
    "PATH_REJECTED": "独立环境路径不符合要求或包含链接，请使用软件指定的独立目录。",
    "OWNERSHIP_MISMATCH": "该目录不属于 V7 独立环境，软件已停止操作以保留现有文件。",
    "METADATA_INVALID": "独立环境记录已损坏，请重新检测；必要时选择新的独立目录。",
    "REQUIREMENTS_INVALID": "软件随包依赖清单不完整，请重新安装完整的 V7 软件包。",
    "ENVIRONMENT_BROKEN": "独立环境缺少解释器或依赖版本不符，请重新准备。",
    "ENVIRONMENT_BUSY": "另一个 V7 环境操作仍在进行，请等待完成后重试。",
    "CANCEL_OWNERSHIP": "当前准备任务由另一软件实例发起，只能在该实例中取消。",
    "INSTALL_FAILED": "依赖安装或校验失败，请检查网络和安装日志后重试；也可安装 Python 3.11 或 3.12 后重新准备。",
    "DISK_SPACE_LOW": "可用磁盘空间不足：独立环境本身要约 0.4 GiB，开启加速还要再占约 4.2 GiB。请释放空间后重试。",
    "ACCEL_DISK_LOW": "磁盘空间不够装加速包（约 4.2 GiB）。请释放空间后重试，或先不开加速档。",
    "PYTHON_UNSUPPORTED": "请从 https://www.python.org/downloads/ 安装 Python 3.10 或更高版本后重试；建议 3.11 或 3.12。",
    "ENVIRONMENT_TIMEOUT": "独立环境准备已超时，请检查网络和安装日志后重试。",
    "ENVIRONMENT_CANCELLED": "独立环境操作已取消，请重新检测当前状态；准备未完成时不会替换原有环境。",
    "SELF_REMOVE": "当前管理器正在使用待卸载环境，请通过软件设置或基础 Python 执行卸载。",
    "IO_ERROR": "无法读写独立环境文件，请检查磁盘空间、目录权限或文件占用后重试。",
    # ── 加速层（装 CUDA 版 PyTorch）────────────────────────────────────
    "ACCEL_FAILED": "加速包没装上，细边 / 文字选区 / 过渡帧 / 人体解析还是用不了。可以稍后重试。",
    "ACCEL_NO_GPU": "这台机器没检测到可用的 NVIDIA 显卡，装加速包也没有意义。",
    "ACCEL_NETWORK": "连不上 PyTorch 官方源（要下约 3GB），请检查网络或代理后重试。",
    "ACCEL_NO_BUILD": "PyTorch 官方源上没有适合这台机器的版本，加速档暂时开不了。",
    "ACCEL_VERIFY": "加速包装上了，但验证没通过（摸不到显卡），所以不算装好。请重试或检查显卡驱动。",
    "ACCEL_NEEDS_ENVIRONMENT": "要先把核心环境准备好，才能装加速包。",
}


class ManagedError(Exception):
    def __init__(self, message, code="ENVIRONMENT_FAILED"):
        super().__init__(message)
        self.code = code


class Cancelled(ManagedError):
    def __init__(self, message):
        super().__init__(message, "ENVIRONMENT_CANCELLED")


def public_error(error):
    code = getattr(error, "code", "IO_ERROR" if isinstance(error, OSError) else "METADATA_INVALID" if isinstance(error, ValueError) else "ENVIRONMENT_FAILED")
    return {"code": code, "error": PUBLIC_ERRORS.get(code, PUBLIC_ERRORS["ENVIRONMENT_FAILED"]), "detail": str(error)}


def check_path(value):
    path = Path(os.path.abspath(value))
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            details = part.lstat()
            if stat.S_ISLNK(details.st_mode) or getattr(details, "st_file_attributes", 0) & 0x400:
                raise ManagedError("Managed paths must not contain symbolic links or junctions: " + str(part), "PATH_REJECTED")
    return path


def read_json(path):
    check_path(path)
    if path.stat().st_size > 65536:
        raise ManagedError("Managed metadata is too large.", "METADATA_INVALID")
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ManagedError("Managed metadata must be a JSON object.", "METADATA_INVALID")
    return value


def atomic_json(path, value):
    check_path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=True)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(6):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.04)
    finally:
        temporary.unlink(missing_ok=True)


class RootLock:
    def __init__(self, root):
        self.handle = None
        path = check_path(root / ".operation.lock")
        handle = path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if path.stat().st_size == 0:
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.handle = handle
        except (OSError, IOError):
            handle.close()

    def close(self):
        if self.handle:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            self.handle.close()
            self.handle = None


class ChildJob:
    """Closing the Windows job also terminates ensurepip/pip descendants."""
    def __init__(self):
        self.handle = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64), ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t), ("active", wintypes.DWORD), ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class Io(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
        class Limits(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", Io), ("process_mem", ctypes.c_size_t), ("job_mem", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        self.api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        limits = Limits()
        limits.basic.flags = 0x2000
        if not self.handle or not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ManagedError("Cannot establish isolated installer process ownership.")

    def assign(self, child):
        if self.handle and not self.api.AssignProcessToJobObject(self.handle, int(child._handle)):
            child.kill()
            child.wait()
            raise ManagedError("Cannot contain installer subprocesses; preparation stopped.")

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


class Manager:
    def __init__(self, root, requirements, operation=None, accel="off"):
        if not Path(root).is_absolute() or not Path(requirements).is_absolute():
            raise ManagedError("Host-controlled absolute paths are required.", "PATH_REJECTED")
        # ⚠ 加速层是【按需】动作，默认 off ⇒ 老的调用点（不带这个参数）行为一个字没变。
        if accel not in ("off", "cuda"):
            raise ManagedError("Unknown acceleration profile.", "ACCEL_FAILED")
        self.accel = accel
        self.root = check_path(root)
        self.requirements = check_path(requirements)
        lines = tuple(line.strip() for line in self.requirements.read_text(encoding="utf-8-sig").splitlines() if line.strip() and not line.lstrip().startswith("#"))
        if lines != ALLOWED_REQUIREMENTS:
            raise ManagedError("The packaged V7 dependency list is invalid.", "REQUIREMENTS_INVALID")
        self.digest = hashlib.sha256(self.requirements.read_bytes()).hexdigest()
        if operation is not None and not TOKEN.fullmatch(operation):
            raise ManagedError("Invalid operation identity.")
        self.token = operation or uuid.uuid4().hex
        self.explicit_token = operation is not None
        self.log_file = None
        self.cancelled = False
        self.deadline = time.monotonic() + OPERATION_TIMEOUT

    def owned_root(self, create=False):
        check_path(self.root)
        if not self.root.exists():
            if not create:
                return False
            self.root.mkdir(parents=True, exist_ok=True)
        if not self.root.is_dir():
            raise ManagedError("Managed root is not a directory.", "PATH_REJECTED")
        marker = self.root / ROOT_MARKER
        if not marker.exists():
            if not create:
                if any(self.root.iterdir()):
                    raise ManagedError("Directory is not owned by the V7 Python manager.", "OWNERSHIP_MISMATCH")
                return False
            if any(self.root.iterdir()):
                raise ManagedError("Refusing to claim a nonempty directory.", "OWNERSHIP_MISMATCH")
            try:
                with marker.open("x", encoding="utf-8") as handle:
                    json.dump({"owner": OWNER, "schema": 1, "root": str(self.root)}, handle)
            except FileExistsError:
                pass
        value = read_json(marker)
        if value != {"owner": OWNER, "schema": 1, "root": str(self.root)}:
            raise ManagedError("Managed root ownership does not match.", "OWNERSHIP_MISMATCH")
        return True

    def environment(self, name):
        if not isinstance(name, str) or not ENV_NAME.fullmatch(name):
            raise ManagedError("Invalid managed environment name.", "METADATA_INVALID")
        directory = check_path(self.root / "environments" / name)
        marker = read_json(directory / ENV_MARKER)
        if marker.get("owner") != OWNER or marker.get("root") != str(self.root) or marker.get("environment") != name:
            raise ManagedError("Environment ownership does not match.", "OWNERSHIP_MISMATCH")
        return directory, marker

    def active(self):
        # ⚠⚠ 第一优先：随包自带的免配置运行时（2026-10-08 用户拍板的"方案 A"）。
        #   它已经带着全部依赖（含 CUDA torch + DirectML），用户不需要做任何事
        #   ⇒ 直接就是"已就绪"，不碰 active.json、不建环境、不装任何东西。
        #   ⚠ 必须排在 active.json 【前面】：用户机器上可能从来没有 active.json
        #     （他从没点过"准备环境"）—— 老逻辑会返回 None，界面就显示"未准备"，
        #     而实际上东西早就齐了（这正是"免配置"要消灭的那种假状态）。
        bundled = bundled_runtime_status()
        if bundled is not None:
            return bundled["executable"]

        pointer = self.root / "active.json"
        if not pointer.exists():
            return None
        value = read_json(pointer)
        directory, marker = self.environment(value.get("environment"))
        if marker.get("verified") is not True or marker.get("requirements") != self.digest or value.get("requirements") != self.digest:
            raise ManagedError("Managed environment must be prepared for this dependency set.", "ENVIRONMENT_BROKEN")
        executable = check_path(directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
        if not executable.is_file():
            raise ManagedError("Managed Python is missing; prepare it again.", "ENVIRONMENT_BROKEN")
        return str(executable)

    def accelerator_state(self):
        """加速层状态。查不到就返回 None（宁可界面少显示一格，也不给错结论）。"""
        try:
            # ⚠ 自带运行时：加速层【构建时就已经装好并验过了】，所以直接读构建脚本
            #   写在目录里的清单，不再去 spawn 子进程探测 —— 启动快、也没得失败。
            #   ⚠ 清单里没有加速信息（比如 --skip-torch 构建的）就落到下面按"未装"报。
            bundled = bundled_runtime_status()
            if bundled is not None:
                record = bundled.get("record") or {}
                accel = record.get("accel")
                if isinstance(accel, dict) and accel.get("torch"):
                    return accel
                return {
                    "state": "pending", "available": True,
                    "reason": record.get("accelReason")
                              or "随包运行时里没有装加速包，点「开启加速」可以补上",
                    "torch": "", "cuda": "", "device": "", "vramGB": 0,
                }

            directory = None
            python = None
            if self.owned_root():
                pointer = self.root / "active.json"
                if pointer.exists():
                    value = read_json(pointer)
                    if isinstance(value.get("environment"), str):
                        directory = check_path(self.root / "environments" / value["environment"])
                        executable = directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
                        if executable.is_file():
                            python = str(executable)
            # ⚠ 带上 python：记录残缺但 torch 其实在时，status() 会自愈补好（见 managed_accel.status）
            return managed_accel.status(directory, python)
        except (OSError, ValueError, ManagedError):
            return None

    def result(self, ok=True, state=None, error=None):
        executable = None
        try:
            # ⚠⚠ 2026-10-16 修（完整包冒烟测试抓到，开发机上永远测不出来）：原来只在「自己管的环境目录」已经存在时
            #   才去问 active()（它第一优先就是随包自带运行时）。全新电脑上只解压了完整包、这个目录根本没建过
            #   ⇒ owned_root() 是 False ⇒ 直接判「absent」⇒ 引擎报「独立图像环境尚未就绪」，包里的 Python 都没被看一眼。
            #   开发机上 tmp/managed-engine 早就有了，所以一直是好的。
            #   ⇒ 随包自带运行时先看，不依赖那个目录在不在。
            bundled = bundled_runtime_status()
            if bundled is not None:
                executable = bundled["executable"]
            elif self.owned_root():
                executable = self.active()
        except (OSError, ValueError, ManagedError) as failure:
            ok = False
            error = error or failure
            state = state or "broken"
        value = {"ok": ok, "state": state or ("ready" if executable else "absent"), "ready": bool(executable), "python": executable, "root": str(self.root)}
        # ⚠ 加速层状态永远带上（界面不用做空判断）。
        #   环境不存在时 managed_accel.status(None) 第一行就返回 absent，
        #   不会去问显卡 —— 所以"没环境"这条路一次 nvidia-smi 都不跑。
        accel = self.accelerator_state()
        if accel is not None:
            value["accel"] = accel
        if error:
            value.update(public_error(error))
        if self.log_file:
            value["logFile"] = str(self.log_file)
        return value

    def operation(self):
        try:
            return read_json(self.root / "operation.json")
        except (OSError, ValueError):
            return {}

    def status(self):
        if not self.owned_root():
            return self.result()
        lock = RootLock(self.root)
        try:
            if not lock.handle:
                running = self.operation()
                return self.result(state="removing" if running.get("action") == "remove" else "preparing")
            return self.result()
        finally:
            lock.close()

    def cancel(self):
        if not self.explicit_token:
            raise ManagedError("Cancellation requires the caller's operation identity.")
        if not self.owned_root():
            return self.result()
        lock = RootLock(self.root)
        try:
            if lock.handle:
                return self.result()
            operation = self.operation()
            if operation.get("token") != self.token:
                return self.result(ok=False, state="error", error=ManagedError("Another instance owns the active preparation.", "CANCEL_OWNERSHIP"))
            atomic_json(self.root / ("cancel-" + self.token + ".json"), {"token": self.token})
            return self.result(state="removing" if operation.get("action") == "remove" else "preparing")
        finally:
            lock.close()

    def check_cancelled(self):
        if self.cancelled or (self.root / ("cancel-" + self.token + ".json")).exists():
            raise Cancelled("V7 environment preparation was cancelled.")
        if time.monotonic() >= self.deadline:
            raise ManagedError("V7 environment preparation timed out. Check the network and retry.", "ENVIRONMENT_TIMEOUT")

    def run(self, arguments, log, capture=False):
        """跑一个受管的子进程。

        capture=True 时把这次子进程写进日志的内容【读回来】返回 ——
        加速层要靠它拿 pip 的答复和 torch 的自述（不能再起一个自己管不住的进程）。
        ⚠ 失败时把日志尾巴塞进错误消息里：不然"pip 退出码 1"这句话
          既诊断不了、也没法判断是网络抖动还是真的装不上（候选要据此决定退不退下一档）。
        """
        self.check_cancelled()
        environment = {key: value for key, value in os.environ.items() if not key.startswith(("PYTHON", "PIP_")) and key not in ("VIRTUAL_ENV", "CONDA_PREFIX")}
        environment.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1", "PIP_CONFIG_FILE": os.devnull})
        position = self._log_position(log) if capture else 0
        job = ChildJob()
        child = None
        tail = ""
        try:
            child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, cwd=self.root, env=environment, start_new_session=os.name != "nt", creationflags=0x08000000 if os.name == "nt" else 0)
            job.assign(child)
            while child.poll() is None:
                self.check_cancelled()
                time.sleep(0.1)
            self.check_cancelled()
            if capture:
                tail = self._log_since(log, position)
            if child.returncode:
                raise ManagedError(
                    "Installer or dependency verification failed (exit %s).%s"
                    % (child.returncode, (" Last log lines: " + tail[-1200:]) if tail else " Check the log and retry."),
                    "INSTALL_FAILED",
                )
        finally:
            if child and child.poll() is None:
                if os.name == "nt":
                    job.close()
                else:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
            job.close()
        return tail

    @staticmethod
    def _log_position(log):
        try:
            log.flush()
            return log.tell()
        except (OSError, ValueError, AttributeError):
            return 0

    def _log_since(self, log, position):
        """读回日志文件里 [position, 现在) 这段。

        ⚠ 位置可能在【父进程】继承来的句柄上（log 是同一个文件对象的另一个句柄），
          所以一律重新打开文件、用 flush 保证落盘，避免读到半截。
        """
        try:
            log.flush()
            if not self.log_file:
                return ""
            with self.log_file.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(max(0, position))
                return handle.read()[-262144:]
        except (OSError, ValueError):
            return ""

    def prepare(self, log):
        if sys.version_info < (3, 10) or sys.version_info >= (4, 0):
            raise ManagedError("Install Python 3.10 or later from https://www.python.org/downloads/ and retry. Python 3.11/3.12 are recommended.", "PYTHON_UNSUPPORTED")
        if shutil.disk_usage(self.root).free < MIN_FREE_BYTES:
            raise ManagedError("At least 3 GiB of free disk space is required to prepare the V7 environment.", "DISK_SPACE_LOW")
        directory = check_path(self.root / "environments")
        directory.mkdir(exist_ok=True)
        name = "env-" + uuid.uuid4().hex
        directory = directory / name
        directory.mkdir()
        marker = {"owner": OWNER, "root": str(self.root), "environment": name, "requirements": self.digest, "verified": False}
        atomic_json(directory / ENV_MARKER, marker)
        try:
            self.run([sys.executable, "-I", "-m", "venv", "--copies", str(directory)], log)
            # CPython creates this redundant convenience link even with --copies.
            lib64 = directory / "lib64"
            if lib64.is_symlink() and os.readlink(lib64) == "lib":
                lib64.unlink()
            executable = str(check_path(directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")))
            self.run([executable, "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-input", "install", "--only-binary=:all:", "--no-cache-dir", "--timeout", "30", "--retries", "2", "--index-url", "https://pypi.org/simple", "-r", str(self.requirements)], log)
            self.run([executable, "-I", "-c", "import sys, numpy, PIL, cv2, onnxruntime; assert sys.prefix != sys.base_prefix; print('V7_DEPENDENCIES_OK')"], log)
            self.run([executable, "-I", "-m", "pip", "--isolated", "check"], log)
            self.check_cancelled()
            marker["verified"] = True
            atomic_json(directory / ENV_MARKER, marker)
            atomic_json(self.root / "active.json", {"environment": name, "requirements": self.digest})
            # 加速层放在【基础环境已经可用之后】：加速装失败绝不能把好不容易装好的核心环境一起毁掉。
            self.accelerate(directory, log)
        except BaseException:
            self.remove_environment(name)
            raise

    @staticmethod
    def _ort_probe_model():
        """给 ONNX 那边一个真的 .onnx 文件，好让它"真建会话"验证 provider。

        ⚠ 挑【最小的那个】：建会话要把模型读进内存，拿 1.2GB 的 SAM2-large 去试
          会让验证慢到离谱（而且可能吃光显存）。引擎自己挑 provider 时
          （multi_engine_server.py:481）用的也是同一招"拿最小的试"。
        ⚠ 找不到就返回 None —— 那边会退化成"只看 provider 在不在列表里"的弱判断，
          并且会在日志里明说（不许把弱判断当"已验证"）。
        """
        try:
            here = Path(__file__).resolve().parent
            models = here / "models"
            if not models.is_dir():
                return None
            candidates = []
            for path in models.rglob("*.onnx"):
                try:
                    candidates.append((path.stat().st_size, path))
                except OSError:
                    continue
            if not candidates:
                return None
            candidates.sort()
            return str(candidates[0][1])
        except OSError:
            return None

    def accelerate(self, directory, log):
        """按需给这个环境加装 CUDA 版 PyTorch（只增不改，装不上也不拆核心环境）。"""
        if self.accel != "cuda":
            return
        executable = str(directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))

        def log_line(message):
            print("[环境] " + str(message), file=log, flush=True)

        # ⚠⚠ 空间不够就【在开始下载之前】就停下说清楚。
        #   实测加速层要 4.2GB（torch 轮子解包后 4217MB）。
        #   不先查的后果：用户等 15 分钟下完，最后死在解包那一步，
        #   看到的还是"依赖安装失败"这种看不出原因的错。
        free = shutil.disk_usage(self.root).free
        if free < ACCEL_FREE_BYTES:
            failure = managed_accel.AccelError(
                "磁盘空间不够装加速包：需要约 %.1f GiB，现在只剩 %.1f GiB。"
                % (ACCEL_FREE_BYTES / 1024 ** 3, free / 1024 ** 3), "ACCEL_DISK_LOW")
            log_line(str(failure))
            try:
                managed_accel.write_marker(directory, {"torch": "", "cuda": "", "device": "", "reason": str(failure), "code": failure.code})
            except OSError:
                pass
            return

        def runner(arguments, tag):
            log_line("%s：%s" % (tag, os.path.basename(str(arguments[0]))))
            return self.run(arguments, log, capture=True)

        try:
            record = managed_accel.install(executable, self.root, runner, log_line, probe_model=self._ort_probe_model())
        except Cancelled:
            raise
        except managed_accel.AccelError as failure:
            # ⚠ 只记状态、不抛：核心环境已经好了，加速档标成"没装 + 原因"，
            #   用户在界面上看到的是"要修"而不是整个环境报错。
            log_line("加速层没装上：%s" % failure)
            try:
                managed_accel.write_marker(directory, {"torch": "", "cuda": "", "device": "", "reason": str(failure), "code": failure.code})
            except OSError:
                pass
            return
        except (OSError, subprocess.SubprocessError, ManagedError) as failure:
            log_line("加速层安装中断：%s" % failure)
            return
        record["reason"] = ""
        managed_accel.write_marker(directory, record)
        log_line("加速档已就绪：torch %s / CUDA %s / %s" % (record["torch"], record["cuda"], record["device"]))

    def remove_accel(self, log):
        """关掉加速：拆掉加速层装进去的包，核心环境一个字不动。

        ⚠ 跟 accelerate 一样是"只动加速层"——基础环境（numpy/onnxruntime/cv2/PIL）
          和所有模型文件都不受影响，所以关了加速软件照样能用老模型。
        """
        if not self.owned_root():
            return self.result()
        pointer = self.root / "active.json"
        if not pointer.exists():
            return self.result()
        value = read_json(pointer)
        if not isinstance(value.get("environment"), str):
            raise ManagedError("独立环境记录已损坏，请重新检测。", "METADATA_INVALID")
        directory, _ = self.environment(value["environment"])
        executable = str(directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))

        def log_line(message):
            print("[环境] " + str(message), file=log, flush=True)

        def runner(arguments, tag):
            log_line("%s：%s" % (tag, os.path.basename(str(arguments[0]))))
            return self.run(arguments, log, capture=True)

        managed_accel.uninstall(executable, directory, runner, log_line)

    def remove_environment(self, name):
        directory, _ = self.environment(name)
        self.inspect_tree(directory)
        shutil.rmtree(directory)

    def inspect_tree(self, directory):
        # Refuse links before recursive removal; never traverse another installation.
        for parent, dirs, files in os.walk(directory, followlinks=False):
            for entry in dirs + files:
                check_path(Path(parent) / entry)

    def remove(self):
        directory = check_path(self.root / "environments")
        names = []
        if directory.exists():
            for entry in directory.iterdir():
                owned, _ = self.environment(entry.name)
                self.inspect_tree(owned)
                if Path(sys.executable).is_relative_to(owned):
                    raise ManagedError("Run environment removal with the base Python interpreter, not the environment being removed.", "SELF_REMOVE")
                names.append(entry.name)
        self.check_cancelled()
        # Removing the pointer first never advertises a partially deleted environment.
        check_path(self.root / "active.json").unlink(missing_ok=True)
        for name in names:
            self.check_cancelled()
            self.remove_environment(name)

    def mutate(self, action):
        if not self.owned_root(create=action == "prepare"):
            return self.result()
        lock = RootLock(self.root)
        if not lock.handle:
            return self.result(ok=False, state="preparing", error=ManagedError("A V7 environment operation is already running.", "ENVIRONMENT_BUSY"))
        try:
            atomic_json(self.root / "operation.json", {"token": self.token, "action": action, "pid": os.getpid()})
            logs = check_path(self.root / "logs")
            logs.mkdir(exist_ok=True)
            self.log_file = logs / (self.token + ".log")
            with self.log_file.open("x", encoding="utf-8") as log:
                if action == "prepare":
                    self.prepare(log)
                elif action == "removeaccel":
                    self.remove_accel(log)
                else:
                    self.remove()
            return self.result()
        except Cancelled as failure:
            return {**self.result(ok=False, state="cancelled", error=failure), "cancelled": True}
        except (OSError, ValueError, ManagedError, subprocess.SubprocessError) as failure:
            return self.result(ok=False, state="error", error=failure)
        finally:
            with contextlib.suppress(OSError, ManagedError):
                check_path(self.root / ("cancel-" + self.token + ".json")).unlink(missing_ok=True)
            lock.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--requirements", required=True)
    parser.add_argument("--action", choices=("status", "prepare", "remove", "cancel", "removeaccel"), required=True)
    parser.add_argument("--operation")
    parser.add_argument(
        "--accel",
        choices=("off", "cuda"),
        default="off",
        help="off=只装核心依赖（默认）；cuda=额外装 CUDA 版 PyTorch（约 3GB，只增不改）",
    )
    arguments = parser.parse_args()
    try:
        manager = Manager(arguments.root, arguments.requirements, arguments.operation, arguments.accel)
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, lambda *_: setattr(manager, "cancelled", True))
        if arguments.action in ("prepare", "remove"):
            result = manager.mutate(arguments.action)
        else:
            result = getattr(manager, arguments.action)()
    except (OSError, ValueError, ManagedError) as failure:
        result = {"ok": False, "state": "error", "ready": False, "python": None, "root": os.path.abspath(arguments.root), **public_error(failure)}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
