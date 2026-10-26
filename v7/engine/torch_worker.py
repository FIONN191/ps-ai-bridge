# -*- coding: utf-8 -*-
"""独立子进程：只跑 PyTorch 那几样，绝不碰 DirectML。

为什么要有这个东西（2026-10-04 实测，docs/133）：
    同一个进程里【先建 DirectML 会话、再把张量放到显卡上】= 段错误（原生崩溃，
    没有 Python traceback，整个引擎当场没）。
    实测四组：
      A 只建 DirectML 会话 ....................... 正常
      E 建了会话 → 立刻删掉 → 用 torch 显卡 ...... 照样崩（雷埋下就收不回）
      G 完全不碰 DirectML → 用 torch 显卡 ........ 正常
      L 父进程有 DirectML + 【子进程】跑 torch ... 两边都活着 ✅
    ⇒ 解法就是 L：把 torch 那几样拆到独立进程，两边互不干扰。

⚠⚠ 这个文件【不许】创建任何 ONNX 会话 —— 那正是会埋雷的动作。
   所以下面把 CAPS["onnx"] 按死成 False、_AVAIL 清空，让所有 provider 相关
   代码都只走 CPU 分支（我们不用它，但不能让它建 DML 会话）。

用法（由 multi_engine_server.py 自动拉起，一般不用手敲）：
    py -X utf8 engine/torch_worker.py --port 37895 --models <模型目录> --parent-port 37894
"""
from __future__ import annotations

import os
import sys
import threading
import time


def _parse_args(argv):
    """先自己解析参数 —— 必须在 import 引擎模块【之前】做，因为它 import 时就读 sys.argv。"""
    out = {"port": 37895, "models": None, "parent_port": 0}
    for i, a in enumerate(argv):
        if a == "--port" and i + 1 < len(argv):
            out["port"] = int(argv[i + 1])
        elif a == "--models" and i + 1 < len(argv):
            out["models"] = argv[i + 1]
        elif a == "--parent-port" and i + 1 < len(argv):
            out["parent_port"] = int(argv[i + 1])
    return out


_ARGS = _parse_args(sys.argv)

# ⚠ 引擎模块 import 时会从 sys.argv 读 --models，所以这里得先把 argv 摆成它认得的样子
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
sys.argv = [sys.argv[0]]
if _ARGS["models"]:
    sys.argv += ["--models", _ARGS["models"]]

import multi_engine_server as E  # noqa: E402


# ═══════════════════════════════════════════════════════════
#  关键：把 ONNX 这条路彻底关死
# ═══════════════════════════════════════════════════════════
# ⚠ 只要这里漏了，_pick_provider 就会建一个 DML 会话 —— 雷就埋下了，
#   之后第一次 torch 推理整进程猝死。这两行是这个文件的命根子。
E.CAPS["onnx"] = False
E._AVAIL = []
E._PICKED["provider"] = "CPUExecutionProvider"
E._PICKED["why"] = "子进程只跑 PyTorch，不碰 DirectML（防止两者同进程崩溃）"
E._PICKED["probed"] = True


def _probe_torch():
    """探一次 torch。这里是【唯一】允许 import torch 的地方。"""
    try:
        import torch
        E.CAPS["torch"] = True
        E.CAPS["cuda"] = bool(torch.cuda.is_available())
        if E.CAPS["cuda"]:
            E._HW["vram_gb"] = round(
                torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1)
            E._HW["device_name"] = torch.cuda.get_device_name(0)
        else:
            E._HW["vram_gb"] = None
            E._HW["device_name"] = "CPU (PyTorch 子进程)"
        return True
    except Exception as e:
        E.CAPS["torch"] = False
        E.CAPS["cuda"] = False
        E._HW["vram_gb"] = None
        E._HW["device_name"] = "CPU"
        print("[子进程] [!] torch 用不了：%s" % e)
        return False


E._HW["probed"] = True          # 跳过引擎那套硬件探测（它会建 DML 会话）
_TORCH_OK = _probe_torch()


# ═══════════════════════════════════════════════════════════
#  父进程没了就自己退出（免得留下孤儿进程占显存）
# ═══════════════════════════════════════════════════════════
def _parent_watch():
    if not _ARGS["parent_port"]:
        return
    import http.client
    misses = 0
    # ⚠ 节奏（2026-10-10 实测调过）：
    #   原来 10 秒一轮、连续 3 次 ⇒ 最坏 40 秒才走（实测就是 40 秒）。
    #   用户那边看到的是"软件都关了半天，显存还占着"，所以收紧成 5 秒一轮、连续 2 次。
    #   现在最坏约 12~15 秒。
    #   ⚠ 为什么不改成 1 秒一轮、1 次就走：探测本身是发 HTTP，
    #     爹就算活着、某一次也可能因为忙而超时 —— 太激进会把自己误杀，
    #     那用户的抠像跑到一半就断了。
    INTERVAL, NEEDED = 5, 2
    while True:
        time.sleep(INTERVAL)
        # ⭐ 2026-10-10：父引擎正常关闭时会先把 _SHUTDOWN 置上，
        #   这里看到就立刻走，不用等它把端口关掉（那要好几秒）。
        if getattr(E, "_SHUTDOWN", {}).get("requested"):
            print("[子进程] 父引擎要求关闭，自己退出")
            os._exit(0)
        try:
            c = http.client.HTTPConnection("127.0.0.1", _ARGS["parent_port"], timeout=4)
            # ⚠ 2026-10-18：云端父引擎上了门锁（docs/237），探活也带上钥匙（本机没配锁时这是空操作）。
            c.request("GET", "/health", headers=E._access_headers())
            r = c.getresponse()
            r.read()
            c.close()
            misses = 0
        except Exception:
            misses += 1
            if misses >= NEEDED:
                print("[子进程] 父引擎连续 %d 次没应答，自己退出" % misses)
                # ⚠ 走 E._exit_now()：它会先还显存、再硬退。
                #   直接 os._exit(0) 的话，PyTorch 那 9.6GB 显存可能来不及还。
                try:
                    E._exit_now()
                except Exception:
                    os._exit(0)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass

    port = _ARGS["port"]
    print("[子进程] PyTorch 工作进程 | 127.0.0.1:%d" % port)
    print("[子进程] torch=%s cuda=%s device=%s"
          % ("有" if E.CAPS["torch"] else "无",
             "有" if E.CAPS["cuda"] else "无", E._HW["device_name"]))
    print("[子进程] 模型目录: %s" % E.models_dir())
    if not _TORCH_OK:
        print("[子进程] [!] 没有可用的 PyTorch —— 只跑 ONNX 的主引擎不受影响")

    if _ARGS["parent_port"]:
        threading.Thread(target=_parent_watch, daemon=True, name="parent-watch").start()
    # 闲置卸载照旧（省显存）
    threading.Thread(target=E._idle_watch, daemon=True, name="idle-watch").start()

    # ⭐ 2026-10-10：子进程也认 /shutdown。
    #   ⚠ 为什么加：父引擎正常关闭时会对子进程发 /shutdown（见 multi_engine_server._exit_now）。
    #     以前子进程只会"父引擎探活失败后自己走"（要等 30 秒）。
    #     有了这个口，关软件时子进程是【立刻】跟着走的，不留孤儿。
    #   ⚠ 口令跟父引擎是同一个（同一个环境变量传进来），
    #     所以本机别的程序照样踢不掉它。
    class _WorkerHandler(E.Handler):
        def do_GET(self):
            if E._access_denied(self):
                return
            if self.path.split("?")[0] == "/shutdown":
                supplied = str(self.headers.get("X-Engine-Token") or "")
                if not E._SHUTDOWN_TOKEN or supplied != E._SHUTDOWN_TOKEN:
                    self._send(403, {"ok": False, "error": "关闭口令不对或服务端没配口令"})
                    return
                print("[子进程] 收到正常关闭请求，退出并放掉显存")
                E._SHUTDOWN["requested"] = True
                self._send(200, {"ok": True, "shuttingDown": True, "pid": os.getpid()})
                threading.Thread(target=E._delayed_exit, daemon=True, name="shutdown").start()
                return
            E.Handler.do_GET(self)

    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(("127.0.0.1", port), _WorkerHandler)
    server.daemon_threads = True
    server.block_on_close = False
    print("[子进程] 监听 http://127.0.0.1:%d  (探活 /health)" % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[子进程] 关闭")


if __name__ == "__main__":
    main()
