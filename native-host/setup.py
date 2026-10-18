#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Media Sniffer 本地组件安装器

用法：
    python setup.py install      安装（写 manifest + 注册表）
    python setup.py uninstall    卸载（清注册表）
    python setup.py status       查看当前状态
"""
import json
import os
import subprocess
import sys

HOST_NAME = "com.starmediasniffer.host"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAUNCHER = os.path.join(HERE, "run_host.bat")
MANIFEST = os.path.join(HERE, "host_manifest.json")

REG_ROOTS = [
    (r"Software\Google\Chrome\NativeMessagingHosts", "Chrome"),
    (r"Software\Microsoft\Edge\NativeMessagingHosts", "Edge"),
    (r"Software\Chromium\NativeMessagingHosts", "Chromium"),
]


def out(msg=""):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print(msg)


DEFAULT_EXT_ID = "fofimjophfaibckjioaffoglkidppifo"


def extension_id():
    """扩展 ID 从 keys/ext_id.txt 读；没有就用默认值。

    正常情况直接命中默认值——`extension/manifest.json` 里写死了 `key`，
    Chrome 由 key 推出的 ID 恒为 DEFAULT_EXT_ID，所以 `keys/` 只是重新打包
    .crx 时才需要的私钥材料，**删掉也不影响安装**。
    """
    p = os.path.join(ROOT, "keys", "ext_id.txt")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                s = f.read().strip()
            if s:
                return s
        except OSError:
            pass
    return DEFAULT_EXT_ID


def write_manifest():
    manifest = {
        "name": HOST_NAME,
        "description": "Media Sniffer native host (yt-dlp bridge)",
        "path": LAUNCHER,
        "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % extension_id()],
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest


def write_python_path():
    with open(os.path.join(HERE, "python_path.txt"), "w", encoding="utf-8") as f:
        f.write(sys.executable)
    return sys.executable


def reg_add(root, value):
    try:
        import winreg
    except ImportError:
        out("[x] 只能在 Windows 上运行")
        return False
    key_path = root + "\\" + HOST_NAME
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_WRITE) as k:
            winreg.SetValueEx(k, None, 0, winreg.REG_SZ, value)
        return True
    except OSError as e:
        out("    [x] 写注册表失败 %s: %s" % (key_path, e))
        return False


def reg_del(root):
    try:
        import winreg
    except ImportError:
        return False
    key_path = root + "\\" + HOST_NAME
    for hive in (winreg.HKEY_CURRENT_USER,):
        try:
            winreg.DeleteKey(hive, key_path)
            return True
        except FileNotFoundError:
            return False
        except OSError:
            return False
    return False


def reg_get(root):
    try:
        import winreg
    except ImportError:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, root + "\\" + HOST_NAME) as k:
            val, _ = winreg.QueryValueEx(k, None)
            return val
    except OSError:
        return None


PROJECT_BIN = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin"
)


def find_tool(names):
    import shutil
    # 优先用项目自带的 bin/（随插件一起分发，不依赖系统 PATH 和 C 盘）
    for n in names:
        for cand in (n, n + ".exe"):
            p = os.path.join(PROJECT_BIN, cand)
            if os.path.exists(p):
                return p
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for base in [
        os.path.join(os.path.expanduser("~"), ".venvs", "agent-reach", "Scripts"),
        os.path.join(os.path.expanduser("~"), "scoop", "shims"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Links"),
    ]:
        for n in names:
            for cand in (n, n + ".exe"):
                p = os.path.join(base, cand)
                if os.path.exists(p):
                    return p
    return None


def cmd_install():
    out("=" * 64)
    out(" Media Sniffer 本地组件安装")
    out("=" * 64)

    py = write_python_path()
    out("[1/3] Python 解释器 : %s" % py)

    m = write_manifest()
    out("[2/3] Host manifest : %s" % MANIFEST)
    out("      path = %s" % m["path"])
    out("      origin = %s" % m["allowed_origins"][0])

    ok = 0
    out("[3/3] 注册表")
    for root, label in REG_ROOTS:
        if reg_add(root, MANIFEST):
            out("      ✓ %s" % label)
            ok += 1
    if not ok:
        out("      [x] 一个都没写成功")

    out("")
    out("-" * 64)
    ytdlp = find_tool(["yt-dlp"])
    ffmpeg = find_tool(["ffmpeg"])
    out(" yt-dlp : %s" % (ytdlp or "未找到  ← 下载会退化到单线程通用下载"))
    out(" ffmpeg : %s" % (ffmpeg or "未找到  ← DASH 音视频合并会失败"))
    if not ffmpeg:
        out("          安装: winget install Gyan.FFmpeg")
        out("          或把 ffmpeg.exe / ffprobe.exe 放进 %s" % PROJECT_BIN)
    out("-" * 64)
    out("")
    out("下一步：")
    out("  1. 打开 chrome://extensions，开启右上角「开发者模式」")
    out("  2. 点「加载已解压的扩展程序」，选择：")
    out("     %s" % os.path.join(ROOT, "extension"))
    out("  3. 装好后扩展 ID 必须是 %s" % extension_id())
    out("  4. 重新加载扩展（改过安装脚本需要 reload 一次）")


def cmd_uninstall():
    out("卸载 Media Sniffer 本地组件 …")
    for root, label in REG_ROOTS:
        if reg_del(root):
            out("  ✓ 已移除 %s" % label)
        else:
            out("  - %s 无记录" % label)
    out("  扩展本身请在 chrome://extensions 里手动移除")


def cmd_status():
    out("扩展 ID     : %s" % extension_id())
    out("Launcher    : %s (%s)" % (LAUNCHER, "存在" if os.path.exists(LAUNCHER) else "缺失"))
    out("Manifest    : %s (%s)" % (MANIFEST, "存在" if os.path.exists(MANIFEST) else "缺失"))
    for root, label in REG_ROOTS:
        v = reg_get(root)
        out("%-8s: %s" % (label, v or "未注册"))
    if not os.path.exists(MANIFEST) or not any(reg_get(r) for r, _ in REG_ROOTS):
        out("")
        out("! 还没装（或装到了别的目录）。双击 install.bat，或跑：")
        out("    python setup.py install")
        out("  它会生成 host_manifest.json + python_path.txt 并写注册表。")
        out("  仓库里不带这两个文件——它们记录的是**本机**绝对路径，每台机器不同。")
    out("yt-dlp      : %s" % (find_tool(["yt-dlp"]) or "未找到"))
    out("ffmpeg      : %s" % (find_tool(["ffmpeg"]) or "未找到"))
    try:
        sys.path.insert(0, HERE)
        import library
        out("文件存放处  : %s" % library.library_dir())
    except Exception as e:  # 只影响展示，不影响安装
        out("文件存放处  : 读取失败 %s" % e)

    # 实测一次协议握手
    out("")
    out("协议自检 …")
    try:
        p = subprocess.run(
            [sys.executable, os.path.join(HERE, "sniffer_host.py")],
            input=b"",
            capture_output=True,
            timeout=10,
        )
        if p.returncode == 0:
            out("  ✓ 宿主可正常启动（stdin 关闭后自行退出）")
        else:
            out("  ! 退出码 %s" % p.returncode)
            if p.stderr:
                out("    " + p.stderr.decode("utf-8", "replace")[:400])
    except Exception as e:
        out("  x 自检失败: %s" % e)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "install"
    if action == "install":
        cmd_install()
    elif action == "uninstall":
        cmd_uninstall()
    elif action == "status":
        cmd_status()
    else:
        out("用法: python setup.py [install|uninstall|status]")
