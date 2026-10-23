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
node test/main-hook.test.js        # inject-main.js 页面注入层，183 项
node test/background.test.js       # background.js 服务层，174 项（含 review.test.js 的 27 项）
node test/detect.test.js           # detect.js 通用媒体判定，30 项
node test/range_parallel.test.js   # Range 并发下载，14 项
node test/pattern_sync.test.js     # 前后端正则/常量同步，4 项
node test/popup_wiring.test.js     # popup DOM 接线，21 项
node test/site_registry.test.js    # 架构约束：通用层不许出现站点判断，38 项

# Python（不需要 pytest）
python test/run_all.py             # 8 套，缺 ffmpeg 的两套自动 SKIP
```

`test/review.test.js` **不单独跑**：它导出 `runReviewTests(check)`，由
`background.test.js` 末尾 `require` 进来共用同一套 `check()` 计数器。
单独执行它会打印一行说明后正常退出（避免 CI 把它当成空套件判失败）。

所有 JS 套件都靠 **vm 沙箱 + 假宿主**跑，不启动浏览器。新增 hook 逻辑时优先看
`test/main-hook.test.js` 里现成的假 document / 假宿主怎么搭的。

CI（`.github/workflows/tests.yml`）在每次 push / PR 自动跑：JS 七套 × Node 18/20/22，
Python 套件在 Ubuntu（3.9 / 3.12）和 Windows（3.12）上跑。没装 ffmpeg 的环境里
`host_merge` / `bili_stream` 自动 SKIP 而不是 FAIL。

### 5.1 回归清单（改完必看）

按「改了什么」查该跑哪几项，全绿才算过。

| 改动的区域 | 必须跑的测试 | 额外验证 |
|---|---|---|
| `looksLikeIcon` / 图片图标判定 / `isSiteUiAsset` | `background.test.js` 的 `[3]` `[R2]` | 拿真机截图里的 URL 加一条断言 |
| `record()` / `classify()` / 体量门槛 / tabId | `background.test.js` 的 `[R1]` + `detect.test.js` | —— |
| `recordPageMedia` / 导航代次 / SPA 生命周期 | `background.test.js` 的 `[R3]` `[R4]` `[11]` | 真机切视频看旧封面是否残留 |
| 小红书去重 / imageList 直读 / noteId 闸 | `background.test.js` 的 `[4]`~`[4d]` + `main-hook` 的 `[5v]`~`[5z]` | 真机打开一篇多图帖 |
| 站点专属扫描逻辑（B 站封面 / 小红书配图） | `site_registry.test.js` 全部 | 通用层出现站点 if 会直接红 |
| Range 下载 / 分块并发 / B 站 m4s | `range_parallel.test.js` | 真机下一条 B 站视频 |
| 页面 → 宿主桥接 / 动作白名单 | `host_validation_test.py` | 重装宿主后真机保存一次 |
| popup 按钮 / 列表渲染 / 下载记录 | `popup_wiring.test.js` | 真机打开弹窗点一遍 |
| 宿主分块落盘 / ffmpeg 合并 | `run_all.py` 全跑 | 真机下完用播放器确认能播 |

### 5.2 汇报用词（不许含糊）

| 你做到的 | 只能说 |
|---|---|
| 只跑了 `node --check` | **静态检查通过** |
| 单元测试全绿 | **自动化测试通过**（并说明未真机） |
| 真机点过 | **浏览器实测通过** |
| 用户确认 | **验收通过** |

把「静态检查通过」说成「测试通过」是明确的失实汇报。完整规范见 `AGENTS.md` 第 4 节。

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

### 6.2 架构红线：状态的作用域必须和语义一致

A0 抽出站点注册表之后，扫描层的站点分支已经归零，但用户仍然看到「修好一个、坏一个」。
追下去发现原因不在代码耦合，而在**状态的作用域**：

| 状态 | 旧作用域 | 正确作用域 | 症状 |
|---|---|---|---|
| `rec.xhsVid` | 整个 tab | 单个 noteId（`rec.xhsVidNote`） | 看完一个视频、SPA 切到另一个帖子后，新帖的分片条目全被拦掉 →「换了个视频就抓不到」 |
| `chrome.runtime.sendMessage` 的异常 | 静默吞掉 | 只对「上下文失效」提示一次 | 扩展重载后没刷新页面时消息全丢，用户以为功能坏了 |

结论：**抽钩子只解决代码耦合，不解决状态耦合。** 加任何 `rec.xxx` 形式的
标志位之前，先问一句「它的语义是全局的、还是某个内容的？」。详见
[d-017](DEVLOG.md#d-017)。

d-018 补了半句：**语义对了的闸还必须可达。** 1.3.11 的 `xhsVidNote === curNote`
语义完全正确，但带 noteId 的上报都带 hint、被闸自己的 `!p.hint` 排除——两条路
互斥，闸从未拦过任何消息。给门写完，要用真实上报形状验证「满足条件的消息真的
存在吗」，最好直接落成行为测试。详见 [d-018](DEVLOG.md#d-018)。

另外 popup 打开时会主动对当前页发一次 `ms:ping`（只对 http/https 页发）；
没有回应就在提示栏写「本页没有嗅探脚本（扩展刚装/刚更新过），点右上角 ⟳
重新载入页面」——这是排查「改动没生效」的第一道提示，比让用户去猜快得多。
content.js 发现上下文失效时，页面主世界的脚本会收到 `__ms_sniffer_stale` 消息，
在页面右上角显示一条可点击关闭的提示条。

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
| A2 | B 站图片只取所点开视频的封面 | **已完成（1.3.13）**：`biliCoverImage()` 从 `__INITIAL_STATE__` 取封面（候选 videoData.pic → epInfo.cover → mediaInfo.cover 等），站点钩子 `onScanImages` 发 `hint:"bili-cover"` 条目并接管扫描、`isImageOnly` 拦下视频页其余 img（`biliIsCoverSrc` 去 `@尺寸段` 比对）。详见 [d-019](DEVLOG.md#d-019) | 已完成 |
| A3 | Telegram 视频和图片下载全部失效 | **已完成（1.3.25，真机过）**。根因不是「下载器挂了」，而是 `blob:` 分支走 `doSaveBlob` 的 `<a download>`：文件落进 **Chrome 默认下载目录**、扩展名被 MIME 写成 `.jfif`，用户在插件配的「文件存放处」看不到 → 主观上就是「全部失效」。真机对照：`__msRangeDownload`（Native Host）→ `D:/…/文件存放处/tg-probe.mp4` 72796 字节 ✅；`<a download>` → `C:/Users/l/Downloads/test-tg.jfif` 72796 字节 ⚠️。修法：`runSave` 的 `blob:` 分支改走 `startMediaDownload`（Range + Native Host）；顺带修扩展名——`sniffExt` 补图片魔数、`guessExtFromType` 补 `IMG_MIME_EXT` 表、两处 `|| ".mp4"` 兜底改 `|| ""`。真机复验落盘 `真机复验图_99398.jpg` 72796 字节、魔数 `ffd8ffe0`。详见 `DEVLOG.md#d-027` | **已完成** |
| A4 | 「本次记录」改名为「下载记录」 | **已完成（1.3.14）**：按钮文案、面板标题、相关注释；空列表提示保留「本次会话还没有下载记录」（语义准确） | 已完成 |
| B1 | B 站图片仍混入 UI 素材 + 切视频后旧封面残留 | **已完成（1.3.15）**：① UI 素材——根因不是缺规则而是**规则顺序错**，`looksLikeIcon` 末尾的 `s > 24KB → return false` 排在 `CDN_HINT` 之前，47KB 素材在第一行就被放行；新增 `isSiteUiAsset(u)` 把「站点素材形状」提到体积线之前，判据落在**路径形状**（`svg-next/`、`sprite/`、`favicon/` 目录；`xxx.jpg@.avif` 变换后缀 + 纯 hash 文件名）而不是域名——封面和素材在同一个 `hdslb.com` 上，域名一刀切会误杀真封面。另加 `hint === "bili-cover"` 正向豁免，防 100×100 小封面被尺寸启发式误杀。② 切视频残留——导航重建**本来就存在**，真正的洞是**迟到消息**：页面 A 的延迟扫描回调在导航到 B 之后才上报，污染刚清空的新记录。加导航代次 `gen`：`watchSpaNav` 每次导航 +1 随 `nav` 发出，`post()` 给 `found/progress` 补 `gen`，`recordPageMedia` 入口丢弃 `p.gen < rec.gen`；`tabs.onUpdated` 整页刷新时 `gen` 归 0（页面侧计数器同理从 0 重来）。③ 顺带：`record()` 的 `!d.tabId` 把 **tabId=0** 当假值丢弃（Chrome 标签页 id 从 0 开始），改为 `isValidTabId(t)` = `Number.isInteger(t) && t >= 0`；新增 `diagBump()` 在每条丢弃路径打点，popup 空列表时显示「收到 N 个请求、丢弃原因」。详见 [d-020](DEVLOG.md#d-020) | **已完成** |
| A5 | 51cg1 / 4kvm 等 HLS 站「插件不起作用」（用户 m16052） | **已完成（1.3.27，两站真机过）**。两个站都不是「抓不到」，而是抓到了**抓错了东西**：51cg1 的 DPlayer+hls.js 压根没初始化，浏览器一次都没请求过 m3u8（state 只有 2 条 other、`diag` 为 null），但地址就摆在 `.dplayer[data-config]` 里；4kvm 抓到了 m3u8，但那是 **29KB 的文本播放列表**，用户点下载得到的不是视频。修法四层：①`background.js` 加 `isHlsUrl()`（只认 pathname 后缀，防 `?url=x.m3u8` 误判），`sniff:get` 里打 `hint="hls"`；②`popup.js` 显示「标题 · HLS 流（视频）」+「点下载自动拼成完整视频」，并让 `hideRecorder()` 在有 HLS 时隐掉同源的 blob/m1/m2 噪声；③`inject-main.js` 新增 dplayer 站点（读 `data-config`，绕开没起来的播放器）与 artplayer 站点（读 `og:title` 报「页面标题条目」）；④`background.js` 加 `applyHlsPageTitle()` 把页面标题借给真 m3u8 条目再删页面条目（页面侧只有 DOM、后台侧只有 webRequest，各持一半）。**真机**：51cg1 state 2 条 → 193 条、视频带标题；4kvm 3 条 video → 2 条、标题「挑情丑闻 - 第1集」。详见 [d-028](DEVLOG.md#d-028) |
| A6 | Telegram 序号「完全对不上」（第三次，用户 m15907） | **已完成（1.3.26，真机过）**：根因是**两套计数流**——视频走 `ordOfMedia` 只跟同族 `<video>` 比（0..6），图片走 `byMsg` 下标（0..3），同一条消息里 ord 撞车后只能退回异步抓取时间 `t` 兜底 → **随机错号**，这正是「修过两次还不对」的原因。修法：`ordOfMedia` 开头先走 `orderMediaInMessage(el)`（整条消息 video/audio/img 统一序），拿不到才退回同族比较。**真机**：消息 8848 视频 ord 从 `0..6` 变为 `0,2,4,10,12,14,16`、图片 `6,8,9,18`，页面侧 19 个媒体返回 0..18 连续。详见 [d-029](DEVLOG.md#d-029) |
| B5 | 点条目跳转到页面里该媒体的位置（用户 m13684 第 3 条，**待讨论**） | 用户原话：「是否能加一个功能，即点击视频或图片就会跳转到该图片或视频所在网页中的位置」。**技术难点（先记下来，谈的时候用）**：①扩展页是独立窗口，点一下只能 `chrome.tabs.sendMessage` 让内容脚本去滚；②条目必须能定位回 DOM 元素——现在 state 里只存 URL，**没有存元素引用**，`inject-main` 报 `found` 时也没带「怎么找回这个元素」的信息；③常见媒体没有稳定 id，只能靠 `u` 反查 `document.querySelectorAll("img,video")` 里 src 相同的那一个，而 blob:/MSE 条目的 src 每次刷新都变；④B 站/小红书这类站点可以用 noteId/bvid 精确定位，通用站点只能模糊匹配。**结论方向**：先给 `found` 增加一个可选的 `sel` 字段（页面侧算好的定位串），能算出就给、算不出就不给，popup 有 `sel` 才显示「定位」按钮。需要用户拍板要不要做。 | **待讨论** |
| B4 | B 站「上个视频的封面和图片依然存在」（用户 2026-10-20 真机复测） | **1.3.15 修得不彻底，用户决定放到最后再优化。** 用户原话（m13664）：「上个视频的封面和图片依然存在，不过就这样吧，放到项目最后的优化工作上」。也就是说 `gen` 迟到消息闸只解决了「回调晚到」这一种，**能跨视频残留的还有另一类来源**：①`__msScan` 的多轮扫描本身在切视频后仍然按旧 DOM 报了一遍；②B 站是 SPA，`watchSpaNav` 只盯 path 变化，`?p=N` 或站内推荐位切换可能不触发它；③`state` 里该 tab 的记录靠 `tabs.onUpdated` 清，SPA 内切视频不触发 onUpdated，于是旧条目只能等 nav 分支，若 nav 没发就一直留着。**优化阶段再做**：先真机开 B 站切两个视频、dump state 看旧封面条目的 `t`（时间戳）和 `gen`，确认它是哪一类再动手。 | **已推迟到优化阶段** |
| B12 | Telegram 序号与焦点「全失效」（2026-10-22 登录态真机复验发现） | **已完成（1.3.28，自动化测试通过，完整真机待补）**：Web K 把消息号从 `data-message-id` 换成了 `data-mid`（实测 `data-message-id` **0 个**、`data-mid` 37 个），而 `mediaContext()` 只读前者 → `mid` 恒空 → 「既没 mid 也没标题」整批不编号；`tgFocus`/`tgFocusByMedia` 依赖同一属性，焦点也恒空。**层级陷阱**：`data-mid` 每层都有且值不同（`.bubble` 868、里面三个 `.album-item` 868/869/870），必须取**最外层**，取最近一层会把一条消息拆成三条。修法：①新增站点钩子 `msgBox(el)`/`msgId(box)`（`data-mid` 不进通用层，避免误伤别的站点）；②分组键改 **mid → 标题 → kind\|ref**（否则 Web K 抓不到标题时图视频会各从 ① 起）；③`popup.js` 的 `sameGroup` 同步。**语义变更（有意）**：同标题的多条消息不再跨消息连号，每条消息各自从 ① 起——消息才是内容单元，且与焦点收窄的粒度一致。测试 JS 625 项 / Python 9 套全绿。**真机**：真实页面里 `msgBox/msgId` 返回外层 `999001`（非内层 `999002`）、`__msOrderInMessage` 有效；会话消息因网络拉不下来，**①②③ 连续与查看器收窄待用户手点验收**。详见 [d-030](DEVLOG.md#d-030) | **已完成（自动化测试通过，未完整真机）** |
| B13 | HLS 任务只下到播放列表却报「完成」（A5 真机复验发现） | **已完成（1.3.29，自动化测试通过，真机待验）**：51cg1 那条 m3u8 让 yt-dlp 走了 generic 分支，把**清单本身**当普通文件存成 38,299 字节的 `.m3u8`——退出码 0、尾部无 `ERROR:`，d-027 修的两条判据都躲过去了。修法：`looks_like_playlist(path)` 按**文件头**（`#EXTM3U`）判定、>256KB 直接放过（清单只有几 KB），done 分支先校验产物，命中即报 error 并说明「只下到播放列表，不是视频，多半需要 Referer/Cookie 或清单加密」。测试 `host_hls_test.py` 新增 8 条，Python 9 套全通过。**没做**：`final_file` 为空（yt-dlp 没打 `FILE:`）时仍直接判 done，拿不到路径只能扫目录，代价大于收益。详见 [d-031](DEVLOG.md#d-031) | **已完成（自动化测试通过，未真机）** |
| B14 | 4kvm 抓得到但下不下来（用户 2026-10-22 追问「有办法解决下载问题吗」） | **已完成（1.3.30，自动化 + 端到端复验通过）**：两条根因同时存在——①m3u8 **一次性/短时效**（抓到后 15 分钟即 404，刷新页面换新 hash）；②分片是**「112 字节 PNG 壳 + 真 MPEG-TS」**伪装（PNG 签名 + IHDR/pHYs/IDAT/IEND，`IEND` 结束在 offset 112，紧接着 `0x47`）。修法两层：**下载层** `native-host/downloader.py` 新增 `run_hls_self`——`strip_masquerade()` 在前 4KB 里找「连续 5 个 0x47 包」的偏移剥壳（不写死 112）、`parse_hls_playlist()` 用 `urljoin` 补绝对地址并取最大 BANDWIDTH 子清单、第一片做 **4 档请求头探针**（本站防盗链方向是反的：**带 Referer → 403，不带 → 200**）、滑动窗口并发 + 主线按 index 顺序写盘（不落几百个临时文件，本机 safe-delete 一次删 >50 文件会被拦）；`main()` 分派改为 **m3u8 先自实现 → yt-dlp → 直连**，三路失败原因全保留。**地址层** `extension/background.js` 新增 `pendingHlsRetry`——报错带「时效/过期/404」且是 m3u8 且未重试过 → `chrome.tabs.reload`，页面重新上报**新** m3u8（排除 `oldUrl`，reload 会先重放缓存里的旧地址）时自动重下并提示「视频地址已过期，已刷新页面重新开始」；等待窗口 25s→**120s**（reload+拉流实测 10~20s），且 `record()` 两处也要接线（4kvm 的 m3u8 只由 webRequest 抓到）。**验证**：真机 2.8%→84.7%（约 18 MB/s）落盘 1.3 GB `.ts`，首字节 `0x47`、末尾对齐 188；端到端用过期地址复验——`t+6s` 报 404 且登记等待 → `t+9s` 等到新地址自动重下 → 百分比涨到 47.1%。测试 `host_masquerade_test.py` 29 项（新）+ `[HRTY]` 18 项，JS 642 / Python 10 套全绿。**已知限制**：remux mp4 在本机一律 `Permission denied`（`.part`/`-f mp4`/系统 temp + `shutil.move` 全试过，判定为本机安全软件拦未签名 exe 写入，TS 本身可播，已在 message 说明）；自动重取只有一次机会。详见 [d-032](DEVLOG.md#d-032) | **已完成（端到端复验通过；mp4 转封装受本机环境限制）** |
| B15 | 「完成」但目录里没有视频（第二次，2026-10-22 用户点第二集下载发现） | **已完成（1.3.31，自动化测试通过）**：状态 `done/100/file=.m3u8`，目录里只有 31 个 yt-dlp 碎片，`message` 是 `WinError 5 拒绝访问: <id>.json.tmp -> <id>.json`。**根因 A**：`write_status` 写 `.tmp` 再 `os.replace`，而宿主 `poll_job` 每 0.4 秒 `open()` 读同一文件——**Windows 下目标被别人持有句柄时 MoveFileEx 返回 `ERROR_ACCESS_DENIED`**。致命之处在于这个异常**从 `except` 块「写失败原因」那一行抛出**：真因没写进去、进程带 traceback 退出、状态文件留着上一次的 `done/100`。**根因 B**：yt-dlp 失败不清理 `<base>.mp4.part*` / `.ytdl`（本次 31 个文件 9.2 MB），而本机 safe-delete 一次删 >50 文件会被拦。修法：`_replace_retry()` 退避重试 10 次（上限 80ms）+ 最终退化为直接覆写，`write_status` 从此**不抛异常**；`cleanup_ytdlp_junk()` 只清 `<base>.*.part*` / `<base>.*.ytdl` / 内容是播放列表的 `<base>.m3u8`，成片与相近名字不碰。测试 `host_status_race_test.py` 先红 10 条 → 18/18 全绿；Python 11 套 / JS 642 全绿。**未查清**：这一单为什么回退到 yt-dlp（原因被根因 A 吞了），已排除防盗链（1017 分片、无 KEY/BYTERANGE、带不带 Referer 都 200）。**下一步建议**：把「`done` 必须同时满足 `file` 存在且不是播放列表」提成状态机级硬约束，别散在各分支各判一次（假成功已第三次换面貌出现）。详见 [d-033](DEVLOG.md#d-033) | **已完成（自动化测试通过）** |
| B16 | 51cg1 抓取/下载复验（用户 2026-10-22 追问「这个网站的功能实现了吗」） | **已完成（1.3.32，真机复验）**：抓取 109 条、HLS 条目带标题（`hint=hls`，标题来自站点自己的 `.dplayer[data-video_title]`，末尾 `001` 是站点写的不是我们加的）；下载**能下**但走 yt-dlp 兜底——因为**分片是 AES-128 加密的**（`.part-Frag` 前四字节 `b6 11 27 d2`，既非 TS 的 `0x47` 也非 fMP4 的 `ftyp`），这正是 d-032 里 `run_hls_self` 有意 `bail(take_over=False)` 的情形，不是缺陷。实测 0.2%→87.7%、6~8 MiB/s，中途卡过两次（35 秒 / 近 3 分钟，yt-dlp 在重试分片）。**修的问题**：界面从 0% 到 87.7% 一直显示「解析播放列表」——`write_status` 是合并式，自实现 HLS 先写了这句，回退 yt-dlp 后进度更新只写 percent/speed/eta 不清 message。修法：新增 `write_progress()` 作统一进度入口（内部固定 `message=""`），yt-dlp 分支改走它。顺手删掉 `downloader.py` 里重复的 `read_status` 定义（后一份无 docstring 却覆盖了前一份）。详见 [d-034](DEVLOG.md#d-034) | **已完成（真机复验通过）** |
| B17 | 单个分片连接中断就整单失败（2026-10-22 51cg1 复验期间在 4kvm 现场撞到） | **已完成（1.3.33，自动化 + mock 端到端）**。真机报错：`下载分片失败（30/178 已下）：IncompleteRead(528064 bytes read, 1614008 …)`——前 30 片白下，整单失败；用户手动重试一次就成功，属于瞬时抖动。根因：`_hls_get` 的 2 次重试是**紧接着**的（0.6s / 1.2s），服务端抽风几秒时 3 次尝试全撞在同一窗口；且异常在 worker 线程里抛，主线程只拿到光秃秃的 `IncompleteRead`，不知道是第几片。修法：新增 `_fetch_segment()` 在 `_hls_get` 外再套 3 轮、退避 **1s→2s**（4xx 立刻返回不浪费预算），返回 `(data, err)` 不抛异常；主线程 `raise _SegmentFailed(idx, err)`，提示改成「第 N 片重试 3 轮仍失败」并保留「已下 N/M」。测试 `host_segment_retry_test.py` **先红 5 条** → 17/17 全绿，含「某片连续断流 4 次任务仍 done 且产物大小 = 6 片净长之和（补齐不是跳过）」。Python 12 套全绿 / JS 642 不受影响。详见 [d-035](DEVLOG.md#d-035) | **已完成** |
| B18 | 点「取消」没作用：换个下载器接着下（2026-10-22 修 B17 后真机冒烟发现） | **已完成（1.3.34，真机复验）**。现象：取消后界面 3 秒内显示 `cancelled`，但输出目录又出现文件、状态被覆盖回 `downloading/percent 0`，进程还活着在跑 yt-dlp。根因：`main()` 只把 `done` 当停止条件，`run_hls_self` 取消时 `return True` 被当成「这一路没搞成」→ 掉进 yt-dlp 兜底；`run_ytdlp`/`run_urllib` 自身也没有取消守卫。**另一个坑**：`sniffer_host.do_cancel()` 立刻回 `{"action":"cancelled"}` 给扩展，界面上的「已取消」只是**回执**，不是进程真停了——第一轮就是被这条假信号骗过。修法：`main()` 改 `in ("done","cancelled")`；两个兜底函数开头加取消守卫；`_fetch_segment(should_stop=...)` 让分片重试也能被打断。测试 `host_cancel_test.py` **先红 5 条** → 11/11 全绿，Python 13 套全绿。**真机**：取消后 `cancelled/用户取消`、`.part` 已删、无遗留进程，**收尾 5.09 秒**（改动前 70 秒）。详见 [d-036](DEVLOG.md#d-036) | **已完成** |
| B19 | 下载其实成功了，状态却说「ERROR:」+ 指着一个播放列表文件（2026-10-22 22:13 用户第三次点 51cg1 下载，收工时顺手抓到的） | **已完成（1.3.35，自动化测试通过，未真机复验）**。**d-037 当时把根因猜偏了一半**——不是「取产物取错了」，而是**上游把成功误判成了失败**，兜底路径又「成功地」下了一份清单。三段互锁：①`run_ytdlp` 其实下成了（170MB mp4 落地），但 yt-dlp 在 returncode=0 时打了一行**内容为空的 `ERROR:`**，`post_err` 取到它 → 整单误判失败；②`main()` 看到 error 就兜底 `run_urllib`，把 **m3u8 当普通文件下**，落盘成 `<base>`（29KB 清单）；③`run_urllib` 成功时 `write_status(status="done", file=<base>)` **没传 message**，合并式写入把 `"ERROR:"` 原样留着。**根因一句话**：`done` 的判据一路都是「这一路说自己成功」，从没有一处问过「目录里到底有没有真视频」。**修法**：新增 `is_real_media()`（**魔数**：`ftyp`/EBML/AVI/FLV/OggS/MP3/TS 的 0x47 周期；体积下限只有 64KB，判类型靠魔数不靠体积）与 `find_done_product()`（只在 `<base>.*` 里挑最大的真视频，裸 `<base>` 和 `job2.mp4` 都不选）；`run_ytdlp` 失败分支遇 `rc==0` 且有真产物 → done；`run_urllib` **入口**先认现有产物（掐断第②段）、**成功后再验内容**（是清单就删掉并报 error）；`cleanup_ytdlp_junk` 增加第四类「无后缀但内容是清单的 `<base>`」；所有 done 分支显式 `message=""`。测试 `host_product_test.py` **先红 10 条**（红得很准：`status=done` / `file=…\job` / `message=ERROR:`，与真机一字不差）→ **19/19 全绿**；Python **14 套**、JS **10 套**全绿。详见 [d-039](DEVLOG.md#d-039) | **已完成（自动化测试通过，未真机）** |
| B20 | 91rb 视频页能否下载（用户 2026-10-22 提出「明天测试一下」） | **已完成（2026-10-23 真机实测，档位：浏览器实测通过）。结论：未登录下不可下载，且原因在站方，不是扩展缺陷。** 页面 `https://www.91rb.com/videos/321534/2-1149/` 对游客只渲染 `<div class="no-player" id="limitplayer">` + 封面图 + 「游客试看已达上限 / 登入会员以解锁精彩内容」，`<video>` **0 个**、`<iframe>` **0 个**、HTML 里 `.m3u8`/`.mp4` 命中 **0 次**，`pageContext = { videoId:'321534', loginUrl:'…/login-required/' }` —— **播放器根本没被创建，浏览器一次视频请求都没发出去**，所以 webRequest 无物可抓；扩展侧 26 条全是 `other 11 / image 14 / font 1`，`video` 与 HLS 均为 0。**对照组**（同一次会话同一个调试 Chrome）：换成 51cg1 → 158 条、`video 6 / seg 4`、HLS 2 条 → **扩展与宿主均正常**。**环境坑（新）**：本机直连该站超时、curl 走 Clash 7897 的显式 CONNECT 也握手失败，但 **Chrome 走系统代理（WinINET 7897）能正常打开** —— 而 agent 的 bash 注入了 `http_proxy=127.0.0.1:2937`（沙箱代理），从里面起的 Chrome 一律 `ERR_CONNECTION_CLOSED`，**必须跳过沙箱启动 Chrome**。**未验证**：登录态（会员）下能否下载——需要用户提供账号或 cookie。详见 [d-038](DEVLOG.md#d-038) | **已完成（未登录不可下；登录态待验）** |

| B21 | 点下载后要干等一两分钟才动，而且这一段完全没有反馈（用户 2026-10-22 截图 1、2 追问） | **已完成（1.3.36，自动化测试通过，未真机）**。「死等」是真的：真机 22:10:33 写 `percent=0`、**22:12:21** 才跳到 93.9%，近 2 分钟界面静止，之后 50 秒跑完。两段纯等待：①`run_hls_self` 拉主清单→有子清单再拉→查 `EXT-X-KEY`/BYTERANGE→第一片当探针**最多试 4 档请求头**（每档一次真实 HTTP）；②`run_ytdlp` 拉清单、建几百个分片的表，进度行要**真正开下第一片**才出现。**为什么不能改成图二那个 Chrome 下载气泡**：那是 Chrome 自己的下载管理 UI，只能表达「一个 URL → 一个文件」；HLS 是几百个请求拼一个文件，`chrome.downloads.download({url: m3u8})` 只会把**播放列表文本**存下来（d-031 那个 38.5KB「视频」就是浏览器版原样复现）；原生气泡还不可定制（显示不了「第 30/178 片」「地址过期已刷新重下」「转 mp4 失败：…」），取消按钮也管不到 Python 子进程。**修法**：`Phase` 类——写一句「在干什么」并每 2 秒补「（已等 N 秒）」，**自限**（写前先读，发现 message 被别人改掉就退出，所以调用方不用记得 stop，否则就是 d-034 翻版）；落点三处（解析播放列表 / 探测请求头 4 档 / 交给 yt-dlp 解析清单）；`popup.js` 的 `updateJob` **以前只拼百分比、宿主写的 message 根本显示不出来**，改成 message 优先；`popup.css` 加 `.job.wait` 来回走的光带（percent=0 但有文案时），done/error 显式摘掉。测试 `host_phase_test.py` **先红 4 → 10/10**；`popup_wiring.test.js` +6 条静态检查。Python **15 套**、JS **10 套**全绿。详见 [d-040](DEVLOG.md#d-040) | **已完成（自动化测试通过，未真机）** |
| B22 | 同一条 HLS 在列表里出现两次，带标题那条点「保存」用不了（用户 2026-10-22 截图 3） | **待做（明天）**。用户原话：「上面那个是什么，我测试的时候发现它用不了，下面那个能用」。**上面那条**：`inject-main.js` 的 **dplayer 钩子**从 `.dplayer[data-config]` 读出来的地址（`hint:"dplayer"`、`mime:video/mp4`、`ext:.m3u8`），带站点标题 → 因为是**页面侧上报**所以 `page=1` → `popup.renderItem` 走 `isPage` 分支，只给「预览 / 保存」。而「保存」这条链路是给 Telegram（blob + 页面上下文 Range + 512KB 限制）和 B 站（`__playinfo__`）设计的，**不是给 HLS 用的**：点下去页面会去 Range 拉那个 m3u8，拿到的是 38.5 KB 的**清单文本**，不是视频。**下面那条**：webRequest 抓到的同一类 m3u8（无标题、`text/plain`、4.2 KB）→ 有「下载」按钮 → 走本地下载器 → 能用。**顺带一个文案自相矛盾**：上面那条副标题还写着「点下载自动拼成完整视频」，可它根本没有「下载」按钮（`isHlsItem()` 分支无条件 push 这句话，没区分按钮）。**修法方向**：①`renderItem` 开头先把 `isHlsItem(it)` 拦出来——HLS 条目**无论 page 还是 webRequest 一律走本地下载器**，给「复制/打开/下载」不给「保存」；②同一地址的 page 条目与 webRequest 条目做**合并去重**，优先保留能下载的那条（别再让用户面对「一条能用一条不能」）；③副标题文案跟着按钮走。**验收**：51cg1/4kvm 页面上，带标题的 HLS 条目点下去能直接下成完整视频，且列表里同一地址只出现一次 | **待做（明天）** |

| B2 | 测试标准规范 + 多模型分工（架构师/开发/测试） | **测试标准已落地**：新建根目录 `AGENTS.md`（一任务一目标 / 五阶段流程 / 测试状态七级 / 失败反馈模板 / 生效条件 / 提交自查清单），本章新增 5.1 回归清单与 5.2 汇报用词。**多角色分工已定案（1.3.15 之后，提交 `48aaae3`）**：方案 A 轻量三角色——架构师只读出「根因 + 影响面 + 验收标准」，开发先写红测试再最小改动，测试独立不看实现；固守一期一目标；真机验证分开记账不阻塞提交。见 `AGENTS.md` 第 8 节 | 已完成 |

**顺序：A1 ✅ → A0b ✅ → A2 ✅ → A4 ✅ → B1 ✅（1.3.15 修了迟到消息；旧封面残留另立 B4、推迟到优化阶段）→ A3（待真机）→ B2 ✅ → B6 ✅（1.3.16）→ B7 ✅（1.3.17）→ B8 ✅（1.3.18，真机过）→ B9 ✅（1.3.20，真机过）→ B11 ✅（1.3.22，真机过）→ B10 ✅（1.3.24，真机过）→ A3 ✅（1.3.25，真机过）→ A6 ✅（1.3.26，真机过）→ A5 ✅（1.3.27，两站真机过）→ B12 ✅（1.3.28，自动化测试通过，待完整真机）→ B13 ✅（1.3.29，自动化测试通过，待真机）→ B14 ✅（1.3.30，端到端复验通过）→ B15 ✅（1.3.31，自动化测试通过）→ B16 ✅（1.3.32，真机复验通过）→ B17 ✅（1.3.33，分片断流不再打死整单）→ B18 ✅（1.3.34，取消真的会停）→ **2026-10-23：B20 ✅（91rb 未登录不可下，站方登录墙；扩展正常）→ B19 ✅（1.3.35，done 判据换成魔数）→ B21 ✅（1.3.36，准备期有阶段文案 + 会走的进度条）→ 进行中：B22** → 待讨论：B5 → 优化阶段：B4。**

| B6 | Telegram 同标题媒体不聚拢 / 编号断裂 / blob 图片不能预览（用户 m13684 第 1、2、3 条） | **已完成（1.3.16，分支 `fix/tg-group-preview`）**：①**分组键改为标题**——`renumberImages` 原来用 `kind + mid + ref`，同标题散在不同消息里就各自成组，列表一片 ①①①；改成「有标题就用 `t:标题`，跨消息、跨 ref、跨 kind 都并到一组」，无标题才退回 `kind+mid+ref`。这不是 Telegram 独有，所有站点都走这个键，只是 Telegram 会额外给 `album`/`viewer` 两种 ref 所以拆得最碎、最先暴露。②**列表排序判据同步**——`popup.js` 的 `visibleItems` 原来只在 `mid` 相同时按序号排，改动 ① 之后「同标题跨消息」的成员仍然会被拆散，用户看到的正是「⑪ 在最上面、下面才是 ①②③」；改成「两都有标题且相同 → 按 idx 排；都无标题 → 退回比 mid」。③**blob 可预览**——预览按钮原来的门槛是 `/^https?:/`，Telegram 的 `<img>`/`<video>` 的 src 就是 `blob:https://web.telegram.org/…`，全被挡掉；抽出 `canPreviewSrc(it)`，只排除 MSE 合成条目（`u` 形如 `m1`/`m2`）和非媒体类型，`http/https/blob/data` 一律放行，画不出来时预览框自己会显示「预览加载失败」。测试 `test/group_key.test.js` 15 项（G1 分组 4 / G2 小红书回归 2 / G3 预览 6 / G4 排序 3），**先跑红**（`|①|②`、`|`、未找到 `canPreviewSrc` 三条失败）再改绿。 | **已完成** |
| B7 | 焦点收窄（只看当前打开的那一条）+ 编号对不上内容（用户 m13863 / m13975） | **已完成（1.3.17，分支 `fix/focus-scope`）**：两件事同源，都是「数据通路的时机」问题。①**编号对不上内容**——`renumberImages(rec)` 原来在 `sniff:get` 开头对**整份 `rec.items`** 编号，之后才过 `visible`（去 icon）和 `shown`（去重）两道滤网，被剔掉的条目序号照样发出去，于是 6 条内容出现 ⑨、真图从 ③ 跳到 ⑥。改成「编号必须在所有滤网之后做」：`renumberImages` 只算分组不写字段，新增 `numberShown(items, tabUrl)` 在**最终显示的数组**上编 ①②③，没进任何组的条目显式 `it.idx = 0; it.mark = ""`（条目对象复用，不清会留旧 mark）。②**焦点收窄**——小红书/B 站靠详情页 URL 里的 noteId/bvid 天然收窄，Telegram 地址永远是频道地址，所以新增第九个站点钩子 `focus()`：Telegram 的 `tgFocus()` 从查看器容器的 `data-message-id` 反查，`reportFocus()` 变化才上报 → `background` 存 `rec.focus`（只放内存不落盘）→ `sniff:get` 里 `applyFocusFilter(shown, rec.focus)`（命中为空则原样返回全量，防误清空）→ `popup` 显示 `#focusBar` 提示条 + 「显示全部」出口（发 `ms:page-forget-focus`）。测试 `test/focus_scope.test.js` 17 项 + `test/group_key.test.js`、`test/background.test.js` 调用点同步改走 `numberShown`。详见 `DEVLOG.md#d-022`。 | **已完成（自动化测试通过，未真机 → 真机未过，由 B8 补齐）** |
| B8 | B7 真机返工：编号跨消息错位 + 焦点上报永久失效（用户 m14306 / m14493） | **已完成（1.3.18，分支 `fix/tg-focus-and-number`，真机验证通过）**：B7 交了自动化测试全绿就合并，用户真机一测两件事都还在。真机 dump 出四个事实：①**编号错位**——分组键按标题跨消息合组（B6 要的），但组内排序只比 `ord`，而 `ord` 是「**消息内**的第几个」，每条消息从 0 重开；真机「编号：#CC0385」横跨 mid 7497/7498/7508，三个 `ord=0` 撞在一起，平局退到抓取时间 `t`（≈随机）→ 跳号。修法：抽出 `compareWithinGroup()` 加一层 **mid 数值升序**，`renumberImages`/`numberShown` 两处原本各写一份的 sort 合一。②**编号还是乱**——`popup.js` 的 `visibleItems()` 第一行 `if (ka !== kb) return ka - kb;` 把所有 video 提到 image 前面，真机拿到 `②④⑥…` 在前、`①③⑤…` 在后。序号是阅读顺序、kind 只能兜底：提 `sameGroup()`，同组且都编号时 idx 压过 kind。③**焦点从来没收窄过**——`#MediaViewer` 上溯链（`.MediaViewerSlide--active → .MediaViewerSlides → DIALOG#MediaViewer → .opacity-transition → .Transition → BODY`）**全无 `data-message-id`**，`.message.highlighted/.selected` 也是空（TG 跳转用滚动定位不加类），B7 那两条路径必然返回空。新增方案 B `tgFocusByMedia()`：取 `--active` 那一页的 `currentSrc/src`，去 `[data-message-id] img, [data-message-id] video` 里找同地址的元素再上溯 22 层。④**一次丢包 = 永久失效**——`reportFocus()` 只在变化时发，查看器刚打开那次若 SW 没就绪就丢了，可 `lastFocus` 已置位，之后永远判定「没变化」。加 `FOCUS_RESEND_MS = 5000` 周期性补发。**真机结果**：`{"focus":{"kind":"mid","id":"7498"},"total":20,"counts":{"video":10,"image":10}}`，popup 渲染 20 行连续 ①→⑳ 无跳号、图视频按阅读顺序交错、全是「消息 7498」。测试 JS 517 项 + Python 8/8。详见 `DEVLOG.md#d-023`。 | **已完成（真机验证通过）** |
| B9 | 视频封面默认不当图片收（用户 m15108） | **已完成（1.3.20，真机验证通过）**：用户原话「默认情况下，不会获取视频封面作为一张图片，有需要再做特殊处理，代码里留有改动的余地。目前来看只获取 B 站、小红书视频封面当作一张图片」。①**一张白名单表**——`extension/background.js` 图标判定区新增 `VIDEO_COVER_SITES = ["bilibili.com", "xiaohongshu.com"]` 与 `coverAllowed(host)`（左右补 `.` 再 `endsWith` 比较，子域自动跟随，`fakebilibili.com`/`bilibili.com.evil.net` 不误命中）。**加/去站点只改这一张表，数组清空 = 全网都不收**。②**过滤落点**——`sniff:get` 里 `visible` 那一步：`const coverOK = coverAllowed(hostOfUrl(tabUrl)); items.filter(it => it.k !== "icon" && !(!coverOK && String(it.hint||"").indexOf("cover") >= 0))`。放这里而不是 `record()`，因为 SPA 修正过的 tabUrl 只有在这一步才准。③**hint 要能区分**——原来小红书视频帖封面和正文图**共用** `hint="xhs-note"`，没法分开。改成 `scanXhsNoteImages()` 按 `xhsNoteType() === "video"` 给封面打 `xhs-cover`，图文帖的正文图仍是 `xhs-note`（不误伤）。④**连带三处对齐**——`renumberImages`/`numberShown` 的「真实条目」判据、`preferXhsNoteList` 的直读判据，都补上 `xhs-cover`，否则视频帖会被判成「没直读过」而退回全量噪声。**真机证据**：后台 `chrome.runtime.getManifest().version === "1.3.20"`、`VIDEO_COVER_SITES === ["bilibili.com","xiaohongshu.com"]`；模拟过滤 `example.com → ["xhs-note","none"]`（两条 cover 被滤）、`xiaohongshu.com → ["bili-cover","xhs-cover","xhs-note","none"]`（全留）；小红书图文帖真实页面 `counts={image:1}` 正文图未被误伤。测试 `test/background.test.js` 新增 `[COVER]` 7 项（白名单内容、两个站点放行、其它站点默认拒、子域跟随、相似域名不误命中、大小写容错）。JS 515 项 + Python 8/8。 | **已完成（真机验证通过）** |
| B3 | 51cg1.com 视频列表为空（仅有审查证据，无本机复现） | 审查文档第 7 章记录的现象。按用户要求**这个站先不管**，只做通用加固：`tabId=0` 误丢已修（可能正是首发标签页抓不到的原因），并在 `record()` 每条丢弃路径加了 `diagBump` 计数；下次遇到同类站点，popup 空列表会直接显示「收到 N 个请求，已丢弃：体积过小 x 条 / …」 | 通用加固完成 |

| B10 | B 站视频页图片栏混入非封面横幅（用户 m15248） | **已完成（1.3.24，真机过）**：视频页 state 里 33 条图片全部来自 **webRequest**（页面侧 `isImageOnly` 实测已生效，视频页 45 个 `<img>` 通过 0 个）。两处修：①`inject-main.js` 新增 `biliIsVideoPage()`，页面类型改看 **URL** 而不是 `__playinfo__`（后者首屏异步为空、番剧页永远为空）；`isImageOnly` 在「视频页拿不到封面」时改为一张都不报。②`background.js` 新增 `preferBiliCover(items, tabUrl)` 接在 `sniff:get` 里，视频页只留 `hint==="bili-cover"`，非视频页原样返回。真机：视频页 `image` 33→**1**，首页 `image` **49 全部保留**（不误筛）。详见 `DEVLOG.md#d-026`。 | **已完成** |
| B11 | Telegram 视频封面混进图片栏（用户 m15279） | **已完成（1.3.22，真机过）**：两类封面 URL/尺寸与真照片完全一致，只能靠 DOM 结构认——①`.media-inner` 里 `<video class="full-media">` + `<img class="thumbnail">` 同容器；②左栏 `.media-preview` 里配 `<i class="icon icon-play">`。1.3.21 加了 `isDecorImg` 钩子只管住**新**扫描；封面是 `blob:` URL、每轮换地址，**旧地址条目留在 state 里**。1.3.22 新增 `pruneStaleImages(rec)`，在 `sniff:get` 取快照前按当前规则重算清理。真机：`image` 26→**10**，`media-preview` 15→**0**，`thumbnail`→**0**。详见 `DEVLOG.md#d-025`。 | **已完成** |

**顺序：A1 ✅ → A0b ✅ → A2 ✅ → A4 ✅ → B1 ✅ → A3（待真机）→ B2 → B3 → B6 ✅（1.3.16）→ B7 ✅（1.3.17）→ B8 ✅（1.3.18，真机过）→ B9 ✅（1.3.20，真机过）→ **B11 ✅（1.3.22，真机过）** → **B10 ✅（1.3.24，真机过）** → 待讨论：B5 → 优化阶段：B4。**



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
