# 开发文档

面向**要改这个扩展代码的人**。安装和使用看 [README](README.md)。

这里只讲「代码为什么长这样」——架构、关键决策、以及**踩过的坑**。如果你正打算动某块代码，
先在这份文档里搜一下相关关键词，很可能有人（包括我）已经踩过同一个坑了。

> **配套的 [开发日志 DEVLOG](DEVLOG.md)**：本文只放**结论**，每条结论后面都带
> [`d-NNN`](DEVLOG.md) 编号链接，点过去能看到完整过程——当时遇到什么现象、怎么排查、
> 试过什么失败、最后为什么这么改。想知道「为什么是这样」而不只是「是这样」，就点进去。

---

## 1. 代码地图

```
extension/
├── manifest.json      MV3 清单。内含 RSA 公钥 → 扩展 ID 恒定
├── background.js      service worker：webRequest 嗅探 + 分类归档 + 调宿主
├── inject-main.js     ★ 页面主世界 hook（MAIN world, document_start）
├── content.js         isolated world 搬运层（页面 ↔ 扩展）
├── sniffer-hostport.js  页面侧的宿主端口封装
└── popup.html/css/js  列表界面

native-host/
├── sniffer_host.py    Native Messaging 宿主（stdio，4 字节长度 + JSON）
├── downloader.py      独立下载进程（detached，不随浏览器退出）
├── library.py         下载目录定位（唯一真源）
└── setup.py           安装 / 卸载 / 自检
```

**三份代码的职责边界**（最容易搞混的地方）：

| 谁说 | 谁做 | 为什么 |
|---|---|---|
| `background.js` | 嗅探、分类、按 tab 归档 | `webRequest` 只有它有 |
| `inject-main.js` | 真正抓流、写页面浮层 | 需要页面上下文（cookie / 手势 / 页面自己的 API） |
| `native-host` | 落盘、合并、调 yt-dlp | 浏览器里写不了任意路径 |

---

## 2. 架构

```
┌──────────────── Chrome ────────────────────────────┐
│ inject-main.js (MAIN world)  ← 关键：能改页面自己的 API
│   hook URL.createObjectURL        → 拿 Blob 本体
│   hook <video>.src / setAttribute  → 拿 blob URL + 标题
│   轮询 video.currentSrc (600ms)    → 兜底，任何赋值方式都能拿到
│   hook MediaSource.appendBuffer    → MSE 流累积分片
│   hook fetch / XMLHttpRequest      → 记录原生媒体请求
│   Range 链下载 runRangeDownload    → 分块、6~8 并发、按序写盘
│   B 站分支 runBiliDownload         → 读 __playinfo__ 的 DASH 清单
│   页面内浮层 / 进度卡               → 保存按钮画在页面里，手势不丢
│            ↕ window.postMessage
│ content.js (isolated) ← 搬运层
│            ↕ chrome.runtime
│ background.js
│   webRequest 嗅探所有 http(s) → 按 mime/扩展名/URL 特征分类
│   connect("ms-host-bridge") → 页面 ↔ Native Host 的双向端口桥
│   chrome.tabs.sendMessage({frameId:0}) 下发保存指令
│            ↕ Native Messaging（4 字节长度 + JSON，stdin/stdout）
└────────────────────────────────────────────────────┘
             ↕
  sniffer_host.py  随用随起；msfile_start/chunk/end/abort 流式写盘
             ↕ detached（不随浏览器退出而死）
  downloader.py    视频/音频 → yt-dlp -N 16（带 ffmpeg 合并）；其他 → urllib 断点续传
             ↕
  落点：library.library_dir() 决定（环境变量 MEDIA_SNIFFER_OUTDIR 可覆盖）
  日志：%LOCALAPPDATA%\MediaSniffer\host.log
```

### 为什么要页面内 hook

`webRequest` 只能看到 URL。Telegram 这类站点：

```
MTProto 分块 → 浏览器端解密 → 拼成 Blob / 喂进 MSE → <video src="blob:...">
```

网络层全是 `POST /apiw1` 二进制包，`content-type` 是 `application/octet-stream`，
没有 `.m3u8`、没有 `.mp4`。**只靠 URL 匹配的嗅探在这里必然是瞎的。**

### 为什么下载进程要 detach

MV3 的 service worker 随时会被回收（30 秒无事件）。下载必须独立存活，
否则用户关掉弹窗下载就断了。实测：宿主退出后下载仍在继续。

---

## 3. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 用 Native Messaging，不用本地 HTTP 服务 | 不用常驻端口、不用手动启动，随用随起 |
| 下载进程 detached | service worker 会被回收，下载必须独立存活 |
| 固定扩展 ID（`manifest.json` 内置公钥） | 宿主 `allowed_origins` 只需配一次；别人改 ID 用不了本地程序 |
| 页面内 hook 用 MAIN world | isolated world 改不到页面自己的 `URL.createObjectURL` |
| 轮询 `currentSrc` 兜底 | 唯一能覆盖所有 src 赋值方式（property / setAttribute / `<source>`） |
| **不在 SW 里下载，改由页面自己抓 + 直传宿主** | Telegram 的 `/progressive/` 媒体只认页面上下文（带 `Range`、同源 cookie），SW 里一次最多 512KB；实测 800MB 文件要 1600+ 次往返，且 SW 30 秒无事件被回收 |
| **保存按钮画在页面里（浮层）** | popup 的点击手势传不到页面，无手势的 `fetch` 在很多站点会被拦；按钮渲染到页面，手势和下载就在同一个栈里 |
| **宿主自己写文件**（`msfile_start/chunk/end/abort`） | 数据从页面分段递来（二进制安全），宿主按序写盘，内存只占几十 MB；失败/取消会删残文件 |
| 总长问不出来时先 `Content-Range */N` → HEAD → `Range: bytes=-1` | 直接拿第一段当全长只会存下第一段，这是最容易踩的坑 |
| **下载目录统一由 `library.py` 决定** | 以前 `sniffer_host.py` 和 `downloader.py` 各写一份，改一处漏一处 |
| 嗅探到的媒体长度不信第一个响应头 | `webRequest` 拿到的是分段响应，`content-length` 只是这一段；改成「只增不减」取最大值 |
| 不用 `--load-extension` 做真机验证 | Chrome/Edge 155 都已禁用；改用浏览器级 CDP `Extensions.loadUnpacked`（**路径必须正斜杠**），之后还要 `Page.reload` |
| 不在 B 站显示 MSE 录制条目 | 它们只含已播放片段，必然残缺；改用 `__playinfo__` 的 DASH 完整清单 |

---

## 4. 踩过的坑（别重复）

> 这里是**结论速查**。每条背后「当时怎么发现的」在 [DEVLOG](DEVLOG.md) 里，需要细节点过去。

### 4.1 yt-dlp / 进程

| 坑 | 现象 | 解法 |
|---|---|---|
| `--progress-template "download:..."` | 解析永远匹配不到 | 那个 `download:` 是**选择器**不是输出前缀，改用自定义标记 `MSPROG\|` |
| `CREATE_BREAKAWAY_FROM_JOB` | `WinError 5 拒绝访问` | 只用 `DETACHED_PROCESS \| CREATE_NO_WINDOW` 就够 |
| 跨盘 `mv` | 复制完删不掉，`Device or resource busy` | 有残留进程锁目录；先 Stop-Process 再清 `__pycache__` |
| 把 Telegram 的 `document…` 丢给 yt-dlp | `ERROR: [generic] document6…: HTTP Error 302`（相对地址被当网页去爬） | 页面媒体只给页面内的「保存」；`downloader.py` 对非 http(s) 直接拒绝 |

### 4.2 Range 下载与写盘（错得最隐蔽的一类）

| 坑 | 现象 | 解法 |
|---|---|---|
| `fetchRange(key, 0, cb)` 当首段 | `end` 是包含式，多要 1 字节 → 后续段起点对不上 `written`，文件 0 字节 | 传 `cb - 1`，并按实收字节数回写段长 |
| `writeNext` 用 `k >= written` | 跳过缺口乱写，大小对但内容错位、播放不了 | `k === written`，且 `written` 必须在 `await` **之前**占位推进、失败回滚 |
| `hostRequest` 覆盖 `payload.id` | chunk 全被宿主静默丢弃，文件永远 0 字节 | `const id = payload.id \|\| ("msf-" + ...)` |
| `maybeDone` 漏判最后一小段 | 卡在 99%，`await` 永不返回 | 加 `if (written < total) return;`，并让 writeNext 链尾催一次 |
| 宿主 `msfile_chunk` 只顺序追加 | 页面 90s 超时重试 → 同一段写两遍 → 大小对、内容整体错位 | 认 `text: "bytes=<start>-"` 里的偏移，`fh.seek(start)` 覆写；`written` 记最高水位 |
| background 回执按 `requestId` 匹配、注册却用 `id` | 真机上 `msfile_*` 回执永远找不到归属端口 | 匹配键统一用 `msg.id`（全链路只有这一个 id） |
| `msfile_chunk` 也挂 120s 超时定时器 | 每条闭包抓住大 `data`，120 秒堆 1GB+，SW 直接崩 | `WATCHED_ACTIONS` 白名单，只盯 `msfile_start/end/abort` |

### 4.3 并发与缓存

| 坑 | 现象 | 解法 |
|---|---|---|
| Telegram SW 流开 8 并发 | 8 段 4620ms，**4 段只要 891ms**；表现为「卡在 17%（正好前 3 段）」 | `PARALLEL = 4`，别再加回去 |
| SW 流用 `cache:"force-cache"` | 未缓存段 6291ms，`no-store` 只要 3673ms | `include` 模式用 `no-store`；`omit` 仍用 `reload` |
| B 站 CDN `cache:"force-cache"` | 单段 7409ms，看起来像卡死 | 按凭据分流，最终统一成 `include` → `no-store` |
| B 站 CDN `credentials:"include"` | `TypeError: Failed to fetch`，第一个请求就炸 | 先 `omit` 失败再 `include`，**顺序不能反**（include 失败要等 3.3 秒） |

### 4.4 页面 hook

| 坑 | 现象 | 解法 |
|---|---|---|
| Telegram 视频以为是 blob | hook `createObjectURL` 完全抓不到 | 它是 `/a/progressive/document<id>` 的 **HTTP 直链**；靠轮询 `currentSrc` 才能发现 |
| `video.src = x` 不等于 `setAttribute('src', x)` | 只 hook property setter 会漏 | 三种都 hook（property / setAttribute / 轮询 `currentSrc`） |
| MAIN world hook 装到 `chrome-extension://` 页面 | 打开扩展详情页时控制台刷红字 | 入口加协议守卫：**只有明确不是 http(s) 才退出，读不到 location 照常工作**。`__MS_SNIFFER_MAIN__` 标记必须放在守卫**之后**，否则非网页环境也会留下「已装 hook」的假标记 |
| `guessTitle` 直接取 `.text-content` 的 `textContent` | 标题变成「正文 + 94.4K + dd ch + 14:58」粘成 84 字 | `cloneNode(true)` 后删掉 `.MessageMeta` 等再取；**必须 clone，直接改原节点会删掉页面的消息内容** |
| 标题直接当文件名 | 落盘是「一整句话.mp4」 | `fileNameTitle()` 收到 60 字符 + `…`，四个入口都过；`popup.js` 另有 `shortTitle()` |
| JSDoc 注释里写 `Content-Range */N` | `*/` 提前闭合块注释，`SyntaxError: Unexpected identifier` | 用文字描述，别在注释里出现 `*/` |
| **`const` 定义在使用点之后** | 页面加载第一次轮询就 `ReferenceError`，整个 IIFE 挂掉、**扩展全废** | `const` 有暂时性死区。新增函数要么用 `function`（会提升），要么把定义挪到调用点之前 |

### 4.5 消息与生命周期

| 坑 | 现象 | 解法 |
|---|---|---|
| background 自己广播消息 | 消息回灌到自己的 onMessage，走 default 分支 | `native:progress` / `ms:saved` 等类型 early return |
| `chrome.tabs.sendMessage` 不指定 frame | 所有 iframe 都收到，跨域 fetch 失败顶掉正确结果 | 传 `{frameId: 0}`，失败再回退广播 |
| `msfile_chunk` 回执缺 `inProgress` | 第一个文件能下，第二个就开始「本地下载器无响应」 | 所有在途回执都带 `inProgress: true` |
| `chrome.runtime.sendMessage` 找不到接收方 | popup 按钮卡在 `…` 不动（它直接抛异常，不走回调） | 用 `try/catch` 包住，失败提示「页面未连接（请刷新页面再试）」 |

### 4.6 测试桩（写得对但测不出来）

| 坑 | 现象 | 解法 |
|---|---|---|
| Node vm 测试环境缺全局 | `AbortController is not defined`、`Element is not defined` | 沙箱里显式注入 |
| 测试桩 `get parentElement() { return null; }` | 后代链永远空，相册/气泡标题两条路径**测了等于没测**——写入静默失败，断言全绿 | 改成可写 `get/set parentElement`；桩还要带 `nodeType = 1` |
| 以为 `/^Album\b\|album-item/` 是坏正则 | 一度怀疑它恒假、准备重写 | 其实是对的；「测不出来」是桩的问题。**改代码前先确认是代码错还是测试桩错** |
| Node vm 测试跨 realm 传回包 | 「回包明明送到，请求却永远不 resolve」，`msg.id !== id` 静默失配 | 回包事件对象用 `vm.runInContext` **在沙箱内构造** |
| Python 测试只改 `D.JOBS_DIR` | 断言读到上一次运行的残留状态文件，假失败 | 把 `D.status_path` 一起指到临时目录 |
| 觉得「产物出现 = 源流已删」 | 8 套并发跑时偶发 FAIL（unlink 在写状态之后，有毫秒级窗口） | 轮询 10 秒窗口再断言，别用瞬时判断 |
| 数据帧从 number 数组改成 `{__b64}` 后 | `payload.data.length` 算的是 base64 长度，比真实字节大 4/3 | 断言统一走 `decodeChunk()` 解码后再数 |

### 4.7 平台差异

| 坑 | 现象 | 解法 |
|---|---|---|
| GitHub Windows runner 默认 cp1252 | 测试脚本一 `print` 中文就 `UnicodeEncodeError` | 子进程强制 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`，脚本自己也 `reconfigure` |
| Chrome/Edge 155 禁用 `--load-extension` | 传统真机验证方法失效 | 用浏览器级 CDP `Extensions.loadUnpacked`（**路径必须正斜杠**），返回 id 后还要 `Page.reload` |
| 改了 `inject-main.js` 只刷新扩展 | 页面里仍是旧脚本 | **`loadUnpacked` + 刷新页面两步都做**。反过来只刷新页面也不行 |
| `library.py` 分两轮扫候选目录 | C 盘旧目录永远压过 D 盘首选 | 改成一轮「存在**或**可建」判定，候选顺序优先 |

---

## 5. 测试

```bash
# JS（Node 18+，不需要 npm install）
node test/main-hook.test.js        # inject-main.js，120 项
node test/background.test.js       # background.js，88 项
node test/range_parallel.test.js   # Range 并发下载，14 项

# Python（不需要 pytest）
python test/run_all.py
```

三个 JS 套件都靠 **vm 沙箱 + 假宿主**跑，不启动浏览器。新增 hook 逻辑时优先看
`test/main-hook.test.js` 里现成的假 document / 假宿主怎么搭的。

CI（`.github/workflows/tests.yml`）在每次 push / PR 自动跑：JS 三套 × Node 18/20/22，
Python 套件在 Ubuntu（3.9 / 3.12）和 Windows（3.12）上跑。没装 ffmpeg 的环境里
`host_merge` / `bili_stream` 自动 SKIP 而不是 FAIL。

---

## 6. 改动后必须做的事

| 改了什么 | 要做什么 |
|---|---|
| `background.js` / `popup.js` | `chrome://extensions` 点扩展卡片的刷新按钮 |
| **`inject-main.js`** | **`loadUnpacked` + 刷新目标网页，两步都不能少** |
| `native-host/*.py` | 不用重装，下次调用自动生效 |
| `manifest.json` | 刷新扩展；若改了 `key` 则扩展 ID 会变，`setup.py` 要跟着改 |

> `inject-main.js` 是页面注入脚本，只在页面加载时跑一次。**已经开着的页面里永远是旧版本**——
> 这是「改完没效果」的头号原因，历史上已经因此误判过两次（[d-003](DEVLOG.md#d-003)）。

### 6.1 版本号规则（用户 2026-10-18 审核通过）

`extension/manifest.json` 的 `version` 用三段 `主.次.修`：

| 段位 | 什么时候升 | 例子 |
|---|---|---|
| **主版本** | 数据通路 / 架构变化，需要重装宿主或迁移 | 从 webRequest 改成页面内 hook |
| **次版本** | **新增站点支持，或用户能看见的新功能** | 小红书支持、预览按钮、打开所在文件夹 |
| **修订号** | 只修缺陷、性能、文案 | 序号错乱、图标混入、卡在读取中 |

补充约定：

1. **每次改代码都升版本**，只改文档 / 注释不升。
2. 同一轮里连着改好几处，**只在提交时升一次**，别每改一行就 +1。
3. 版本号写进提交信息（`fix(xhs) 1.3.2: ...`），方便回溯哪个版本对应哪次修复。
4. 升版本必须和「重载扩展 + 刷新页面」一起做——版本号只是标记，它不会让旧页面自动更新。

---

## 7. 有意思的站点适配

> 三站的适配都是「真机 dump 出真实数据结构 → 按真实字段写判据」得来的，
> 不是猜的。想看重现过程点对应的 [DEVLOG](DEVLOG.md) 条目。

### B 站

普通嗅探只抓得到已播放的那一小段（MSE 分片）。改法：

1. 页面里读 `window.__playinfo__` → 完整 **DASH 清单**（与播放进度无关）
2. 两条流分别按 4 MB × 6 并发抓完，ffmpeg `-c copy` 合并（无损）
3. 列表注入一条合成条目 `__bili_dash__`；点保存时走 `runBiliDownload`，它直接读
   `__playinfo__`，**不看这个 key**
4. 多分P 页面标题加 `-P{n}` 后缀；同一 bvid 切分P 时标题常一字不改，
   不带 p 号第二次保存会互相覆盖

关键：分块大小和并发是实测调出来的（`512K×4 → 1.07`、`1M×8 → 2.90`、`4M×6 → 3.12`、
`8M×8 → 3.41` MB/s）。**没取最快的 8M×8**：8MB×8 路在途 = 64MB 堆，
页面上还有播放器，容易 GC 掉帧。4M×6 = 24MB，是速度与内存的折中。

标题要一致的地方有五个（列表、载荷、浮层、文件名、去重签名），漏一个就出现
「列表对、文件错」——详见 [d-008](DEVLOG.md#d-008)。

**标题从哪来**：`biliTitle()` 是三级来源，从稳到脆——
① `window.__INITIAL_STATE__`（`videoData.title` / `h1Title` / `pages[0].part` /
`epInfo.title`）→ ② DOM 选择器（新版 `#arc_toolbar_report h1` 在前）→ ③ `<title>` 剥后缀。
三者都不中就返回 `""`，**绝不返回 `"bilibili"`**：假数据会让列表里出现一条名叫
bilibili 的条目，用户分不清是"没取到标题"还是"站点名"。详见 [d-016](DEVLOG.md#d-016)。

> 教训：**选择器是租来的，`__INITIAL_STATE__` 才是自己的。** B 站 2025 年改版把
> `h1.video-title` 换掉了，旧选择器全灭、静默退化到 `document.title`（SPA 首屏是站名），
> 表面看就像"标题功能坏了"，实际是从改版起就没生效过。

### 小红书

详情页的「推荐」「相关」「评论」里全是别的帖子的图，而它们和正文图**共用同一个
CDN 签名**（`1040g`），光看 URL 区分不了。所以改成看 DOM。

> ⚠️ **下面第 1、2 条是旧版做法，已证明在真机上失效**（详见 [d-010](DEVLOG.md#d-010)）。
> 真实的小红书详情页是 swiper 轮播，**每张正文图各占一个 slide 容器**，
> 于是「按父节点分组」每组只有 1 张图，「图最多」退化成「面积最大」，
> 结果只认一张、误杀其余；而猜出来的类名（`note-item` 等）也根本命不中。

现行做法（第十轮）已改为三条独立信号，按强度排序：

1. **URL 里的 noteId** —— 配图地址常带 `/<24位hex>/` 或 `_<24位hex>_` 段。
   含当前 noteId ⇒ 是正文图；含**别的** 24 位 hex ⇒ 是别的帖子。
   ⚠️ 正则有坑：裸写 `/[0-9a-f]{24}/` 会把视频 URL `.../stream/abc/110/258/01e8f0.mp4`
   里跨段的 `110/258/01e8f0` 也拼成 24 位 hex，于是**正文视频被当成「别人的」全部过滤掉**。
   必须锚定边界：`/(?:^|[\/=&_-])([0-9a-f]{24})(?=$|[\/=&_.!-])/gi`。
2. **祖先链上的 `data-note-id`** —— 小红书 React 组件普遍带这个属性，比类名稳。
   ⚠️ 但**正文容器只写 `note-id`（无 data- 前缀）**，信息流卡片才用 `data-note-id`，
   两个名字都要查，且 `note-id` 必须排在前面（[d-011](DEVLOG.md#d-011)）。
3. **祖先链容器推算（兜底）** —— 从本元素逐层向上，用 `contains()` 数「该子树里有多少张
   正文图」，取覆盖最多图的容器；若它装不到全页多数（`< ceil(总数/2)`）就判定失败、
   放行。这一步不依赖任何类名，对本轮/流式布局都成立。

**评论区的图在正文容器内部**，noteId 核对拦不住，必须在归属判断最前面单独排除
（URL 含 `/comment/` 段 **或** DOM 上溯命中评论容器，两条判据都要）。

**图片和视频不要走 DOM 扫描**：详情页是 swiper 轮播，只渲染首张，其余 `<img>`
的 `naturalWidth` 全是 0（拿不到尺寸）。改读 `__INITIAL_STATE__.note.noteDetailMap[noteId].note.imageList`
（张数、尺寸、顺序全部正确），DOM 扫描降级为兜底 —— 对比数据见 [d-012](DEVLOG.md#d-012)。

**视频真实地址**在 `note.video.media.stream`，是个**对象**（key 为清晰度编号 EF4/EF5/…）。
挑档位要「**完整 mp4 优先、其次比面积**」—— 高清晰度档可能是 `.m4s` 分片，
面积更大但下下来不能播（[d-013](DEVLOG.md#d-013)）。`masterUrl` 是 `http://`，必须转 `https://`。

封面重复两张的原因：同一张图会以不同尺寸后缀被引用多次，且 CDN 路径里
`/<时间戳>/<随机hash>/` 两段**每次请求都变**。真正的身份证是末尾的 fileId，
`xhsImgIdentity()` 只取 `<类型>/<fileId>`。

---

## 8. 已知限制

- **只对浏览器内播放有效**。Telegram Desktop / 手机 App 不经过浏览器，原理上抓不到。
- **Blob 有保质期**：页面 revoke 后再保留 5 分钟，过期只能重新播放一次。
- **MSE 拼接尽力而为**：随机 seek 会让同一分片被 append 多次，拼出来可能花屏。
- **直播**只能从启动那刻起录。
- **DRM 内容不支持**，也不打算支持。
- 小红书/抖音这类页面改版频繁，判定规则（类名、URL 签名）随时可能失效。

---

## 9. 问题与解决记录（索引）

> **本节只放索引**。每条的完整过程——遇到什么现象、怎么排查、试过什么失败、最后为什么
> 这么改——都写在 [**开发日志 DEVLOG.md**](DEVLOG.md) 里，点编号即可跳转。
>
> 为什么分开：这份文档是「该读什么」，日志是「发生过什么」。日志按时间累积会越来越长，
> 混在一起会把架构和决策淹没。需要知道「为什么」时再点过去。

### 9.1 用户提的六条（2026-10-18）

| # | 问题 | 状态 | 过程记录 |
|---|---|---|---|
| 1 | 评论区里的图片也会抓取 | **已完成** | [d-011](DEVLOG.md#d-011) |
| 2 | 小红书视频无法读取、名字对不上 | **已完成** | [d-011](DEVLOG.md#d-011)、[d-013](DEVLOG.md#d-013) |
| 3 | 视频/图片的水印能否去掉 | **评估后不做** | [d-009](DEVLOG.md#d-009)（理由见该条） |
| 4 | 给代码添加注释 | **已完成** | [d-009](DEVLOG.md#d-009) |
| 5 | 给功能分组，方便快速定位 | 待定（用户说之后商量） | — |
| 6 | 文档记录「实现中遇到的问题与解决方案」 | **已完成** | 本索引 + [DEVLOG.md](DEVLOG.md) |

### 9.2 逐轮专题

| 主题 | 结论 | 过程记录 |
|---|---|---|
| 小红书：别人帖子的图混进来 | 三路信号判归属（URL noteId / 祖先 note-id / 容器覆盖数） | [d-010](DEVLOG.md#d-010) |
| 小红书：评论图 / 视频 / 标题 | 双判据拦评论图；state 里取真实 mp4；标题回退 desc | [d-011](DEVLOG.md#d-011) |
| 小红书：图片无法预览 / 封面重复 / 列表噪声 | 补预览按钮；改读 `imageList`；身份只取 `<类型>/<fileId>` | [d-012](DEVLOG.md#d-012) |
| 小红书：视频抓不到 / 没标题 / 编号错乱 | 完整 mp4 优先于 m4s 分片；`blob:` 不再上报 | [d-013](DEVLOG.md#d-013) |
| 小红书：只显示当前帖子的图 | 详情页按 noteId 过滤 + 身份去重 | [d-005](DEVLOG.md#d-005) |
| B 站：视频名字不显示 | 标题五个落点统一；分P 靠 `?p=N` | [d-008](DEVLOG.md#d-008) |
| 保存卡在「正在读取媒体信息…」 | `fetch` 必须自己掐表（Web 平台无默认超时） | [d-006](DEVLOG.md#d-006) |
| 提升广覆盖 | 双监听 + 体积门槛 + 通用身份去重 | [d-007](DEVLOG.md#d-007) |
| 图片和图标混用 | 通用启发式只能过滤最明显的一批，最终靠站点判据 | [d-004](DEVLOG.md#d-004) |
| 改动不生效 / 页面没刷新 | 三类文件各自的生效方式（铁律见第 6 章） | [d-003](DEVLOG.md#d-003) |
| 全量测试与 CI | Windows runner 的 cp1252 编码；flaky 是竞态不是运气 | [d-002](DEVLOG.md#d-002) |
| 仓库初始化与上传 GitHub | ffmpeg 不进仓库；`github.com:443` 被阻断走 SSH | [d-001](DEVLOG.md#d-001) |

### 9.3 A0 功能模块化（2026-10-19）

**结论：通用层本来就是通用的，病灶只在「站点判断散落各处」。**

按数据流把 `inject-main.js` 切了一层，逐层回答「这层认不认站点」：

| 层 | 是否通用 | 说明 |
|---|---|---|
| 发现层（`scanImages`/`scanMedia` 轮询、`hookSourceBuffer`、`noteMediaResp`） | **100% 通用** | 不认站点 |
| 上下文层（`guessTitle`/`mediaContext`/`ordOfMedia`） | 接口通用、实现特化 | 最该抽的地方 |
| 归属层（这张图属于当前内容吗） | 接口通用、实现特化 | 小红书有，Telegram 有（消息 id），B 站没有 |
| 下载层（`runRangeDownload`/`fetchRange`/`probeTotal`） | **100% 通用** | 与站点无关 |
| 清单层（从哪儿拿完整清单） | 只有 B 站 / 小红书有 | `__playinfo__` / `imageList` |

**方案 A（用户选定），两步走：**

- **第一步（已完成）**：建 `SITES` 注册表 + `activeSite()`，把 5 个通用函数里的
  `if (isXhsHost())` 换成 `site.xxx?.()` 调用。**特化实现一行没搬**，行为完全不变。
- **第二步（后续）**：把小红书 564 行、B 站 389 行物理搬进各自对象内部。

**站点钩子（全部可选，不实现走通用默认）：**

```js
match()            // 是否当前站点（唯一必须实现的）
isDecorImg(el,src) // 装饰图：头像/logo/二维码/评论图
isImageOnly(el,src)// 只对 <img> 生效的额外筛选（如「只认某个 CDN 签名」）
isDecorVideo(el)   // 装饰视频
owns(el)           // 归属：属于「当前正在看的内容」吗
title(el)          // 标题（返回 "" = 没结论，交给通用实现）
videoSrc(el,src)   // blob: → 真实可下地址（返回 "" = 拿不到，本轮跳过）
feedImages()       // 完整清单（如 imageList）
onScanImages()     // 清单类站点一次性上报，返回 true = 本轮不用扫 DOM
```

**最重要的产出是架构测试**，不是重构本身：`test/site_registry.test.js` 断言
**通用函数体内（去掉注释后）不许出现 `isXhsHost()` / `isBiliHost()` / `xiaohongshu` / `bilibili`**。
没有这条约束，下一个人加站点最省事的做法仍是在 `scanImages` 里再抄一个 if，几个月后就退化。

> 踩坑过程（钩子语义混用导致视频误杀）详见 [d-014](DEVLOG.md#d-014)。

### 9.4 待办（用户 2026-10-18 收工时提出）

| # | 问题 | 排查起点 | 状态 |
|---|---|---|---|
| A1 | 首页信息流封面不加序号 | 已修：`renumberImages()` 里小红书非详情页「有标题就跳过编号」 | **已完成** [d-015](DEVLOG.md#d-015) |
| A0b | B 站视频条目没标题（显示占位文案「完整 DASH 流」） | `biliTitle()` 改为 `__INITIAL_STATE__` 优先、DOM 兜底、空则返回 `""` | **已完成** [d-016](DEVLOG.md#d-016) |
| A2 | B 站图片只取所点开视频的封面 | `inject-main.js` 的 `scanImages()` 加 B 站站点钩子，只留 `videoData.pic`，标题复用 `biliTitle()` | 待办 |
| A3 | Telegram 视频和图片下载全部失效 | 先真机复现：重载扩展 → 打开 Telegram → 点保存，看断在 `fetchRange` 还是 `hostRequest` | 待办 |
| A4 | 「本次记录」改名为「下载记录」 | `popup.html` 的 `historyBtn`、`popup.js` 的 `renderHistory` 标题与空列表提示 | 待办 |

**顺序：A1 ✅ → A0b ✅ → A2 → A3 → A4。**

> **编号的语义**：它表达的是「**同一条内容里的第几张**」。
> 所以 Telegram 相册、小红书详情页要编号；信息流、推荐位、搜索结果的每条
> 都是独立内容，**编号从语义上就无意义**——不是实现问题（[d-015](DEVLOG.md#d-015)）。
> 改动 `renumberImages` 时注意：`mark` 是**状态**不是每轮重算的结果，
> 不在分组里的条目会保留上一轮的值。

### 9.5 新计划（未开始）：MSE buffer 重组

**目标**：支持没有完整文件地址、只能靠 MSE 分片喂给播放器的站点。

**技术路线**：注入层 hook `SourceBuffer.appendBuffer` → 收集层记录每个 `moof+mdat` 的
时间戳与字节 → 重组层按序拼成可播放的 fMP4 → 落盘。

**四大难点**：

1. **DRM（EME）内容拿到的 buffer 是加密的**，重组出来也没用。必须能识别并明确拒绝。
2. **用户随机 seek 时 buffer 顺序是乱的**，不能按到达顺序拼，必须按 `moof` 里的时间戳排。
3. **内存**：长视频全缓存在页面上会 OOM，必须边收边写盘（走现有 `msfile_*` 通道）。
4. **注入时机**：`appendBuffer` 必须在播放器创建 `SourceBuffer` 之前 hook 上，
   晚一步就漏掉开头。

**开工前先确认**：是否真的值得投入。按站适配（B 站/小红书/Telegram 都已覆盖）
在可见范围内可能已够用。**建议先做「注入层 + 收集层」验证能稳定截到 buffer 且不拖垮播放器，
再决定要不要上重组层。**

---
