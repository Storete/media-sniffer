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
| 1 | 评论区里的图片也会抓取 | **下一步** | 第十轮已修好「推荐位/他帖」归属，评论区是同一机制残留的一处，见 9.1 |
| 2 | 小红书视频无法读取、名字对不上 | 待办 | 与图片此前的问题同源：没进列表 / 命名链路不一致 |
| 3 | 视频或图片的水印能否去掉 | 待评估 | 见下方风险说明，大概率属于「做不到/不建议做」 |
| 4 | 给代码添加注释 | 待办 | 全量补关键函数注释与「为什么」说明 |
| 5 | 给功能分组，方便快速定位问题 | **待定** | 用户明确说之后再商量，不动手 |
| 6 | 开发文档补一节「实现过程中遇到的全部问题与解决方案」 | 待办 | 本章即为该节落点，逐轮补齐 |

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

### 9.2 第 3 条（去水印）必须先说清楚的现实

去掉平台水印**不是**嗅探扩展能做的事，原因有三层：

1. **水印多数是烧进画面的**（B 站/小红书部分稿件、第三方搬运视频）。这类水印是像素，
   拿到的源文件里就已经有了，需要图像修复（inpainting）才能消，属于重编码、有损、且耗时。
2. **平台把水印当版权标识**。小红书/抖音/ B 站的「无印原图」接口需要登录态签名，
   绕过去属于对抗平台风控；把成品再分发也可能涉及侵权。
3. **技术上能做的那一小块**：部分站点的水印是叠加层（CSS/Canvas 图层）而非像素，
   但这类站点屈指可数，且抓到的源文件本来就不含图层。

**建议**：这一条先按「评估结论 = 不做像素级去水印」处理，若用户坚持，再限定为
「只在能确认水印是独立图层、且不涉及重编码时，提供开关」。实施前需再次确认。

---
