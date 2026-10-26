"""Stage model data in V7-owned paths; never execute imported model content."""
import argparse
import ast
import contextlib
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

OWNER = "wheelchair-v7-model-manager"
TOKEN = re.compile(r"[A-Za-z0-9_-]{16,80}\Z")
HEX = re.compile(r"[0-9a-f]{64}\Z")
BLOCK = 1024 * 1024
RESERVE = 64 * BLOCK
MAX_FILES = 20000
MAX_BYTES = 128 * 1024 ** 3
HERE = Path(__file__).resolve().parent
# 后台下发的下载清单路径（宿主用 --manifest 指过来）。None = 用随包那份。
# ⚠ 模块级，因为 Manager 是在 main() 里 new 的，走参数传进去要改一堆签名。
MANIFEST_PATH = None


class ModelError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Cancelled(ModelError):
    def __init__(self):
        super().__init__("MODEL_CANCELLED", "模型操作已取消，原模型保持不变。")


def checked(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            details = part.lstat()
            if stat.S_ISLNK(details.st_mode) or getattr(details, "st_file_attributes", 0) & 0x400:
                raise ModelError("MODEL_PATH_LINK", "模型路径不得包含符号链接或目录联接：" + str(part))
    return path


def relative(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ModelError("MODEL_PATH_INVALID", "模型制品相对路径无效。")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")):
        raise ModelError("MODEL_PATH_INVALID", "模型制品不能越出固定目录。")
    for part in path.parts:
        if any(ord(char) < 32 or char in '<>"|?*' for char in part) or part.endswith((".", " ")) or re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part):
            raise ModelError("MODEL_PATH_INVALID", "模型制品路径包含不安全的文件名。")
    return path


def under(root, value):
    path = checked(root.joinpath(*relative(value).parts))
    if not path.is_relative_to(root):
        raise ModelError("MODEL_PATH_INVALID", "模型目标越出固定目录。")
    return path


def read_json(path, limit=1024 * 1024):
    path = checked(path)
    if path.stat().st_size > limit:
        raise ModelError("MODEL_METADATA_INVALID", "模型元数据过大。")
    with path.open("r", encoding="utf-8-sig") as stream:
        return json.load(stream)


def atomic_json(path, value):
    path = checked(path)
    temporary = checked(path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp"))
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=True, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def signature(path):
    path = checked(path)
    value = path.stat()
    return [value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns]


def move_old(source, destination):
    source, destination = checked(source), checked(destination)
    if destination.exists():
        raise FileExistsError("Model backup destination already exists: " + str(destination))
    # Active data must move in one operation: link/unlink can delete a concurrent replacement.
    os.rename(source, destination)


def directory_rename():
    if sys.platform == "win32":
        return os.rename
    try:
        library = ctypes.CDLL(None, use_errno=True)
        if sys.platform == "darwin":
            function = library.renamex_np
            function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        elif sys.platform.startswith("linux"):
            function = library.renameat2
            function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        else:
            raise AttributeError("unsupported platform")
        function.restype = ctypes.c_int
    except (AttributeError, OSError) as error:
        raise ModelError("MODEL_ATOMIC_PUBLISH_UNSUPPORTED", "当前平台缺少禁止覆盖目标的原子目录重命名，已停止写入。") from error
    platform = sys.platform

    def rename(source, destination):
        source_bytes, destination_bytes = os.fsencode(source), os.fsencode(destination)
        if platform == "darwin":
            status = function(source_bytes, destination_bytes, 0x4)  # RENAME_EXCL
        else:
            status = function(-100, source_bytes, -100, destination_bytes, 1)  # AT_FDCWD, RENAME_NOREPLACE
        if status != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code), str(destination))

    return rename


def publish_new(source, destination):
    source, destination = checked(source), checked(destination)
    if destination.exists():
        raise FileExistsError("Model destination appeared during publication: " + str(destination))
    if source.is_dir():
        directory_rename()(source, destination)
    else:
        # Only private candidates may use link/unlink; public destinations are never unlinked.
        os.link(source, destination, follow_symlinks=False)
        source.unlink()


def static_value(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool, type(None))):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)):
        return [static_value(item) for item in node.elts]
    if isinstance(node, ast.Dict):
        return {static_value(key): static_value(value) for key, value in zip(node.keys, node.values)}
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        left, right = static_value(node.left), static_value(node.right)
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            return left * right
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -static_value(node.operand)
    raise ModelError("MODEL_REGISTRY_INVALID", "模型登记表必须是静态数据。")


def registry(path=HERE / "multi_engine_server.py"):
    tree = ast.parse(checked(path).read_text(encoding="utf-8-sig"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "MODELS" for target in node.targets):
            values = static_value(node.value)
            if not isinstance(values, dict):
                break
            for key, model in values.items():
                if not isinstance(key, str) or not isinstance(model, dict):
                    raise ModelError("MODEL_REGISTRY_INVALID", "模型登记表条目无效。")
                relative(model.get("file"))
                if model.get("dir"):
                    directory = relative(model["dir"])
                    if not relative(model["file"]).is_relative_to(directory):
                        raise ModelError("MODEL_REGISTRY_INVALID", "模型权重不在登记目录内。")
            return values
    raise ModelError("MODEL_REGISTRY_INVALID", "无法读取固定模型登记表。")


def inspect(path, expected=None):
    spec = importlib.util.spec_from_file_location("v7_model_integrity", checked(HERE / "model_integrity.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with contextlib.redirect_stdout(sys.stderr):
        return module.inspect_model(str(path), expected)


class Lock:
    def __init__(self, path, existing=False):
        self.handle = checked(path).open("r+b" if existing else "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if self.handle.seek(0, 2) == 0 and not existing:
                    self.handle.write(b"0")
                    self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            self.handle = None

    def close(self):
        if self.handle:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            self.handle.close()
            self.handle = None


class HTTPSOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise ModelError("MODEL_DOWNLOAD_SOURCE", "下载重定向不是 HTTPS，已停止。")
        return super().redirect_request(request, response, code, message, headers, newurl)


class Manager:
    def __init__(self, root, operation=None, models=None, manifest=None, inspector=None, opener=None):
        if not Path(root).is_absolute():
            raise ModelError("MODEL_ROOT_INVALID", "模型根目录必须由宿主提供绝对路径。")
        self.root = checked(root)
        self.private = checked(self.root / ".v7-model-manager")
        self.models = registry() if models is None else models
        # ⚠⚠ 清单来源有两层（2026-10-03，docs/128 §三-3-d）：
        #   ① 随包的那份（HERE/model-downloads.json）—— 出厂兜底，用户没网也能装
        #   ② 后台下发的那份（宿主用 --manifest 指过来）—— 运维改地址不用重新发版
        #   规则：给了后台那份就【只用】它，不做合并。
        #     合并会造出"大小来自新版、摘要来自旧版"这种半新半旧的条目，
        #     下到一半才炸，而且报的错跟真正的原因对不上。
        #   后台那份要是坏的（读不了 / schema 不对），在下面直接报错 ——
        #     不静默回落到随包清单：那样用户会以为"后台配的生效了"，其实没生效。
        if manifest is not None:
            self.manifest = manifest
        elif MANIFEST_PATH is not None:
            try:
                self.manifest = read_json(MANIFEST_PATH)
            except OSError as error:
                raise ModelError("MODEL_MANIFEST_INVALID", "后台下发的下载清单读不到：%s" % error)
        else:
            self.manifest = read_json(HERE / "model-downloads.json")
        if not isinstance(self.manifest, dict) or self.manifest.get("schema") != 1 or not isinstance(self.manifest.get("models"), dict):
            raise ModelError("MODEL_MANIFEST_INVALID", "可信下载清单无效。")
        if operation is not None and not TOKEN.fullmatch(operation):
            raise ModelError("MODEL_OPERATION_INVALID", "模型操作编号无效。")
        self.token = operation
        self.inspector = inspector or inspect
        self.opener = opener or urllib.request.build_opener(HTTPSOnly()).open
        self.current = None
        self.deadline = time.monotonic() + 4 * 3600

    def owned(self, create=False):
        checked(self.root)
        checked(self.private)
        if not self.private.exists():
            if not create:
                return False
            self.private.mkdir(parents=True)
            atomic_json(self.private / "owner.json", {"owner": OWNER, "root": str(self.root), "schema": 1})
        marker = read_json(self.private / "owner.json")
        if marker != {"owner": OWNER, "root": str(self.root), "schema": 1}:
            raise ModelError("MODEL_ROOT_OWNER", "模型管理暂存目录不属于此 V7 实例。")
        return True

    def model(self, key):
        row = self.models.get(key)
        enabled = {name for name, value in self.models.items() if value.get("enabled") is not False and value.get("tier", 0) > 0}
        companions = {self.models[name].get("decoder") for name in enabled}
        if not row or key not in enabled | companions:
            raise ModelError("MODEL_UNKNOWN", "未登记或未启用此模型。")
        relative(row["file"])
        if row.get("dir"):
            directory = relative(row["dir"])
            if not relative(row["file"]).is_relative_to(directory) or relative(row["file"]) == directory:
                raise ModelError("MODEL_REGISTRY_INVALID", "模型权重不在登记目录内。")
        if not isinstance(row.get("minBytes", 1), int) or not 1 <= row.get("minBytes", 1) <= MAX_BYTES:
            raise ModelError("MODEL_REGISTRY_INVALID", "模型最小大小配置无效。")
        return row

    def files(self, key):
        row = self.model(key)
        value = self.manifest["models"].get(key)
        if value is None:
            return []
        rows = value.get("files") if isinstance(value, dict) else None
        if rows is None and isinstance(value, dict) and not row.get("dir"):
            rows = [{**value, "path": Path(row["file"]).name}]
        if not isinstance(rows, list) or not rows or len(rows) > MAX_FILES:
            raise ModelError("MODEL_MANIFEST_INVALID", "可信模型制品清单无效。")
        seen, result = set(), []
        for item in rows:
            if not isinstance(item, dict):
                raise ModelError("MODEL_MANIFEST_INVALID", "可信制品条目无效。")
            name = str(relative(item.get("path")))
            # ⚠ 两种写法都认（2026-10-03）：
            #   url      —— 老写法，一条地址
            #   sources  —— 后台「模型下载」页产出的写法，是【数组】：
            #               第一条放自己的服务器，后面放官方地址当备用
            #   ⚠ 这里只挑第一条 https 用。备用地址是给【前端测速分流】看的，
            #     引擎这一层不做重试切换（换源要重算断点，比重新发起还麻烦）。
            candidate = item.get("url", "")
            sources = item.get("sources")
            if not candidate and isinstance(sources, list):
                candidate = next((value for value in sources
                                  if isinstance(value, str) and value.startswith("https://")), "")
            url = urllib.parse.urlsplit(candidate)
            size, digest = item.get("bytes"), item.get("sha256", "")
            if name.casefold() in seen or url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment or not isinstance(size, int) or isinstance(size, bool) or size < 1 or size > MAX_BYTES or not isinstance(digest, str) or not HEX.fullmatch(digest):
                raise ModelError("MODEL_MANIFEST_INVALID", "下载必须使用固定 HTTPS、长度和 SHA256。")
            seen.add(name.casefold())
            result.append({"path": name, "url": candidate, "bytes": size, "sha256": digest})
        required = str(PurePosixPath(row["file"]).relative_to(row["dir"])) if row.get("dir") else Path(row["file"]).name
        if required not in {item["path"] for item in result} or (row.get("dir") and "config.json" not in {item["path"] for item in result}) or (not row.get("dir") and len(result) != 1):
            raise ModelError("MODEL_MANIFEST_INVALID", "可信清单缺少登记权重或目录配置。")
        if sum(item["bytes"] for item in result) > MAX_BYTES:
            raise ModelError("MODEL_MANIFEST_INVALID", "模型制品总量过大。")
        return result

    def operation(self):
        if self.owned() and (self.private / "operation.json").exists():
            value = read_json(self.private / "operation.json")
            if value.get("status") == "running":
                path = checked(self.private / "operation.lock")
                lock = Lock(path, existing=True) if path.exists() else None
                try:
                    if lock is None or lock.handle:
                        value = {**value, "status": "interrupted", "error": "上次模型操作已中断，可重新发起；旧副本将在下一次操作前恢复。"}
                finally:
                    if lock:
                        lock.close()
            return value
        return None

    def catalog(self):
        result = {}
        for key in self.models:
            try:
                row = self.model(key)
            except ModelError as error:
                if error.code == "MODEL_UNKNOWN":
                    continue
                raise
            target = under(self.root, row["file"])
            item = {name: row[name] for name in ("name", "desc", "kind", "tier", "file", "dir") if name in row}
            item.update(key=key, state="missing", bytes=0, integrity="unverified", verificationNote="尚未导入此模型；硬件和推理能力由引擎另行检测。")
            if row.get("decoder"):
                item["companions"] = [row["decoder"]]
            if target.exists():
                size = target.stat().st_size
                item.update(bytes=size, state="present" if target.is_file() and size >= row.get("minBytes", 1) else "broken", verificationNote="文件已存在；尚未验证来源完整性和实际推理能力。")
                if row.get("dir"):
                    try:
                        config = read_json(under(self.root, row["dir"]) / "config.json", 8 * BLOCK)
                        if not isinstance(config, dict) or not config:
                            raise ValueError("config.json is not an object")
                    except (OSError, ValueError, ModelError) as error:
                        item.update(state="broken", verificationNote="模型目录配置缺失或损坏：" + str(error))
                receipt = self.private / ("receipt-" + hashlib.sha256(key.encode()).hexdigest() + ".json")
                if self.owned() and receipt.exists():
                    value = read_json(receipt, 8 * BLOCK)
                    current = self.tree(under(self.root, row.get("dir") or row["file"]))
                    recorded = {name: entry.get("fingerprint") for name, entry in value.get("files", {}).items()}
                    if item["state"] == "present" and current == recorded and value.get("fingerprint") == signature(target):
                        item.update({name: value[name] for name in ("sha256", "integrity", "validation", "verificationNote") if name in value})
            downloads = self.files(key)
            if downloads:
                canonical = json.dumps(downloads, sort_keys=True, separators=(",", ":")).encode()
                item["download"] = {"available": True, "url": downloads[0]["url"], "urls": [entry["url"] for entry in downloads], "bytes": sum(entry["bytes"] for entry in downloads), "sha256": downloads[0]["sha256"] if len(downloads) == 1 else hashlib.sha256(canonical).hexdigest()}
            else:
                item["download"] = {"available": False, "reason": "尚未提供固定制品、长度和可信摘要；可导入已有模型。"}
            result[key] = item
        return {"ok": True, "root": str(self.root), "models": result, "operation": self.operation()}

    def check_cancelled(self):
        if self.token and (self.private / ("cancel-" + self.token + ".json")).exists():
            raise Cancelled()
        if time.monotonic() > self.deadline:
            raise ModelError("MODEL_TIMEOUT", "模型操作超时，可重试已下载的部分文件。")

    def cancel(self):
        if not self.token:
            raise ModelError("MODEL_OPERATION_INVALID", "取消需要当前操作编号。")
        if not self.owned():
            return self.catalog()
        lock = Lock(self.private / "operation.lock")
        try:
            if lock.handle:
                lock.close()
                return self.catalog()
            operation = self.operation()
            if not operation or operation.get("token") != self.token or operation.get("status") != "running":
                raise ModelError("MODEL_OPERATION_MISMATCH", "取消编号不属于正在运行的模型操作。")
            atomic_json(self.private / ("cancel-" + self.token + ".json"), {"token": self.token})
            return {**self.catalog(), "cancelRequested": True}
        finally:
            lock.close()

    def tree(self, source, allow_empty=False):
        source = checked(source)
        entries = {}
        if source.is_file():
            value = signature(source)
            if value[2] > MAX_BYTES:
                raise ModelError("MODEL_SOURCE_TOO_LARGE", "模型文件大小超过限制。")
            return {source.name: value}
        if not source.is_dir():
            raise ModelError("MODEL_SOURCE_INVALID", "请选择已有模型文件或完整模型目录。")
        total = 0
        for directory, folders, files in os.walk(source, followlinks=False):
            checked(directory)
            for name in folders:
                checked(Path(directory) / name)
            for name in files:
                file = checked(Path(directory) / name)
                if not file.is_file():
                    raise ModelError("MODEL_SOURCE_INVALID", "模型目录包含非普通文件。")
                rel = file.relative_to(source).as_posix()
                relative(rel)
                entries[rel] = signature(file)
                total += entries[rel][2]
                if len(entries) > MAX_FILES or total > MAX_BYTES:
                    raise ModelError("MODEL_SOURCE_TOO_LARGE", "模型目录文件数或大小超过限制。")
        if not entries and not allow_empty:
            raise ModelError("MODEL_SOURCE_INVALID", "模型目录为空。")
        return entries

    def space(self, size):
        if shutil.disk_usage(self.root).free < size + RESERVE:
            raise ModelError("MODEL_SPACE_REQUIRED", "模型暂存需要 %s 字节及额外 64 MB 空间。" % size)

    def stage(self, name, create=True):
        if not re.fullmatch(r"(?:import-[0-9a-f]{32}|download-[0-9a-f]{64})", name):
            raise ModelError("MODEL_STAGE_INVALID", "模型暂存编号无效。")
        path = checked(self.private / name)
        if not path.exists():
            if not create:
                raise ModelError("MODEL_STAGE_INVALID", "模型暂存目录已不存在。")
            path.mkdir()
            atomic_json(path / "owner.json", {"owner": OWNER, "root": str(self.root), "stage": name})
        if read_json(path / "owner.json") != {"owner": OWNER, "root": str(self.root), "stage": name}:
            raise ModelError("MODEL_STAGE_INVALID", "拒绝使用非 V7 创建的暂存目录。")
        return path

    def discard(self, stage):
        if stage != self.stage(stage.name, create=False):
            raise ModelError("MODEL_STAGE_INVALID", "模型暂存路径不一致。")
        for directory, folders, files in os.walk(stage, followlinks=False):
            checked(directory)
            for name in folders + files:
                checked(Path(directory) / name)
        shutil.rmtree(stage)

    def write_operation(self, **values):
        self.current.update(values)
        atomic_json(self.private / "operation.json", self.current)

    def copy(self, source, destination):
        checked(source)
        checked(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with source.open("rb") as incoming, destination.open("xb") as outgoing:
            while True:
                self.check_cancelled()
                block = incoming.read(BLOCK)
                if not block:
                    break
                outgoing.write(block)
                digest.update(block)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        return digest.hexdigest()

    def validate(self, key, payload, files):
        row = self.model(key)
        main_name = str(PurePosixPath(row["file"]).relative_to(row["dir"])) if row.get("dir") else Path(row["file"]).name
        main = under(payload, main_name)
        if not main.is_file() or main.stat().st_size < row.get("minBytes", 1):
            raise ModelError("MODEL_INCOMPLETE", "模型缺少登记权重，或权重明显过小。")
        if row.get("dir"):
            config = read_json(payload / "config.json", 8 * BLOCK)
            if not isinstance(config, dict) or not config:
                raise ModelError("MODEL_CONFIG_INVALID", "完整模型目录需要有效的 config.json 对象。")
        trusted = self.files(key)
        for entry in trusted:
            actual = files.get(entry["path"])
            if not actual or actual["sha256"] != entry["sha256"] or actual["bytes"] != entry["bytes"]:
                raise ModelError("MODEL_DOWNLOAD_HASH", "模型目录与可信制品清单不一致。")
        expected = next((entry["sha256"] for entry in trusted if entry["path"] == main_name), None)
        expected = expected or row.get("sha256")
        result = self.inspector(str(main), expected)
        self.check_cancelled()
        if result.get("sha256") != files[main_name]["sha256"]:
            raise ModelError("MODEL_CHANGED", "模型验证期间内容发生变化。")
        for name, entry in files.items():
            if signature(under(payload, name)) != entry["fingerprint"]:
                raise ModelError("MODEL_CHANGED", "暂存模型文件发生变化。")
        if self.tree(payload) != {name: entry["fingerprint"] for name, entry in files.items()}:
            raise ModelError("MODEL_CHANGED", "暂存模型目录发生变化。")
        if row.get("dir") and (not trusted or set(files) != {entry["path"] for entry in trusted}):
            result.update(integrity="unverified", verificationNote="目录文件已检查；没有覆盖全部文件的可信摘要，尚不能确认完整目录与原版一致。")
        return result, main_name

    def snapshot(self, target):
        return self.tree(target, allow_empty=True) if checked(target).exists() else None

    def relocated_snapshot(self, path, row):
        result = self.snapshot(path)
        if result is not None and not row.get("dir") and path.is_file():
            return {Path(row["file"]).name: result[path.name]}
        return result

    def publish(self, key, stage, files, result, main_name, overwrite, previous):
        row = self.model(key)
        target = under(self.root, row.get("dir") or row["file"])
        payload = checked(stage / "payload")
        candidate = payload if row.get("dir") else under(payload, main_name)
        backup = checked(stage / "previous")
        if target.exists() and not overwrite:
            raise ModelError("MODEL_OVERWRITE_REQUIRED", "目标模型已存在，需在宿主确认覆盖后继续。")
        if self.snapshot(target) != previous:
            raise ModelError("MODEL_TARGET_CHANGED", "目标模型在操作期间发生变化，请重新确认。")
        target.parent.mkdir(parents=True, exist_ok=True)
        self.check_cancelled()
        commit = {"model": key, "target": row.get("dir") or row["file"], "directory": bool(row.get("dir")), "files": files, "previous": previous, "result": result, "main": main_name}
        atomic_json(stage / "commit.json", commit)
        try:
            if previous is not None:
                move_old(target, backup)
                actual = self.relocated_snapshot(backup, row)
                if actual != previous:
                    commit["previous"] = actual
                    atomic_json(stage / "commit.json", commit)
                    raise ModelError("MODEL_TARGET_CHANGED", "目标在提交期间被外部修改，已停止覆盖并恢复实际副本。")
            self.check_cancelled()
            publish_new(candidate, target)
            # The complete marker distinguishes committed data from a recoverable interrupted swap.
            receipt = {**result, "model": key, "files": files, "fingerprint": signature(under(self.root, row["file"])), "importedAt": time.time()}
            atomic_json(self.private / ("receipt-" + hashlib.sha256(key.encode()).hexdigest() + ".json"), receipt)
            atomic_json(stage / "complete.json", {"model": key, "token": self.token})
        except BaseException:
            self.recover_stage(stage)
            raise

    def recover_stage(self, stage):
        value = read_json(stage / "commit.json", 16 * BLOCK)
        row = self.model(value.get("model"))
        if value.get("target") != (row.get("dir") or row["file"]) or value.get("directory") != bool(row.get("dir")) or "previous" not in value:
            raise ModelError("MODEL_RECOVERY_REQUIRED", "模型提交记录目标不一致。")
        target, backup = under(self.root, value["target"]), checked(stage / "previous")
        rollback = checked(stage / "rollback-current")
        if (stage / "complete.json").exists():
            self.discard(stage)
            return
        prior = value["previous"]
        now = self.snapshot(target)
        staged = {name: entry["fingerprint"] for name, entry in value["files"].items()}
        if now == prior and not backup.exists():
            self.discard(stage)
            return
        if prior is not None:
            old = self.relocated_snapshot(backup, row)
            if old != prior:
                raise ModelError("MODEL_RECOVERY_REQUIRED", "旧模型副本发生变化，已保留暂存目录：" + str(stage))
        elif backup.exists():
            raise ModelError("MODEL_RECOVERY_REQUIRED", "提交记录出现未知旧副本：" + str(stage))
        if now is not None:
            if now != staged:
                raise ModelError("MODEL_RECOVERY_REQUIRED", "目标模型发生外部变化，已保留新旧副本：" + str(stage))
            move_old(target, rollback)
        if rollback.exists() and self.relocated_snapshot(rollback, row) != staged:
            if not target.exists():
                publish_new(rollback, target)
            raise ModelError("MODEL_RECOVERY_REQUIRED", "回滚期间目标发生外部变化，已保留实际文件和旧副本：" + str(stage))
        if prior is not None:
            publish_new(backup, target)
        self.discard(stage)

    def recover(self):
        for child in self.private.iterdir():
            if not re.fullmatch(r"(?:import-[0-9a-f]{32}|download-[0-9a-f]{64})", child.name):
                continue
            stage = self.stage(child.name, create=False)
            commit = stage / "commit.json"
            if not commit.exists():
                if (stage / "previous").exists():
                    raise ModelError("MODEL_RECOVERY_REQUIRED", "模型旧副本缺少提交记录，已保留暂存目录：" + str(stage))
                if stage.name.startswith("import-"):
                    self.discard(stage)
                continue
            self.recover_stage(stage)

    def import_model(self, key, source, overwrite=False):
        row = self.model(key)
        if not source or not Path(source).is_absolute():
            raise ModelError("MODEL_SOURCE_INVALID", "导入需要宿主原生选择的绝对路径。")
        source = checked(source)
        target = under(self.root, row.get("dir") or row["file"])
        if target.exists() and bool(row.get("dir")) != target.is_dir():
            raise ModelError("MODEL_TARGET_INVALID", "已存在的目标类型与登记模型不一致，请先核查目标。")
        previous = self.snapshot(target)
        if previous is not None and not overwrite:
            raise ModelError("MODEL_OVERWRITE_REQUIRED", "目标模型已存在，需在宿主确认覆盖后继续。")
        if source == target or source.is_relative_to(self.private) or (source.is_dir() and self.root.is_relative_to(source)):
            raise ModelError("MODEL_SOURCE_INVALID", "来源不能是目标本身或包含 V7 暂存目录。")
        if bool(row.get("dir")) != source.is_dir():
            raise ModelError("MODEL_SOURCE_INVALID", "此模型需要完整目录。" if row.get("dir") else "此模型需要单个文件。")
        before = self.tree(source)
        self.space(sum(value[2] for value in before.values()))
        stage = self.stage("import-" + uuid.uuid4().hex)
        payload = stage / "payload"
        payload.mkdir()
        files = {}
        try:
            for name, original in before.items():
                src = source / name if source.is_dir() else source
                dest_name = name if row.get("dir") else Path(row["file"]).name
                dest = under(payload, dest_name)
                if signature(src) != original:
                    raise ModelError("MODEL_CHANGED", "来源文件在导入前发生变化。")
                digest = self.copy(src, dest)
                if signature(src) != original:
                    raise ModelError("MODEL_CHANGED", "来源文件在复制期间发生变化。")
                files[dest_name] = {"sha256": digest, "bytes": dest.stat().st_size, "fingerprint": signature(dest)}
            if self.tree(source) != before:
                raise ModelError("MODEL_CHANGED", "来源目录在复制期间发生变化。")
            result, main = self.validate(key, payload, files)
            if self.tree(source) != before:
                raise ModelError("MODEL_CHANGED", "来源文件在验证期间发生变化。")
            self.publish(key, stage, files, result, main, overwrite, previous)
            self.discard(stage)
        except BaseException:
            if stage.exists() and not (stage / "commit.json").exists():
                self.discard(stage)
            raise

    def download_file(self, entry, path):
        checked(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        offset = path.stat().st_size if path.exists() else 0
        if offset > entry["bytes"]:
            raise ModelError("MODEL_DOWNLOAD_INVALID", "已有下载片段超过可信长度，请核查暂存目录。")
        if offset < entry["bytes"]:
            headers = {"Accept-Encoding": "identity", "User-Agent": "Wheelchair-V7-ModelManager/1"}
            if offset:
                headers["Range"] = "bytes=%s-" % offset
            request = urllib.request.Request(entry["url"], headers=headers)
            self.check_cancelled()
            with self.opener(request, timeout=30) as response:
                if urllib.parse.urlsplit(response.geturl()).scheme != "https":
                    raise ModelError("MODEL_DOWNLOAD_SOURCE", "下载响应必须来自 HTTPS。")
                status = response.status
                if offset and status == 200:
                    offset = 0
                elif status == 206:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if not match or tuple(map(int, match.groups())) != (offset, entry["bytes"] - 1, entry["bytes"]):
                        raise ModelError("MODEL_DOWNLOAD_RANGE", "下载断点响应范围或总长度不符。")
                elif status != 200:
                    raise ModelError("MODEL_DOWNLOAD_HTTP", "下载响应状态无效：%s" % status)
                if response.headers.get("Content-Encoding", "identity") not in ("", "identity"):
                    raise ModelError("MODEL_DOWNLOAD_INVALID", "下载响应不应转换文件编码。")
                length = response.headers.get("Content-Length")
                if length is not None and (not length.isdecimal() or int(length) != entry["bytes"] - offset):
                    raise ModelError("MODEL_DOWNLOAD_INVALID", "下载响应长度与可信制品不符。")
                with path.open("ab" if offset else "wb") as stream:
                    size = offset
                    while True:
                        self.check_cancelled()
                        block = response.read(min(BLOCK, entry["bytes"] - size + 1))
                        if not block:
                            break
                        size += len(block)
                        if size > entry["bytes"]:
                            raise ModelError("MODEL_DOWNLOAD_INVALID", "下载超出可信制品长度。")
                        stream.write(block)
                    stream.flush()
                    os.fsync(stream.fileno())
        if path.stat().st_size != entry["bytes"]:
            raise ModelError("MODEL_DOWNLOAD_INCOMPLETE", "下载未完成，已保留断点，原模型不变。")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while True:
                self.check_cancelled()
                block = stream.read(BLOCK)
                if not block:
                    break
                digest.update(block)
        if digest.hexdigest() != entry["sha256"]:
            # Only this known partial is discarded; the active model is untouched.
            path.unlink()
            raise ModelError("MODEL_DOWNLOAD_HASH", "下载摘要与可信制品不符，错误片段已丢弃，可重新下载。")
        return {"sha256": digest.hexdigest(), "bytes": path.stat().st_size, "fingerprint": signature(path)}

    def download(self, key, overwrite=False):
        row = self.model(key)
        target = under(self.root, row.get("dir") or row["file"])
        if target.exists() and bool(row.get("dir")) != target.is_dir():
            raise ModelError("MODEL_TARGET_INVALID", "已存在的目标类型与登记模型不一致，请先核查目标。")
        previous = self.snapshot(target)
        if previous is not None and not overwrite:
            raise ModelError("MODEL_OVERWRITE_REQUIRED", "目标模型已存在，需在宿主确认覆盖后继续。")
        entries = self.files(key)
        if not entries:
            raise ModelError("MODEL_DOWNLOAD_UNAVAILABLE", "该模型尚无可信固定下载制品，请导入已有模型。")
        identity = hashlib.sha256(json.dumps({"key": key, "files": entries}, sort_keys=True).encode()).hexdigest()
        stage = self.stage("download-" + identity)
        payload = checked(stage / "payload")
        payload.mkdir(exist_ok=True)
        self.space(sum(max(0, entry["bytes"] - (under(payload, entry["path"]).stat().st_size if under(payload, entry["path"]).exists() else 0)) for entry in entries))
        files = {}
        for entry in entries:
            files[entry["path"]] = self.download_file(entry, under(payload, entry["path"]))
        result, main = self.validate(key, payload, files)
        self.publish(key, stage, files, result, main, overwrite, previous)
        self.discard(stage)

    def run(self, action, key=None, source=None, overwrite=False):
        if action == "catalog":
            return self.catalog()
        if action == "cancel":
            return self.cancel()
        if action not in ("import", "download") or not self.token:
            raise ModelError("MODEL_OPERATION_INVALID", "写入操作必须指定有效操作编号。")
        self.current = None
        row = self.model(key)
        if row.get("dir"):
            directory_rename()
        self.owned(create=True)
        lock = Lock(self.private / "operation.lock")
        if not lock.handle:
            raise ModelError("MODEL_BUSY", "另一项模型操作尚未结束。")
        try:
            self.recover()
            cancel = checked(self.private / ("cancel-" + self.token + ".json"))
            if cancel.exists():
                raise ModelError("MODEL_OPERATION_REPLAY", "此操作编号已取消，请重新发起操作。")
            self.current = {"token": self.token, "action": action, "model": key, "status": "running", "startedAt": time.time()}
            self.write_operation()
            if action == "import":
                self.import_model(key, source, overwrite)
            else:
                self.download(key, overwrite)
            self.write_operation(status="complete", finishedAt=time.time())
        except BaseException as error:
            if self.current:
                self.write_operation(status="cancelled" if isinstance(error, Cancelled) else "failed", error=str(error), finishedAt=time.time())
            raise
        finally:
            lock.close()
        return self.catalog()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--action", choices=["catalog", "import", "download", "cancel"], required=True)
    parser.add_argument("--model")
    parser.add_argument("--source")
    parser.add_argument("--operation")
    parser.add_argument("--overwrite", action="store_true")
    # 后台下发的下载清单（可选）。不给就用随包那份（docs/128 §三-3-d）。
    parser.add_argument("--manifest")
    args = parser.parse_args()
    global MANIFEST_PATH
    if args.manifest:
        MANIFEST_PATH = checked(Path(args.manifest))
    manager = None
    try:
        manager = Manager(args.root, args.operation)
        result = manager.run(args.action, args.model, args.source, args.overwrite)
    except Exception as error:
        result = {"ok": False, "root": args.root, "models": {}, "operation": None}
        if manager:
            with contextlib.suppress(Exception):
                result.update(manager.catalog())
        result.update(ok=False, code=getattr(error, "code", "MODEL_OPERATION_FAILED"), error=str(error))
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
