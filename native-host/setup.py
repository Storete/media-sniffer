#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Media Sniffer 本地组件安装器

用法：
    python setup.py install      安装（写 manifest + 注册表）
    python setup.py uninstall    卸载（清注册表）
    python setup.py status       查看当前状态
    python setup.py bin          说明 ffmpeg 怎么弄、自检宿主能不能起来

安装到底在做什么（三步，缺一不可）：
  1. 写 python_path.txt —— 记下当前这个 Python 解释器，run_host.bat 要用
  2. 写 host_manifest.json —— 浏览器据此知道去哪启动宿主、允许哪个扩展调用
  3. 写注册表 HKCU\\Software\\<浏览器>\\NativeMessagingHosts\\<host_name>
     —— 让浏览器能「找到」上面那个 manifest

只写 HKEY_CURRENT_USER，不需要管理员权限；Chrome/Edge/Chromium 各注册一份，
同一份脚本通吃三个浏览器。

注意：manifest 里记的是**本机绝对路径**，所以它不进仓库（见 .gitignore），
每台机器装一次生成一次。
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
    """打印。Windows 控制台默认是 GBK/cp1252，中文会炸 UnicodeEncodeError，
    这里强制 UTF-8 + errors=replace（replace 是兜底：某些管道不支持重设，
    宁可显示成 ? 也不能因为打印一个中文就把安装流程打断）。"""
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
    """生成 host_manifest.json。

    三个字段是浏览器的硬要求，写错一个宿主就起不来：
      · path：**必须是可执行文件**。这里是 run_host.bat 而不是
        "python sniffer_host.py"——Chrome 不接受带参数的命令行
      · type：stdio（本项目用的协议）
      · allowed_origins：只放行这一个扩展 ID，别的扩展调不动宿主

    注意 path 是绝对路径，所以这个文件不能进仓库（每台机器不同）。
    """
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
    """记下当前解释器的绝对路径，run_host.bat 启动宿主时优先用它。

    为什么要记：Chrome 启动宿主时的 PATH 跟用户终端里的不一样，经常
    找不到 python（或找到另一个没有依赖的 python）。写死路径最省事。
    跨机器/换 Python 版本后重跑一次 install 即可。
    """
    with open(os.path.join(HERE, "python_path.txt"), "w", encoding="utf-8") as f:
        f.write(sys.executable)
    return sys.executable


def reg_add(root, value):
    """在 HKCU 下建键并把默认值设为 manifest 路径。

    用 HKEY_CURRENT_USER 而不是 LOCAL_MACHINE：不需要管理员权限，
    这也是 Chrome 文档推荐的用户级位置（HKLM 那份是给全机器安装用的）。
    建键用 CreateKeyEx 而不是 CreateKey：后者在已存在时会带写权限打开，
    行为更隐晦，前者语义明确。
    """
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
    """删掉注册表键（默认值随之消失）。键不存在返回 False，不报错 ——
    卸载一个本来就没装的东西不该是「失败」。"""
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
    """读注册表默认值（manifest 路径）。没注册返回 None。"""
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
    """完整安装流程。顺序不能换：先写 python_path（run_host.bat 依赖它），
    再写 manifest，最后写注册表（注册表指向 manifest，manifest 必须先存在）。"""
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
    """只清注册表，不动文件、不动扩展。

    刻意不删 host_manifest.json / python_path.txt：用户可能只是想让浏览器
    别再调它，过两天又装回来；而且删了 Python 也删不掉别的 Python，
    留着无害。
    """
    out("卸载 Media Sniffer 本地组件 …")
    for root, label in REG_ROOTS:
        if reg_del(root):
            out("  ✓ 已移除 %s" % label)
        else:
            out("  - %s 无记录" % label)
    out("  扩展本身请在 chrome://extensions 里手动移除")


def cmd_status():
    """体检。除了列出各浏览器的注册值，还要**判断注册表指向的是不是本目录**。

    这是排查「改了代码不生效」的关键一步：仓库可能有多份拷贝（下载解压了
    两次、或 Git 工作区 + 旧目录），注册表指向的是哪份，浏览器就调哪份。
    只显示路径不判断会让人盯着新代码死活想不通。
    """
    out("扩展 ID     : %s" % extension_id())
    out("Launcher    : %s (%s)" % (LAUNCHER, "存在" if os.path.exists(LAUNCHER) else "缺失"))
    out("Manifest    : %s (%s)" % (MANIFEST, "存在" if os.path.exists(MANIFEST) else "缺失"))
    for root, label in REG_ROOTS:
        v = reg_get(root)
        out("%-8s: %s" % (label, v or "未注册"))

    # 注册表指向本目录才算「当前这份代码装好了」。
    # 注册表指向别处 = 装的是另一份拷贝，浏览器调的是那边，改这里不会生效。
    registered = [reg_get(r) for r, _ in REG_ROOTS]
    registered = [v for v in registered if v]
    mine = os.path.normcase(os.path.abspath(MANIFEST))
    if not os.path.exists(MANIFEST):
        out("")
        out("! 这份代码还没装。双击 install.bat，或跑：")
        out("    python setup.py install")
        out("  它会生成 host_manifest.json + python_path.txt 并写注册表。")
        out("  仓库里不带这两个文件——它们记录的是**本机**绝对路径，每台机器不同。")
    elif not any(os.path.normcase(os.path.abspath(v)) == mine for v in registered):
        out("")
        out("! 注册表指向的是另一份拷贝：")
        for v in dict.fromkeys(registered):
            out("    %s" % v)
        out("  浏览器现在调的是那里，**改当前目录的代码不会生效**。")
        out("  要用这份代码，重跑 install.bat 覆盖注册表。")


def cmd_build_stub():
    """说明为什么 bin/ 不进仓库。"""
    out("bin/ 用来放 ffmpeg，但它不进仓库——两个 exe 合计约 323 MB，")
    out("超过 GitHub 单文件 100 MB 上限，一旦提交就会永久留在 Git 历史里。")
    out("")
    out("要自备的话，两条路任选：")
    out("  1. 装到系统 PATH：  winget install Gyan.FFmpeg")
    out("  2. 放进 %s" % PROJECT_BIN)
    out("     ffmpeg.exe / ffprobe.exe 放进去即可，程序优先用这里的。")
    out("")
    out("当前状态：ffmpeg = %s" % (find_tool(["ffmpeg"]) or "未找到"))
    ffprobe = find_tool(["ffprobe"])
    out("          ffprobe = %s" % (ffprobe or "未找到（B 站合并需要它校验流）"))
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
    elif action == "bin":
        cmd_build_stub()
    else:
        out("用法: python setup.py [install|uninstall|status|bin]")
