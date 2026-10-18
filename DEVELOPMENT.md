# 开发文档

面向**要改这个扩展代码的人**。安装和使用看 [README](README.md)。

这里只讲「代码为什么长这样」——架构、关键决策、以及**踩过的坑**。如果你正打算动某块代码，
先在这份文档里搜一下相关关键词，很可能有人（包括我）已经踩过同一个坑了。

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
> 这是「改完没效果」的头号原因，历史上已经因此误判过两次。

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

### 小红书

详情页的「推荐」「相关」「评论」里全是别的帖子的图，而它们和正文图**共用同一个
CDN 签名**（`1040g`），光看 URL 区分不了。所以改成看 DOM。

> ⚠️ **下面第 1、2 条是旧版做法，已证明在真机上失效**（见第 9 章）。
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
3. **祖先链容器推算（兜底）** —— 从本元素逐层向上，用 `contains()` 数「该子树里有多少张
   正文图」，取覆盖最多图的容器；若它装不到全页多数（`< ceil(总数/2)`）就判定失败、
   放行。这一步不依赖任何类名，对本轮/流式布局都成立。

封面重复两张的原因：同一张图会以不同尺寸后缀被引用多次（主图位 + 缩略图/预载），
URL 不同就记成两条。修法是 `dedupeXhsNoteImages()` 按 pathname（砍掉 `!` 之后的部分）
归并，同身份只留体量最大的那张。

---

## 8. 已知限制

- **只对浏览器内播放有效**。Telegram Desktop / 手机 App 不经过浏览器，原理上抓不到。
- **Blob 有保质期**：页面 revoke 后再保留 5 分钟，过期只能重新播放一次。
- **MSE 拼接尽力而为**：随机 seek 会让同一分片被 append 多次，拼出来可能花屏。
- **直播**只能从启动那刻起录。
- **DRM 内容不支持**，也不打算支持。
- 小红书/抖音这类页面改版频繁，判定规则（类名、URL 签名）随时可能失效。

---

## 9. 待解决清单（用户 2026-10-18 提出，逐条解决）

> 用户原话：「问题仍然存在，1.评论区里的图片也会抓取，这个要改 2.小红书的视频无法读取，
> 名字对不上等和图片之前遇到的问题一样 3.视频或图片的水印能否去掉 4.给代码添加注释，
> 方便以后读取更改 5.给功能分组，方便快速定位问题（待定，之后在商量）
> 6.在开发文档里写一个章节，把整个开发过程中，实现功能时遇到的问题以及解决方案全部写进去。
> 把这六个问题写入开发文档，待目前这个问题解决好，你提醒我，一个一个地解决。」
>
> 处理顺序：**先收尾当前 XHS 归属问题（第 1 条的根因），再按 1→2→4→6→3→5 逐条推进。**
> 第 5 条用户标注「待定」，需单独商量方案后再动手，不擅自开工。

| # | 问题 | 状态 | 备注 |
|---|---|---|---|
| 1 | 评论区里的图片也会抓取 | **已完成** | 双判据拦下（URL 含 `/comment/` 或 DOM 上溯命中评论容器），见 9.1b |
| 2 | 小红书视频无法读取、名字对不上 | **已完成** | blob: 里取真实 `masterUrl`；标题回退 `desc` + 晚到标题补发，见 9.1b；第十二轮又修掉「选到 m4s 分片」和「blob 抢先上报」，见 9.5 |
| 3 | 视频或图片的水印能否去掉 | 待评估 | 见 9.3 的风险说明，大概率属于「做不到/不建议做」 |
| 4 | 给代码添加注释 | **已完成** | popup 11%→36%，host 系列 6~11%→16~22%，整体 39%，见 9.2 |
| 5 | 给功能分组，方便快速定位问题 | **待定** | 用户明确说之后再商量，不动手 |
| 6 | 开发文档补一节「实现过程中遇到的全部问题与解决方案」 | 进行中 | 本章即为该节落点，逐轮补齐；第 4 章「踩过的坑」与 9.1/9.1b/9.2/9.4/9.5/9.6/9.7 已覆盖大半 |

> 后续顺序：**3 → 5 待用户发话**。第 6 章随每轮进展继续补。

### 9.0a 第十三轮收尾后用户提的三条（2026-10-18 22:00，明天做）

> 用户原话（m06550）：「1.既然标题不一样就不要加序号了；2.B站的图片获取我想改为仅获取所点开视频的封面；
> 3.Telegram视频和图片下载全部失效。把这三个问题留档，明天再做，我说继续你就开始一个一个做。」

| # | 问题 | 现象 / 排查起点 | 状态 |
|---|---|---|---|
| A0 | **功能模块化（先讨论方案）** | 用户 m06569：「图片和视频下载是否有通用的代码，是否需要针对特定应用添加逻辑。明天开始先讨论这个问题，讨论出方案，再解决其他问题」。核心：现在 `inject-main.js` 里图片扫描 / 视频嗅探 / Range 下载 / 站点适配（B 站、小红书、Telegram）是同一套，站点专属逻辑散落在 `scanImages`/`scanMedia`/`guessTitle`/`runRangeDownload` 各处 if 分支。要评估是否抽出通用层（通用扫描器 + 站点插件点），以及各站点真正需要特化的只有哪些点。**讨论完再定，不擅自重构。** | 待讨论 |
| A1 | 首页信息流封面不加序号 | 真机截图：信息流封面标题各不相同却仍带 ①②③ 编号（`①于小…`、`①好…`）。序号机制在 `background.js` 的 `renumberImages()`：详情页整帖共用一个序号池（`gk = "xhs"`）；首页 feed 现在有了 `xhsFeedTitle()` 标题（本轮新加），但分组逻辑仍按 `k+ref` 给编号。改法：首页 feed（`isXhsDetailUrl(tabUrl)` 为假）时跳过编号（每条 mark 置空），只有详情页保留 ①②③。 | 待办 |
| A2 | B 站图片只取所点开视频的封面 | 现在 B 站页面会把预览图/推荐图/头像等混进列表。改法：在 `inject-main.js` 的 `scanImages()` 加 `isBiliHost()` 分支——视频页（`/video/BV…` 或 `__playinfo__` 存在）时只保留当前视频封面（`__INITIAL_STATE__.videoData.pic` 或 `<img class="bpx-player-cover">` / `.video-info` 内的图），其余图全部跳过。 | 待办 |
| A3 | Telegram 视频和图片下载全部失效 | 用户原话「Telegram视频和图片下载全部失效」。Telegram 上轮实测依赖 `include` 凭据 + `no-store`；本轮 `fetchRange` 的 `cacheMode` 改过（omit→default），且 `hostWrite` 加了 signal 透传、`msfile_abort` 加了 10s 超时——需先在真机复现：重载扩展→打开 Telegram→点图片「保存」看在哪一步断（fetchRange？hostRequest？）。排查时注意 `onDisc` 分支的「连接已断开」提示和 host.log。 | 待办 |
| A4 | 「本次记录」改为「下载记录」 | 用户 m06575：「把 本次记录 改为 下载记录」。改 `extension/popup.html` 的 `historyBtn` 文案、`extension/popup.js` 的 `renderHistory` 里 `<h4>` 标题「本次下载记录」→「下载记录」、以及空列表提示「本次会话还没有下载记录」→ 相应措辞。纯文案，无逻辑改动。 | 待办 |

**处理顺序：A0（先讨论方案）→ A1 → A2 → A3 → A4，用户说「继续」即开始。**


### 9.1 第十轮已完成：小红书「别人帖子的图/视频」彻底剥离

这一轮把归属判定从「按父节点分组 + 猜类名」换成了三条独立信号（详见第 7 章），
并修掉了一个**测试桩造成的假绿**——这类问题值得记一笔：

- **现象**：`[5z]` 两项红测（推荐位视频没被排除）。
- **误判**：一开始怀疑是 `imgBelongsToCurrentNote` 的逻辑，还用隔离脚本 `dbg5.js`
  自建 DOM 复现了一遍，结果**代码全对**（`belongs=false`），和测试现场对不上。
- **真因**：`[5w]` 结尾把 `sandboxLocation` 切回了 Telegram，而 `[5z]` 忘了切回小红书。
  归属函数第一句是 `const cur = xhsCurrentNoteId(); if (!cur) return true;`
  —— 非详情页直接放行，于是**归属逻辑压根没执行**。
- **怎么揪出来的**：在函数里临时插三个 trace 点（enter / ①URL / ②祖先），
  跑测试打印出 `[TRACE 推] enter {"cur":""}`，一眼看到 `cur` 是空。
  **定位顺序应该反过来：先证明函数有没有被执行，再怀疑函数内容。**
- **修法**：`[5z]` 开头补回 `sandboxLocation` 的三行赋值（href/hostname/pathname）。

同一轮还确认了视频和图片共用一套判据，但有两个坑：

1. 兜底路径 `document.querySelectorAll("img")` **只认 `<img>`**，
   所以视频的归属只能靠 ①②（URL noteId / 祖先 `data-note-id`）和
   `xhsInOtherNote` 快速排除，不能指望「图最多」的证据。
2. 页面上如果一张正文图都没有（纯视频帖），`noteImgs.length <= 1` 会直接放行，
   这是刻意的「宁可多抓不可漏抓」。

**测试现状**：`test/main-hook.test.js` 132 项全过、`background.test.js` 88 项、
`range_parallel.test.js` 14 项、Python 7 套全过。

### 9.1b 第 1、2 条：评论图 / 视频 / 标题（真机联调后补修）

上一条解决的是「推荐位他帖」，用户真机复测后又报了评论区图片和视频问题。
这一轮的证据全部来自**已登录的真机 DOM**，不是猜的：

| 现象 | 真机看到的 | 修法 |
|---|---|---|
| 评论区图片被当正文抓 | 评论图 URL 路径里多一段 `/comment/`（正文图没有）；DOM 上有 `comment-item`/`comment-picture` | 双判据：`imgIsXhsComment(src)` 或 `xhsInComment(el)` 一律跳过 |
| 视频抓不到 | `<video>.currentSrc` 只有 `blob:`，属性里没有真实地址 | 从 `__INITIAL_STATE__.note.noteDetailMap[id].note.video.media.stream` 取最高清晰度的 `masterUrl` |
| 视频名字对不上 | 该帖 `note.title === ""`，文字在 `note.desc` | `xhsNoteTitle()` 取 `title \|\| desc`；`guessTitle` 优先用它 |
| 名字还是空 | `__INITIAL_STATE__` 异步挂载，首轮一定取不到标题，而 `found` 只发一次 | 晚到标题补发一条 `found`（`lateTitle` 机制） |

三个值得记住的细节：

1. **`http://` 必须转 `https://`**。`masterUrl` 给的是 `http://`，和 webRequest 抓到的
   https 条目 key 不同，列表里会出现同一个视频两条、一条有名字一条没有。
2. **`lateTitle` 的判据连错两次**。第一版判 `!title`，但那是在取标题**之后**，恒不成立；
   第二版判 `titles` 是否为空，首次必空，导致 Telegram 这类「首轮就有标题」的站点
   多发一条 `found`，红了 3 条测试。正确判据是 `!seenSrc.has(url)` ——
   `seenSrc` 在首轮 `found` 后立刻加入，次轮才是 true。
3. **`note-id` 要排在 `data-note-id` 前面**。正文容器是 `<div class="note-detail-mask" note-id="...">`，
   信息流卡片才是 `data-note-id`，两种名字并存。

真机验证：全页 70 张图里放行 1 张（正是帖子封面），评论图 2 张被 URL 拦下、他帖 29 张、
装饰图 33 张；视频条目带上了 `title: "哇塞！"` 与 `1080×2416`。

### 9.2 第 4 条：注释补完（本轮）

只补「为什么」，不复述「做了什么」——后者看代码就知道，前者想不起来。

| 文件 | 补前 | 补后 | 补了什么 |
|---|---|---|---|
| `extension/popup.js` | 11% | 36% | 文件头字段速查表（`u/k/s/m/mid/ref/ord/idx/mark` 各自含义）、三处排序规则、两条渲染分支为何不能混、`setHost(null)` 的语义、`closePreview` 为何必须先 pause |
| `native-host/sniffer_host.py` | 11% | 21% | 帧协议与写锁的关系、`msfile_chunk` 按偏移写的幂等理由、`_safe_name` 处理的四件事、`do_download` 的副作用顺序 |
| `native-host/downloader.py` | 6% | 16% | 三条下载路径的分工、`write_status` 为何合并式+原子替换、续传时 206/200 的处理差异、ffmpeg `out_time_ms` 其实是微秒这个历史 bug |
| `native-host/setup.py` | 7% | 22% | 安装三步缺一不可、manifest 三个硬要求、`cmd_status` 为何要校验注册表指向 |

整体 6445 行代码里 2565 行注释（39%）。`background.js` 和 `inject-main.js` 原本就在
24%，本轮未动——它们的注释密度已经够，且都集中在非显然的分支上。

### 9.3 第 3 条（去水印）必须先说清楚的现实

去掉平台水印**不是**嗅探扩展能做的事，原因有三层：

1. **水印多数是烧进画面的**（B 站/小红书部分稿件、第三方搬运视频）。这类水印是像素，
   拿到的源文件里就已经有了，需要图像修复（inpainting）才能消，属于重编码、有损、且耗时。
2. **平台把水印当版权标识**。小红书/抖音/ B 站的「无印原图」接口需要登录态签名，
   绕过去属于对抗平台风控；把成品再分发也可能涉及侵权。
3. **技术上能做的那一小块**：部分站点的水印是叠加层（CSS/Canvas 图层）而非像素，
   但这类站点屈指可数，且抓到的源文件本来就不含图层。

**建议**：这一条先按「评估结论 = 不做像素级去水印」处理，若用户坚持，再限定为
「只在能确认水印是独立图层、且不涉及重编码时，提供开关」。实施前需再次确认。

### 9.4 第十一轮：图片预览 / 重复封面 / 列表噪声（用户报「有些图片无法预览」）

用户原话：「有些图片无法预览，例如 https://www.xiaohongshu.com/explore/6ab221bd000000003602a63e」，
后续澄清「带标题的四张图均无法预览」「的确是有 18 张」「带标题的每行只有一个按钮」。

拆成四个独立缺陷，全部落地并真机验证：

1. **预览按钮根本没有**（不是加载失败）。`popup.js` 的 `renderItem(it)` 按 `it.page` 分支，
   `isPage` 分支只挂了一个「保存」按钮；小红书图片全部来自页面扫描，走的正是这条分支。
   → 在该分支补「预览」（只对 `image/video/audio` 且 `http(s)` 地址挂，`blob:`/MSE 在扩展页加载不了）。
2. **预览按钮不出现还有第二个原因**：`page` 标记永远停在 0。`confirmPageItem` 要求条目
   已有 `mid` 或 `title`，而 webRequest 常常比页面的 `found` 消息**先到**，那时 title 还是空，
   直接 return；等 title 补上来，page 就再也没人补了。→ 在 `existed` 更新分支里补调一次 `confirmPageItem(existed)`。
3. **同一张图记成 3~4 条**。小红书 CDN 路径是
   `/202610181600/<随机hash>/spectrum/<fileId>!后缀`，**时间戳段和 hash 段每次请求都变**
   （实测同一张图 16:00 是 `004ef08…`、16:05 变 `b5b96ec…`），拿整条 pathname 当身份永远对不上。
   → `xhsImgIdentity(u)` 改成只取 `<类型>/<fileId>`；档位后缀（`!nc_n_webp_mw_1` 缩略图 vs
   `!nd_dft_wgth_webp_3` 大图）也不算身份；头像路径 `/avatar/` 显式排除（头像 fileId 同样是
   `1040g` 开头，裸正则会把它当成正文图）。取不到稳定段返回空串 ⇒ 放弃去重，**绝不误删**。
4. **列表里混进噪声**。真机 dump 出来 29 条 image 里只有 7 条是正文图，其余是
   `svg-sprite.6.57.6.svg`（82KB，骗过体积线）、信息流里**别的帖子**的 `!nc_n_webp_mw_1`
   封面缩略图（fileId 各不相同，按身份去重根本去不掉）、无后缀随机 hex 的 UI 素材 png。
   → `sniff:get` 里叠一层 `preferXhsNoteList()`：只要页面报过 `hint === "xhs-note"` 的直读条目，
   就**只保留直读条目**（视频/音频不受影响）；没报过就原样返回，宁可多几条噪声也不能让列表空掉。

**顺手做的两件事**（源于用户转发的「小红书去水印」iOS 快捷指令）：

- 快捷指令的做法是抓分享页 HTML 正则扫 `imageList` / `masterUrl`，不碰 DOM 也不碰 webRequest，
  因此**不受懒加载影响**。顺着这条线实测本机详情页，`__INITIAL_STATE__.note.noteDetailMap[id].note.imageList`
  给出 7 张图、尺寸齐全、顺序就是发布顺序；而 DOM 那边 77 个带 `1040g` 的 `<img>` 里**只有 2 张解码出了尺寸**，
  其余 `naturalWidth = 0`（swiper 轮播只渲染首张）。
- 于是新增 `xhsNoteImages()` + `scanXhsNoteImages()`：`scanImages()` 开头先试直读，
  `ord` 直接用数组下标（不再靠 `getBoundingClientRect` 猜阅读顺序），`w/h` 用 `imageList` 的原始像素，
  `http://` 一律转 `https://`（否则和 webRequest 那条 https 记录分成两条）。读不到才退回原 DOM 扫描。
- **快捷指令的 `.shortcut` 文件解不开**：文件头 `AEA1`，offset 12 起的 bplist 只有
  `SigningCertificateChain`，真正的动作内容在加密块里，需要 Apple 设备私钥。全文件搜 `xiaohongshu`/`mp4`/`watermark`
  零命中。用户后来提供了「已解析」版本（`小红书去水印-快捷指令解析.md`）才看到逻辑。

**测试**：`main-hook.test.js` 132 → 145（新增 `[5v]` 13 项：imageList 张数 / 取大档 / http→https /
原始尺寸 / 数组顺序 / 非详情页返回 null / 无 state 返回 null / DOM 空也能上报 / ord 下标 /
尺寸 / 标题回退 desc / hint 标记 / 重复扫描不重复上报）；
`background.test.js` 94 → 101（新增 `[4c]` 7 项）。真机最终：`total 7, counts {image: 7}`，
编号 ①~⑦ 连续，7 行全部带「预览」按钮。

**按钮次序**：用户 2026-10-18 要求把「预览 / 保存」对调，「保存」靠右。理由是保存才是主操作，
右端贴近滚动条更好点；顺带也和非页面分支的「复制 / 打开 / 预览 / 下载」形成同一节奏
（重操作在右）。改动只是 `renderItem()` 里 `ops.append()` 的先后，按钮逻辑没动。

**真机复测的坑**：`loadUnpacked` 之后**必须再刷新页面**，否则页面里仍是旧的注入脚本
（这次表现为 `window.__msHostPort.disconnected === true`、`found` 一条都发不出去、state 里只剩 4 条 other）。

---

### 9.5 第十二轮：小红书视频抓不到、没标题、编号错乱（2026-10-18）

用户原话：「接下来是捕捉不到视频和视频没有标题两件事，刚才的快捷指令也能够下载视频，参考一下。
另外，图中的下载和保存有什么区别」，配图是视频帖 `6ad46958…`（「「当卡片可以收纳」」），
popup 里四条：页面视频（录制中）/ `01ead4686b…_m4a`（无标题）/ 页面音频（录制中）/ 图片 2560×1440。

#### 缺陷一：抓到的「视频」其实是 DASH 分片（录不到、放不出）

`xhsVideoSource()` 原来只按**面积最大**挑清晰度组：

```js
const area = (s.width|0) * (s.height|0);
if (area > bestArea) { bestArea = area; best = s; }
```

真机 stream 里同时存在两档：

| 档位 | 地址 | 尺寸 | 是什么 |
|---|---|---|---|
| `EF4` | `…_259.mp4` | 1280×720 | **完整文件**（音视频都在） |
| `EF5` | `…_3090.m4s` / `…_3092.m4s` | 2560×1440 | DASH 分片，只有画面、单下放不出来 |

2560×1440 面积更大，于是永远选中分片 —— 这就是「捕捉不到视频」的真正原因：
不是抓不到地址，是抓到了**一个下下来也不能播的地址**。

修法：先按「完整文件优先」再按面积。

```js
const isSeg = (u) => /\.m4s(\?|$)/i.test(u);
const rankOf = (u) => (isSeg(u) ? 0 : 1);
// ……循环里
if (rank > bestRank || (rank === bestRank && area > bestArea)) { bestRank = rank; bestArea = area; best = s; }
```

注释写明「宁可分辨率低一点，也要能播」。修后真机返回 `…_259.mp4`、1280×720、duration 21234ms。

**验证**：`curl -I -H 'Referer: https://www.xiaohongshu.com/'` → `200` / `video/mp4` / `912619` 字节；
下载后 `ffprobe` → `h264 1280×720` + `aac`，`duration=21.233333`。完整可播放。

#### 缺陷二：没标题 / `blob:` 条目抢先占位

原来 `scanMedia()` 只在 `src` 是 `blob:` 时尝试换真实地址，**换不到就退回 blob 照样上报**。
后果链：`__INITIAL_STATE__` 还没挂上时先报了 `blob:…` → 它成为这个视频唯一的 `found`
（`seenSrc` 挡住后续同元素上报）→ popup 出现「页面视频（录制中）」，存下来是坏的；
同一个元素还被 MSE hook 记成 `m1`/`m2`。

改成**拿不到真实地址就这一轮跳过**（600ms 后再来，页面加载完就一定有）：

```js
const real = xhsVideoSource();
if (!real || !real.url) continue;
src = real.url;
if (real.w && real.h) { el.__msW = real.w; el.__msH = real.h; }
if (real.duration) { el.__msDur = Math.round(real.duration / 1000); }
el.__msOrd = 0;  // 视频帖里视频是正文第一件东西
```

`handleMediaSrc():(445-470)` 相应读取 `el.__msW/__msH/__msDur/__msOrd`，覆盖 DOM 上读不到的尺寸、时长和顺序
（`<video>` 元素本身没有宽高属性，`ordOfMedia()` 也只会给个粗值）。

标题走的是第十轮就做好的 `xhsNoteTitle()`（`note.title || note.desc`），这一轮不再动；
没标题的观感问题主要来自 `blob:` 条目（标题恒空），它不再上报后就消失了。

#### 缺陷三：B 站合成条目串到小红书页

`popup.js` 原来写成 `if (hideRecorder())` 就补 `BILI_DASH_KEY` 合成条目。而这一轮小红书详情页
也开始 `hideRecorder()`（把 `isXhsDetailPage()` 加进去），于是小红书页顶部冒出
「B 站视频（完整 DASH 流）」。拆成两件事：

```js
const hide = hideRecorder();
let list = hide ? allItems.filter((it) => !isRecorderItem(it)) : allItems.slice();
if (isBiliSite()) { /* 补 BILI_DASH_KEY 合成条目 */ }
```

顺带修两处口径问题：

- `shownItems()` 在小红书详情页再过滤一层 `list = list.filter((it) => it.page || (it.title || "").trim())`
  —— 去掉播放器拉的 m4a/m3u8 裸链接（用户截图里那条无标题的 `01ead…_m4a`）。
- `renderChips()` 的计数改成 `src.filter((it) => it.k === k).length`，不再用 background 的 `counts[k]`。
  `counts` 是在 background 里算的，包含被 popup 隐掉的录制条目，会出现「chip 写 3、点进去 1 条」。

#### 缺陷四：编号错乱（MSE 条目拿走 (26)）

真机 `sw_ord.js` 看到 state 里 `m1` 拿到 `mark:"(26)"`，真图被顶到 ③④⑤。原因是
`renumberImages()` 只在 background 里跑，popup 的隐藏逻辑它并不知道。

`background.js:542-546` 增加小红书专用跳过规则：

```js
if (xhsDetail) {
  if (/^m\d+$/.test(it.u || "")) continue;                    // MSE 分片
  const real = it.hint === "xhs-note" || (it.title || "").trim();
  if (!real) continue;                                        // 站点素材 / 别的帖缩略图
}
```

并把小红书详情页的分组键 `gk` 从 `it.k` 改成常量 `"xhs"` —— **视频、图片、封面共用一个 ①~Ⓝ 池**。
视频帖的 `imageList` 只有 1 条（就是视频封面），所以 `scanXhsNoteImages()` 里给封面加偏移：

```js
const coverOffset = xhsNoteType() === "video" ? 1 : 0;
const ord = i + coverOffset;
```

视频 `ord=0` 拿 ①，封面 `ord=1` 拿 ②。

真机最终：

```
全部 2 / 视频 1 / 音频 0 / 图片 1
▶ ① 「当卡片可以收纳」   页面捕获 · 1280×720 · 0:21 · video/mp4
▣ ② 「当卡片可以收纳」   页面捕获 · 2560×1440 · image/webp · 49.9 KB · ×2
```

#### 关于「下载」和「保存」两个按钮的区别

用户在同一轮问了这个问题。它们不是同一个操作的两种叫法，走**完全不同的链路**：

| | **保存**（蓝底） | **下载** |
|---|---|---|
| 哪些条目有 | 带 `page` 标记的页面捕获条目 | 不带 `page` 的裸 webRequest 条目 |
| 入口 | `savePageItem()` → `page:save-batch` | `startDownload()` → `native:download` |
| 谁取数据 | **页面自己** fetch 整段，经 Native Messaging 分块写盘 | **native host 起独立进程**（`downloader.py`） |
| 用户看到 | 页面里弹浮层确认 | popup 里出现进度条，关掉弹窗继续下 |
| 能不能处理 blob / MSE / 分片 | **能**（数据在页面内存里） | 不能（只对直链有效） |
| 典型限制 | 走扩展消息通道，Telegram 那类有 512KB 限制的页面正是靠它绕开的 | CDN 校验 referer，所以会带上抓取时的 `it.i` |

一句话：**「保存」= 页面里取数据 + 浮层确认；「下载」= 把 URL 交给本地下载器（快、可后台、只对直链有效）。**

#### 测试

- `main-hook.test.js` → **150**（`[5z]` 补 `__INITIAL_STATE__` 桩：完整 mp4 优先于更大的 m4s、`http`→`https`、
  blob 被换成真实地址后再上报、blob 本身绝不上报、视频 `ord=0`、别的帖视频被排除、无真实地址时不报 blob）。
- `background.test.js` → **103**（`[4b]` 的 `recX` 补 `hint:"xhs-note"`；`recXV` 改断言「视频 ① / 封面 ② 共用一个池」；
  新增 `recNoise`：雪碧图 / 无标题缩略图 / MSE 不参与编号，且只有一张真图时不加序号）。
  **注意未编号条目的 `mark` 是 `undefined` 而不是 `""`，断言要写 `!x.mark`。**
- `range_parallel.test.js` 14、`python test/run_all.py` 7/7、`node --check` 三个文件全过。

#### 真机复测提醒

`Extensions.loadUnpacked` 之后**必须再刷新页面**，否则页面里还是旧注入脚本。
这一轮的表现是 `window.__msHostPort.disconnected === true`、`found` 一条都发不出去。
**看 state 条数比看代码更早发现问题。**

---

### 9.6 第十三轮（1.3.2）：点开笔记抓不到视频 / 保存卡在「正在读取媒体信息…」

用户原话：「版本号没问题就是捕捉不到视频了」，随后附截图：「一直卡在这里」。

| # | 现象 | 真凶 | 修法 |
|---|---|---|---|
| 1 | 小红书视频列表里只有一个 `m1`，没有标题 | 视频只靠 `scanMedia()` 扫 `<video>` 才上报。从信息流点开笔记时播放器还没挂载，`currentSrc` 是空的 → `if (!src) continue;` 整场静默 | 新增 `reportXhsVideo()`：地址和标题都从 `__INITIAL_STATE__` 取，**与 `<video>` 无关**，按 noteId 直接报 |
| 2 | 保存永远停在「正在读取媒体信息…」 | `extension/sniffer-hostport.js` 的 `disconnected()` 清空 listeners 却从不 reject，`hostRequest` 的 45s 超时失效，Promise 永久 pending。扩展一被重载，旧页面必然如此 | 断开时置 `disconnectedFlag`，此后 `send()` 直接抛错；提示改成「扩展可能刚更新过，请刷新本页后重试」 |
| 3 | 宿主连不上（`Specified native messaging host not found.`） | 隐私清理时改了 `HOST_NAME`，唯独漏了被 gitignore 的 `native-host/host_manifest.json`，注册表挂的还是旧名 | 改 `name` 为 `com.starmediasniffer.host` 后重跑 `setup.py install` |
| 4 | 列表里同时有真实视频和「页面视频（录制中）」 | MSE/blob 条目每 0.6s 被重新播报一次，事后清理永远清不完 | 同 tab 已有 `hint === "xhs-note"` 的真视频时，MSE/blob 条目**不再准入** |
| 5 | `fetch` 抛 `TypeError: Failed to fetch` | 小红书 CDN 的 CORS 不回 `Access-Control-Allow-Credentials`，`credentials:"include"` 必失败；`reload`/`no-store` 则每次真回源（250~380ms vs 默认缓存 5ms） | omit 模式改用 `cache:"default"`；include 分支保留 `no-store`（Telegram 需要） |

真机结果（ego 浏览器，帖子 `6ad46958000000002f03b260`）：

```
▶ ① 「当卡片可以收纳」  页面捕获 · 1280×720 · 0:21 · video/mp4   预览 保存
▣ ② 「当卡片可以收纳」  页面捕获 · 2560×1440 · image/webp         预览 保存
全部2 / 视频1 / 音频0 / 图片1
```

保存落盘 `912619` 字节，`ffprobe` = h264 1280×720 + aac、`duration=21.233333`，1 秒完成。

**教训**：`chrome.storage.session` 里 `items` 是 `[[url, item], ...]` 数组而不是对象，
探针脚本直接 `x.k` 会让 `kinds` 全是 `undefined`，看起来像「代码把分类写坏了」。

### 9.7 第十四轮（1.3.3）：提升「广覆盖」——三项低风险改动

背景：参考了公开的 MV2 抓流扩展的实现思路（`89891383/video-downloader---CocoCut`，
webpack 单行压缩），吸取其三层思路中的「嗅探层」与「通用去重」两处，落地为本轮三项低风险改动。
（MSE 分片重组那一层工程量太大，作为独立计划记在 9.8。）

吸收到并落地的做法：

- **`onResponseStarted` 嗅探**：在原 `onHeadersReceived` 之外补一层，用 `requestId` 去重，
  兜底抓「content-type 缺失 / 短头 / Service Worker 缓存响应」这类头响应漏掉的媒体。
- **通用去重**：用「host + pathname（去 query、去 hash）」做内容身份，同一资源的 query 签名
  变化不再产生 N 条重复。
- **可配置的分类阈值**：给分类加最小体量门槛，挡掉 1×1 像素、空占位等假资源。

本轮落地三项（都在 `extension/background.js`）：

| # | 改动 | 说明 |
|---|---|---|
| 1 | 补 `onResponseStarted` 监听 | 用 `requestId` 去重防 hits 翻倍（`recordedRequestIds` set，满 20000 整体清空）。onHeadersReceived 抓「带完整响应头」的，onResponseStarted 兜底抓「content-type 缺失 / 短头 / SW 缓存响应」的 |
| 2 | 通用图片去重 `identityOf` + `dedupeImagesByIdentity` | 身份 = `host + pathname`（去 query、去 hash），同身份裸图只留体量最大。**只合并裸条目**（无 mid/title/page/hint），带 DOM 上下文的绝不合并。只作用于非小红书详情页（小红书有更权威的 `dedupeXhsNoteImages`） |
| 3 | 最小体量门槛 `MIN_MEDIA_BYTES` | video≥2KB、audio≥10KB、image≥512B，挡掉 1×1 像素/空占位。**只作用于 statusCode≠206 的完整响应**（206 是 Range 分段，content-length 只是分段长） |

测试：background 103 → **116**（新增 `[4d]` 13 项）。main-hook 160、range_parallel 14、
Python 7/7、`node --check` 全过。

### 9.8 新计划（未开始）：MSE buffer 重组，实现「通用流媒体抓取」

**目标**：让扩展能抓「没有可嗅探 URL、数据只走 MSE/blob 的流媒体」，不靠每站单独读
`__INITIAL_STATE__` 打补丁。

**背景**：B 站、小红书我们已靠「站点级直读 `__INITIAL_STATE__` + DASH/m4s 直连」走通；
但任何没做站点适配的站点（小众视频站、加密直播切片、iframe 内播放器）仍抓不到。
通用的思路是：**不找 URL，直接从内存里截下播放器正在吃的 buffer，重组出完整文件**。

**技术方案**：

1. **注入层**（`inject-main.js`，`document_start`）：hook `MediaSource.prototype.addSourceBuffer`，
   把返回的 `sourceBuffer.appendBuffer` 包一层，每次 append 的 `ArrayBuffer` 记下
   `{ mimeType, mediaSourceId, bufferId, timestamp }`。
2. **收集层**：buffer 按 mediaSourceId+bufferId 归组；`sourceBuffer.addEventListener("abort")`
   当作「这一路流结束」的信号。
3. **重组层**（新增一个 fMP4 解析模块）：把每段 buffer 解析成 `moov/traf/moof/mdat/sidx`
   box，按 sequenceNumber 排序、去重（随机 seek 会重复 append 同一段），拼成完整 mp4。
4. **落地层**：重组完的 Blob 走既有的 `page:save` / msfile 通路写盘（这条链路我们已经有了）。

**难点与风险（写下来，开工前要逐个想清楚）**：

- **加密流**（DRM / AES-128 HLS）：`appendBuffer` 拿到的已是解密后的明文，反而**能绕开**部分
  加密（比 webRequest 抓 `.ts` 密文强）；但带 license 校验的 DRM（EME）拿不到明文，仍抓不到。
- **随机 seek**：同一分片被 append 多次，必须按 `sequenceNumber` 去重，否则花屏/体积膨胀。
- **内存**：直播/长视频的 buffer 总量可能几个 GB，不能全存内存，要边收边落盘（复用 msfile 分块）。
- **时机**：hook 必须在播放器创建 MediaSource **之前**注入（`document_start` + `MAIN` world），
  晚了 hook 不到。这一点和「改 inject-main 必须刷新页面」的既有铁律直接相关。
- **代价/收益**：这是 3000+ 行等价逻辑的工程（要内嵌一个完整 MP4 box 解析器）。
  **除非要做「通用到任何站点」，否则收益/成本比不如继续按站适配。**

**建议开工顺序**：先做「注入层 + 收集层」（只记录 buffer 元信息、不重组），先验证能稳定
截到 buffer 且不拖垮播放器；确认后再上「重组层」。**开工前先和用户确认：是否真的要投入这块，
还是先按站适配够用。**

---
