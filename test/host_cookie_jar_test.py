#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""B28 cookiejar 链路：Netscape 写文件 + run_ytdlp 的 --cookies 接线。

判据来自 d-068 的判别结论：
  · yt-dlp 站点解析器内部读 cookiejar（_get_cookies），**只有 --cookies 填充**；
    header 形态对解析器不可见 —— 所以 job["cookies"] 必须落成 --cookies 临时文件，
    且抑制 --add-header Cookie:（两份同源 cookie 同发，一部分 CDN 因重复头 4xx）；
  · 临时文件里有登录态，**每一条退出路径都必须删**（薄壳 try/finally 收口）。

接线测试用 FakePopen 捕获 cmd 列表：cmd 批处理转发会二次解析参数里的 %
（--progress-template 的 %(progress...)s 经 %* 展开后重扫出坏变量引用，
实测报「'%' 不是内部或外部命令」）；要验证的参数构造与文件清理，
FakePopen 即可完整覆盖，不走 cmd 引号地狱。
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


# ---------------------------------------------------------------- [1] Netscape 写文件

print("[1] write_cookie_netscape：结构化 cookie → Netscape 七列")

check("空列表 → None（调用方走 header 老路）", D.write_cookie_netscape([]) is None)
check("None → None", D.write_cookie_netscape(None) is None)

cs = [{"domain": ".bilibili.com", "hostOnly": False, "path": "/", "secure": True,
       "expirationDate": 1900000000, "name": "SESSDATA", "value": "abc,def"}]
p = D.write_cookie_netscape(cs)
check("有 cookie 返回路径", p is not None and os.path.isfile(p))
text = open(p, encoding="utf-8").read()
check("文件带 Netscape 头", text.startswith("# Netscape HTTP Cookie File"))
cols = text.strip().splitlines()[1].split(chr(9))
check("七列", len(cols) == 7, cols)
check("含子域：domain 带点 + TRUE",
      cols[0] == ".bilibili.com" and cols[1] == "TRUE", cols[:2])
check("secure=TRUE", cols[3] == "TRUE")
check("expirationDate 原样", cols[4] == "1900000000")
check("名值原样（含逗号合法）", cols[5] == "SESSDATA" and cols[6] == "abc,def")
os.remove(p)

cs = [{"domain": "www.bilibili.com", "hostOnly": True, "path": "/x", "secure": False,
       "name": "buvid3", "value": "v"}]  # 无 expirationDate = 会话 cookie
p = D.write_cookie_netscape(cs)
cols = open(p, encoding="utf-8").read().strip().splitlines()[1].split(chr(9))
check("hostOnly：domain 不加点 + FALSE", cols[0] == "www.bilibili.com" and cols[1] == "FALSE")
check("path 原样", cols[2] == "/x")
check("secure=FALSE", cols[3] == "FALSE")
check("会话 cookie → 远期（写 0 会被 jar 当过期丢掉）", cols[4] == "2147483647")
os.remove(p)

cs = [{"domain": ".a.com", "hostOnly": False, "path": "/", "secure": False,
       "name": "bad", "value": "x" + chr(9) + "y"},
      {"domain": ".a.com", "hostOnly": False, "path": "/", "secure": False,
       "name": "", "value": "v"},
      {"domain": ".a.com", "hostOnly": False, "path": "/", "secure": False,
       "name": "good", "value": "v"}]
p = D.write_cookie_netscape(cs)
rows = [l for l in open(p, encoding="utf-8").read().strip().splitlines() if not l.startswith("#")]
check("坏行跳过（tab 值/空名），好行保留", len(rows) == 1 and "good" in rows[0], rows)
os.remove(p)

# ---------------------------------------------------------------- [2] run_ytdlp 接线（FakePopen 捕获 cmd）

print("[2] run_ytdlp：--cookies 接线 + header 抑制 + 临时文件清理")

MP4_HEAD = b"\x00\x00\x00\x18ftypmp42"

tmp = tempfile.mkdtemp(prefix="ms-cookiejar-")
try:
    captured = []
    seen_cookie_content = []   # FakeProc 构造时读 cookie 文件（跑完就删，只能当场读）

    class FakeProc(object):
        def __init__(self, args, **kwargs):
            captured.append(list(args))
            self.cmd = list(args)
            if "--cookies" in self.cmd:
                cp = self.cmd[self.cmd.index("--cookies") + 1]
                seen_cookie_content.append(open(cp, encoding="utf-8").read())
            self.returncode = 0
            self.pid = 0
            oi = self.cmd.index("--output")
            outtmpl = self.cmd[oi + 1]
            final = outtmpl.replace("%(ext)s", "mp4")
            d = os.path.dirname(final)
            if d and not os.path.exists(d):
                os.makedirs(d)
            with open(final, "wb") as f:
                f.write(MP4_HEAD + b"\x00" * 1000)
            lines = ["MSPROG|  5.0%| 1.2MiB/s| 00:01|1000|20000", "FILE:" + final]
            self.stdout = iter(lines)

        def wait(self):
            return 0

        def terminate(self):
            pass

    real_popen = D.subprocess.Popen
    D.subprocess.Popen = FakeProc
    # finish_verified 内部会探 ffprobe（也被 FakeProc 拦住污染 captured）——验
    # 证三层的前几层足够本测试，把 ffprobe 探测关掉
    real_ffprobe = D.ffprobe_tool
    D.ffprobe_tool = lambda: None

    def make_job(tag, with_cookies):
        return {
            "id": "ck-" + tag,
            "url": "https://www.bilibili.com/video/BVx/",
            "kind": "video",
            "filename": "cookie-test-" + tag + ".mp4",
            "outdir": os.path.join(tmp, "out-" + tag),
            "concurrency": 2,
            "cookie": "legacy=header",
            "cookies": ([
                {"domain": ".bilibili.com", "hostOnly": False, "path": "/",
                 "secure": True, "expirationDate": 1900000000,
                 "name": "SESSDATA", "value": "login-state"},
                {"domain": "www.bilibili.com", "hostOnly": True, "path": "/",
                 "secure": False, "name": "buvid3", "value": "anon"},
            ] if with_cookies else None),
        }

    # --- 2a: 带 cookies → --cookies + 抑制 legacy header + 文件删除
    D.run_ytdlp(make_job("jar", True), "fake-ytdlp", None)
    st = D.read_status("ck-jar")
    check("带 cookies：任务走完 done", st.get("status") == "done", st.get("status"))
    cmd = captured[-1]
    check("argv 含 --cookies", "--cookies" in cmd, cmd[:8])
    ci = cmd.index("--cookies") if "--cookies" in cmd else -1
    cookie_path = cmd[ci + 1] if ci >= 0 else ""
    content = seen_cookie_content[0] if seen_cookie_content else ""
    check("cookie 文件是 Netscape 格式（两条 cookie 都在）",
          content.startswith("# Netscape HTTP Cookie File")
          and "SESSDATA" in content and "buvid3" in content, content[:160])
    check("argv 不含 --add-header Cookie:（重复头会让部分 CDN 4xx）",
          not any(isinstance(a, str) and a.lower().startswith("cookie:") for a in cmd),
          cmd[-8:])
    check("cookie 临时文件用完即删", bool(cookie_path) and not os.path.exists(cookie_path))

    # --- 2b: 不带 cookies → legacy header 原路，无 --cookies
    D.run_ytdlp(make_job("hdr", False), "fake-ytdlp", None)
    st = D.read_status("ck-hdr")
    check("不带 cookies：老路 done", st.get("status") == "done", st.get("status"))
    cmd2 = captured[-1]
    check("老路：--add-header Cookie: 还在",
          any(isinstance(a, str) and a.lower().startswith("cookie:")
              for a in cmd2), cmd2[-6:])
    check("老路：没有 --cookies", "--cookies" not in cmd2)

    # --- 2c: 异常路径也删文件（try/finally 的意义）
    job = make_job("boom", True)
    seen_by_boom = []   # boom 收到的 cf 是包装器自己写的临时文件（不是我另造的）
    calls = {"n": 0}
    real_inner = D._run_ytdlp

    def boom(j, y, f, cf):
        calls["n"] += 1
        seen_by_boom.append(cf)
        assert os.path.isfile(cf)   # 进主体前文件在
        raise RuntimeError("boom")

    D._run_ytdlp = boom
    try:
        D.run_ytdlp(job, "fake-ytdlp", None)
        raised = False
    except RuntimeError:
        raised = True   # finally 不吞异常：主体炸了原样穿透（语义正确）
    D._run_ytdlp = real_inner
    check("主体抛异常时 cookie 文件也被删、异常照常穿透（finally 收口）",
          calls["n"] == 1 and raised and seen_by_boom
          and not os.path.exists(seen_by_boom[0]))

    D.ffprobe_tool = real_ffprobe
    D.subprocess.Popen = real_popen
finally:
    if "D" in dir() and D.subprocess.Popen.__name__ == "FakeProc":
        D.subprocess.Popen = real_popen
    shutil.rmtree(tmp, ignore_errors=True)

print()
print("=" * 50)
if ok:
    print("全部通过")
    sys.exit(0)
print("有失败项")
sys.exit(1)
