# 资源嗅探 Media Sniffer

[![tests](https://github.com/Storete/media-sniffer/actions/workflows/tests.yml/badge.svg)](https://github.com/Storete/media-sniffer/actions/workflows/tests.yml)

一个自己写的 Chrome 扩展：**自动嗅探当前网页的所有资源**，视频/音频交给本地 yt-dlp 多线程下载，图片/文档等直接抓取。没有限额、没有限速、不采集数据。

> **先说边界**：能下的是「有一条能 Range 到头的地址」的站（下面 [支持范围](#支持范围) 里的 A 类与 E 类）；DRM 与登录墙不做；MSE 站（B 类）逐站适配。国内 20 个高频站的实测数据在 [`docs/site-audit.md`](docs/site-audit.md)。

![B 站视频嗅探](docs/screenshot-bili.png)

---

## 特点

| | |
|---|---|
| **8 类分组** | 视频 / 音频 / 图片 / 文档 / 字体 / 其他 / 分片，按 tab 独立归档 |
| **能抓 Blob / MSE 站点** | Telegram、以及一切把流解密后拼成 Blob 喂给 `<video>` 的站点 |
| **B 站完整视频** | 读 `__playinfo__` 的 DASH 清单，音视频分别抓完用 ffmpeg 自动合并成单文件 |
| **可选清晰度** | 多档 HLS 清单会列出 1080P / 720P…，选哪档就下哪档；默认给最高档，你选的那档已失效时会**回落并告诉你** |
| **小红书** | 只列当前帖子自己的图（不含推荐流、头像、二维码），自动排序 |
| **不限速、不限次** | 并发 16~64 可调，断点续传 |
| **全本地** | 没有远程配置、没有埋点，数据不出机器 |

---

## 安装

### 前置要求

- Chrome / Edge / Chromium（Manifest V3）
- **Python 3.8+**（本地组件用，只依赖标准库，不需要 `pip install` 任何东西）
- **yt-dlp**（可选，没有它会退化到单线程通用下载）
- **ffmpeg**（可选，但 B 站这类音视频分开的站点必须靠它合并成一个文件）

#### ffmpeg 怎么装（三选一）

**方式 A：一条命令（推荐，有 winget 就行）**

```bat
winget install Gyan.FFmpeg
```

装完**新开一个终端**，跑 `ffmpeg -version` 有输出就成了。

**方式 B：下载解压到 `bin/`**（没有 winget 时用这个）

1. 浏览器打开：https://github.com/BtbN/FFmpeg-Builds/releases/latest
2. 下载 `ffmpeg-master-latest-win64-gpl.zip`（**不要**选带 `-shared` 的，那个还要拖一堆 dll）
3. 解压，进到 `...\bin\` 目录，把里面的 **`ffmpeg.exe`** 和 **`ffprobe.exe`** 复制到本项目的 `bin\` 目录

项目里放 ffmpeg 的地方就是 `bin\`，放好之后是这样：

```
media-sniffer\
└── bin\
    ├── ffmpeg.exe
    └── ffprobe.exe
```

**方式 C：电脑上已经有 ffmpeg 了**

很多软件自带（OBS、剪映、格式工厂、各种下载器）。如果它已经在系统 `PATH` 里，直接就能用。不确定的话跑：

```bat
python native-host\setup.py status
```

输出里 `ffmpeg :` 后面有路径就说明找到了，不需要再装。

> **为什么仓库里不带 ffmpeg？** 两个 exe 加起来 323 MB，超过 GitHub 单文件 100 MB 的上限，而且会把仓库撑爆、每个 clone 的人都要多下三百多兆。ffmpeg 是第三方软件，本来也应该由用户自己装。

> **B 站合并需要的是 ffmpeg，不是 ffprobe**——但建议两个都放，`setup.py status` 会一起检查。

### 1. 装本地组件

```bat
双击 native-host\install.bat
```

它会做三件事：

- 生成 `host_manifest.json`（记录启动路径，**每台机器不同，所以不进仓库**）
- 生成 `python_path.txt`（记录当前解释器路径，同上）
- 注册 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.starmediasniffer.host`，顺带注册 Edge / Chromium 的同名键

> 只写当前用户注册表，不需要管理员权限。卸载跑 `uninstall.bat`。
> 想先看看状态：`python native-host\setup.py status`。

### 2. 加载扩展

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选这个目录：`<你放代码的地方>\media-sniffer\extension`

### 3. 核对扩展 ID

装好后 ID 必须是：

```
fofimjophfaibckjioaffoglkidppifo
```

**不是这个 ID 就用不了。** 本地组件按 `chrome-extension://<这个 ID>/` 白名单校验调用方，这是安全设计——别的扩展不能借用你的下载器。

ID 由 `extension/manifest.json` 里那段 `"key"` 决定，是公开信息，跟着仓库走。所以只要 `manifest.json` 没被改过，ID 就是稳定的，**不需要任何私钥**。

---

## 用法

1. 打开任意网页，**正常浏览**（滚一滚、点一下播放，让资源发出来）
2. 点工具栏图标 → 弹出面板
3. 顶部按类型筛选：全部 / 视频 / 音频 / 图片 / 文档 / 字体 / 其他 / 分片
4. 每条右侧：
   - **复制** → 复制直链
   - **打开** → 浏览器新标签直接打开
   - **下载** → 交给本地组件下载，面板底部显示进度
5. 右上角 **⟳** = 重新载入页面（刚装好扩展时列表是空的，这一步能抓全）

**并发数**在底部「并发」框改，默认 16，可以拉到 32~64。改完对新任务立即生效。

下载落在哪：`native-host\library.py` 会优先选一个非 C 盘的目录（Windows 上默认候选里带 `D:` 的优先），选不到才退回 `~/Downloads`。`setup.py status` 会打印实际路径。

---

## 几个站点是被特别照顾的

### B 站

普通嗅探只能抓到你已经播放过的那一小段（MSE 分片）。所以扩展在 B 站上换了做法：

- 页面里读 `window.__playinfo__` 拿到完整 **DASH 清单**（视频流 + 音频流，与播放进度无关）
- 两条流分别按 4 MB × 6 并发抓完，再用 ffmpeg `-c copy` 合并成单个 mp4（**无损，不重编码**）
- 列表里显示成一条 **「完整 DASH 流（音视频分开）」**，标题就是视频标题；多分P 会带 `-P2` 这样的后缀
- 页面右下角进度卡按「下载视频流 → 下载音频流 → 合并音视频」显示阶段，下载完可以一键「打开所在文件夹」

合并失败不算下载失败——两个源文件会保留，可以手动合：

```bat
bin\ffmpeg.exe -i video.m4s -i audio.m4s -c copy out.mp4
```

### 小红书

详情页的「推荐」「相关」「评论」里全是别的帖子的图，而它们和正文图共用同一个 CDN 签名（`1040g`），**光看 URL 区分不了**。所以改成看 DOM：排除掉带 `note-item` / `feed-item` / `recommend` 这类类名的容器，再用「父容器里图最多、面积最大」来投票认定正文容器。视频同理，列表里按顺序编号。

### Telegram / 任何 MSE 站点

见下面「为什么需要页面内 hook」。

---

## 为什么这么设计

```
┌──────────────── Chrome ────────────────┐
│  background.js (service worker)        │
│   webRequest 监听所有 http(s) 请求      │
│   → 按 mime/扩展名分类 → 按 tab 归档     │
│                                        │
│  popup.html/js                         │
│   列表 · 筛选 · 复制 · 下载按钮          │
└───────────────┬────────────────────────┘
                │ Native Messaging
                │ (4 字节长度 + JSON，走 stdin/stdout)
┌───────────────▼────────────────────────┐
│  sniffer_host.py  (宿主，随用随起)       │
│   ping → 汇报 yt-dlp / ffmpeg 是否就绪   │
│   download → 拉起独立进程后轮询状态       │
└───────────────┬────────────────────────┘
                │ detached（不随浏览器退出而死）
┌───────────────▼────────────────────────┐
│  downloader.py  (独立下载进程)           │
│   视频/音频 → yt-dlp -N 16 + ffmpeg 合并 │
│   其他资源 → urllib 单流 + 断点续传       │
│   → 状态写入 %LOCALAPPDATA%\MediaSniffer │
└────────────────────────────────────────┘
```

**关键点：下载进程是 detach 的。** 关掉弹窗、关掉浏览器、service worker 被回收，下载都不会断——重新打开扩展还在跑（`jobs` 目录里留着状态文件）。

---

## 为什么需要页面内 hook

**URL 嗅探对 Telegram 这类站点天然无效。** 它的视频不走普通 HTTP 流：

```
MTProto 分块传输 → 浏览器端解密 → 拼成完整 Blob / 喂进 MSE → <video src="blob:...">
```

网络面板里全是 `POST /apiw1` 二进制包，没有 `.m3u8`、没有 `.mp4`，`content-type` 是 `application/octet-stream`。只靠 URL 匹配的嗅探在这里同样是瞎的。

所以扩展多了一层**页面内 hook**（`inject-main.js`，跑在 MAIN world、`document_start`）：

| hook 目标 | 抓什么 |
|---|---|
| `URL.createObjectURL` | 完整视频拼成 Blob 后创建的那个 URL → 直接拿到 Blob 本体 |
| `<video>` / `<audio>` 的 `src` | **补漏**：Blob 在 Worker 里创建时主线程 hook 看不到，但 `src` 一定在主线程赋值 |
| `Element.setAttribute` + 轮询 `currentSrc` | 覆盖所有赋值方式——`currentSrc` 是浏览器解析后的最终播放源 |
| `URL.revokeObjectURL` | 页面释放 URL 时不立刻丢，**继续持有 5 分钟** |
| `MediaSource.addSourceBuffer` + `SourceBuffer.appendBuffer` | 走 MSE 流式播放的站点，按到达顺序累积分片（实验性） |

抓到后列表里显示为 **「页面视频 · mp4」**，点保存由宿主把内存里的字节直接写盘。

### 这套机制的边界

- **只对浏览器内的播放有效**。Telegram Desktop / 手机 App 不经过浏览器，抓不到。
- **Blob 有保质期**：页面 revoke 后再保留 5 分钟，过期只能重新播放一次。
- **Worker 里创建、且从不赋值给 `src` 的 Blob 抓不到**；只要它被拿去播放，就能拿到。
- **MSE 拼接是尽力而为**：随机 seek 会导致同一分片被 append 多次，拼出来可能花屏。能播，但别指望 100%。
- 内存代价：每捕获一个大视频，浏览器会多占一份引用直到 5 分钟到期。

---

## 支持范围

**一句话判据：这个站有没有一条能 Range 到头的地址。** 有 → 直接能下；没有 → 才会落进下面 B / C / D 三种情况。

| 类 | 站点长什么样 | 例子 | 支持 |
|---|---|---|---|
| **A** 标准流 | `<video src>`，或 `.mp4` / `.m3u8` 能 Range 到末尾 | 红果短剧、微博、今日头条、绝大多数图文与资讯站 | ✅ 开箱可用，不用为它写任何适配 |
| **B** MSE / Blob | 播放器边下边拼，页面拿不到完整地址 | B 站（✅ 读 `__playinfo__` 的 DASH 清单 + ffmpeg 合并）、Telegram（✅ 页面内 hook）、抖音（❌ 未做）、腾讯视频（⚠️ 只有已播片段） | 每站单独写，写不完 |
| **C** DRM | Widevine 等加密 | 芒果 TV、爱奇艺 / 优酷 / 腾讯的正片 | ❌ 不做 |
| **D** 登录墙 | 游客态不给播放器 | 91rb 等 | ❌ 技术无解，不是缺陷 |
| **E** 伪装 / 加密分片 | 清单长得正常、内容是壳 | 4kvm（PNG 壳分片）、51cg1（AES-128 + 分片断流） | ✅ 剥壳 + 分片退避重试 + 魔数判完成 |

**A + E 覆盖绝大多数站；C + D 不该也不必覆盖；剩下的只有 B，而 B 每站都要单独写。**
所以这里不承诺「支持多少个站」，只承诺两件事：**A 类下得稳，B / C / D 失败时说清为什么。**

2026-10-23 用 Chrome 156 + 游客态实测了国内 20 个高频站点（抖音另测），完整数据与原始计数在 [`docs/site-audit.md`](docs/site-audit.md)。三个结构性结论：

- 真正有缺陷的只有 4 个站（百度 logo、支付宝极小图标、高德地图控件图标、芒果弹窗素材），1.3.40 已修
- 京东 316 张商品图、淘宝 / 拼多多的商品图**不是噪声**，是页面真实内容，如实反映
- 首页只能量噪声、量不了下载能力：B 站 / 小红书 / 腾讯视频首页 `video` 全为 0，视频要点进详情页才创建播放器

### 看到这些现象别当成 bug

| 现象 | 原因 |
|---|---|
| 图片栏几十上百张（京东、淘宝、小红书） | 页面本来就有这么多图，列表如实反映 |
| 同一个视频既有 `blob:` 又有 http 直链 | 有真实直链时 `blob:` 条目会自动隐藏（1.3.41）；**没有替代品时会保留**，因为它们可能是唯一能录到数据的路径 |
| 视频条目点了失败 | 大概率是 B / C / D 类：MSE 需要登录态播放、地址已过期（刷新页面重抓）、DRM 不支持 |
| 刚打开页面时列表是空的 | 视频还没创建播放器。滚一滚、点一下播放，再点右上角 **⟳** |

---

## 能力对照

| | 这个扩展 |
|---|---|
| 嗅探范围 | 所有 http(s) 资源 + 页面内 Blob/MSE，8 类分组 |
| Telegram 类站点 | ✅ 页面内 hook 抓 Blob |
| B 站完整视频 | ✅ DASH + ffmpeg 合并 |
| 下载并发 | 16~64 可调 |
| 限速 | 无 |
| 配额 | 无 |
| 自动带 Cookie | ✅ 用 `chrome.cookies` 取当前站点 |
| 断点续传 | ✅ |
| 直播录制 | ⚠️ 只能从启动那刻起 |
| DRM 内容 | ❌ 不支持 |
| 数据外传 | 无（全本地） |

---

## 排错

**点了下载但失败：先对这三类**

| 提示 / 现象 | 是什么 | 怎么办 |
|---|---|---|
| 需要登录态播放 / 视频条目点了没反应 | B 类 MSE 站。播放地址在播放器内部，扩展只能录到**已经播过的部分** | 登录后把视频**播放一遍**再点 ⟳；B 站是特例，能直接拿完整 DASH |
| 地址过期 / 下到一半 403 | 签名直链有有效期，腾讯、爱奇艺这类只有几分钟 | 刷新页面重新抓，别复用旧链接 |
| DRM 内容（爱奇艺 / 优酷 / 芒果 / 腾讯正片） | 加密流，解密等于破解 Widevine | 不支持，也不会做 |

扩展在 `扩展` 与 `本地下载器` 之间的失败原因会显示在任务卡上（形如「失败 · 自实现 HLS: … ／ yt-dlp: … ／ 直连: …」），先看那行再说。

**扩展提示「未安装本地下载器」**

1. 跑 `python native-host\setup.py status`，看注册表写没写进去、路径对不对
2. 确认扩展 ID 是 `fofimjophfaibckjioaffoglkidppifo`
3. 换过目录 → 重新跑 `install.bat`，然后**重新加载扩展**

**下载失败，提示 Requested format is not available**

没装 ffmpeg。DASH 站点（音视频分离）必须靠它合并：

```bat
winget install Gyan.FFmpeg
```

**403 / 链接 403**

站点校验 Referer。扩展会自动把页面地址当 Referer、Cookie 也自动带；仍然 403 就去 F12 → Network 看真实请求头。

**列表一直是空的**

扩展是「装上之后才开始监听」的。点 ⟳ 重新载入页面。

**改完代码不生效 —— 这条最容易踩**

- 改 `background.js` / `popup.js` → 在 `chrome://extensions` 点扩展卡片上的刷新按钮
- 改 `inject-main.js` → **光刷新扩展不管用，必须重新加载扩展 + 刷新那个网页**。注入脚本只在页面加载时跑一次，已经开着的页面里永远是旧版本
- 改 `native-host/*.py` → 不用重装，下次调用自动生效

---

## 项目结构

```
media-sniffer/
├── extension/               扩展本体（加载这个目录）
│   ├── manifest.json        固定了 key，所以 ID 稳定
│   ├── background.js        嗅探 + 分类 + 调宿主
│   ├── session.js           会话数据契约（纯函数；把扁平条目整理成 tracks/variants/manifest）
│   ├── hls-family.js        同页多条 m3u8 归族（主清单 / 同目录第 N 个清单；不同目录树不归族）
│   ├── hls-meta.js          清单正文解析（段数 / 总时长 / 加密 / 变体，纯函数）
│   ├── naming.js            落盘文件名的规则（标题优先，纯函数）
│   ├── inject-main.js       ★ 页面主世界 hook（Blob / MSE / B 站 DASH / 小红书）
│   ├── content.js           页面 ↔ 扩展的搬运层
│   ├── popup.html/css/js    列表界面
│   └── icons/               图标（gen_icons.py 生成）
├── native-host/
│   ├── sniffer_host.py      Native Messaging 宿主
│   ├── downloader.py        独立下载进程
│   ├── library.py           统一的下载目录定位
│   ├── setup.py             安装 / 卸载 / 自检
│   ├── install.bat          双击安装
│   ├── uninstall.bat        双击卸载
│   ├── run_host.bat         宿主启动器
│   └── *.example            本机配置模板（install 时生成真实文件）
├── test/
│   ├── page.html            浏览器手动测试页（Blob / MSE）
│   ├── background.test.js   background.js 单测（266 项，另引入 focus_scope / group_key / review）
│   ├── main-hook.test.js    inject-main.js 单测（195 项）
│   ├── site_registry.test.js 站点注册表单测（103 项）
│   ├── popup_wiring.test.js popup 接线单测（60 项）
│   ├── ui_card.test.js      进度卡与阶段文案单测（39 项）
│   ├── detect.test.js       类型判定单测（30 项）
│   ├── session_model.test.js 会话数据契约单测（69 项）
│   ├── manifest_classify.test.js 清单分类与体量门槛单测（28 项）
│   ├── hls_family.test.js   清单归族单测（22 项）
│   ├── hls_meta.test.js     清单正文解析单测（55 项）
│   ├── hls_same_movie.test.js 同片清单折叠单测（32 项）
│   ├── naming.test.js       文件名规则单测（24 项）
│   ├── session_shadow.test.js S0 双跑：会话 vs 条目袋（49 项）
│   ├── native_done_history.test.js 下载完成写记录单测（16 项）
│   ├── icon_filter.test.js  图标/噪声过滤单测（20 项）
│   ├── blob_item.test.js    blob 条目取舍单测（18 项）
│   ├── range_parallel.test.js  Range 并发下载单测（14 项）
│   ├── pattern_sync.test.js 扩展与宿主的正则同步校验（4 项）
│   ├── run_js.py            JS 全量跑一次并给出可复现总数（认三种汇总格式）
│   └── *.py                 宿主侧 Python 测试（26 套；含 errcode 码表 71 项、urllib 重试 29 项、
│                             三路径收敛 44 项、任务超时 27 项、选档 28 项）
├── tools/
│   ├── fuzz_host.py         变异/性质测试（喂畸形输入找边界 bug，见下）
│   ├── live_check.mjs       真机取证（CDP 起真浏览器读扩展 storage / 渲染文案 / 下载记录 / 关 popup）
│   ├── net_dump.mjs         抓页面自己请求的清单正文（CDP Network，不受 CORS 限制）
│   ├── probe_ext.mjs        探针：扩展脚本有没有真进页面、hook 有没有发消息
│   ├── site_audit.mjs       站点覆盖度审计（34 站批量量抓取能力）
│   └── sites*.txt           审计用的站点清单
├── docs/                    截图 + 站点审计报告（site-audit.md）
├── bin/                     ffmpeg 放这里（不进仓库）
└── gen_icons.py             图标生成脚本
```

想动代码？先看 [DEVELOPMENT.md](DEVELOPMENT.md)——里面有架构图解、关键决策的理由，以及一张很长的「踩过的坑」表（分七组：进程、Range 下载与写盘、并发与缓存、页面 hook、消息与生命周期、测试桩、平台差异）。想知道某处代码为什么长这样，多半在那儿能查到。

想知道「某个问题当时是怎么查出来的、试过什么失败的」，看 [DEVLOG.md](DEVLOG.md)——按时间倒序的开发日志。开发文档里每条结论都带 `d-NNN` 编号，点过去就是完整的排查过程。

---

## 跑测试

```bash
# JS（需要 Node 18+，不需要 npm install）—— 18 套 / 1085 项
node test/background.test.js       # 290 项（含 focus_scope / group_key / review）
node test/main-hook.test.js        # 195 项
node test/site_registry.test.js    # 103 项
node test/session_model.test.js    # 69 项
node test/session_shadow.test.js   # 49 项（S0 双跑：新会话 vs 旧条目袋，只允许新增）
node test/popup_wiring.test.js     # 68 项
node test/hls_meta.test.js         # 64 项（清单解析 + 变体地址补全）
node test/ui_card.test.js          # 39 项
node test/hls_same_movie.test.js   # 32 项
node test/detect.test.js           # 30 项
node test/manifest_classify.test.js # 28 项（清单分类 + 体积门槛豁免）
node test/naming.test.js           # 24 项
node test/hls_family.test.js       # 22 项
node test/icon_filter.test.js      # 20 项
node test/blob_item.test.js        # 18 项
node test/native_done_history.test.js # 16 项
node test/range_parallel.test.js   # 14 项
node test/pattern_sync.test.js     # 4 项

# 全跑一遍并给出总数（推荐；手数容易漏，见 AGENTS.md）
python test/run_js.py

# Python（26 套，不需要 pytest，也不装任何依赖）
python test/run_all.py             # 一串跑完并汇总（没装 ffmpeg 的套件自动 SKIP）

# 或单个跑
cd test && for f in *_test.py; do python "$f"; done

# 变异测试：喂畸形输入找边界 bug（默认 3000 轮 × 4 区，约 3 秒）
python tools/fuzz_host.py
python tools/fuzz_host.py --rounds 20000 --verbose
python tools/fuzz_host.py --only hls --seed 42
```

`big_file_test.py` 是慢速大文件测试（默认不纳入 `run_all.py`），跑到 120 秒超时是预期的。

**变异测试和单元测试的分工**：`test/` 里的用例是「正常路径 + 我们真踩过的坑」，确定、快、进 CI；
`tools/fuzz_host.py` 是「大量随机/结构化畸形输入」，只断言不变量（长度、字符集、绝对地址、不崩、幂等），
不确定但能找到「没想过的情况」。它已经挖出过三条真缺陷：`sanitize` 超长扩展名返回 301 字符、
`_safe_name` 截断后留下尾随空格、带 BOM 的 m3u8 把首行当成片地址。CI 里跑固定 seed 的 2000 轮当门禁。

推送到 GitHub 时 `tests.yml` 会自动跑上面这些：JS 套件在 Node 18/20/22 上各跑一遍，
Python 在 Ubuntu + Windows 上跑（`host_merge_test.py` 等需要真 ffmpeg 的套件在没装 ffmpeg 的环境里自动跳过）。

---

## 注意

扩展申请了 `webRequest` + 全站点访问权限，Chrome 安装时会弹「可读取你在所有网站上的数据」——这是嗅探类扩展的必然代价。代码全在上面，可以自己审。

下载受版权保护的内容有法律风险，工具只是工具。
