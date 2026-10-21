# 开发日志 DEVLOG

> **这份文件记录什么**：开发过程中「遇到了什么问题 → 怎么排查 → 试过什么失败 → 最后怎么解决」。
> 按时间倒序，只增不改，条目可以啰嗦——它就是给后来的自己/别人看「当时为什么这么做」。
>
> **和 `DEVELOPMENT.md` 的分工**：那份是「**该读什么**」（架构、决策、踩坑总结，精简能查）；
> 这份是「**发生过什么**」（时间线、试错过程）。开发文档里的结论都指向这里的条目。
>
> **怎么用**：查某个功能为什么是这样写的 → 在 `DEVELOPMENT.md` 找到结论 → 点「详见 DEVLOG」跳过来看全过程。
>
> 条目编号规则：`#序号 · 日期 · 主题`，编号越大越新。锚点形如 `#d-013`。

## d-027 · 2026-10-21 · Telegram（以及所有 blob:）保存「全部失效」

**问题**：用户报「Telegram 视频和图片下载全部失效」。

**排查（先证明哪一段断了，别猜）**：

真机上逐段实测，结论是**数据一直都能拿到，只是掉进了另一个目录**：

| 路径 | 落点 | 结果 |
|---|---|---|
| `__msProbeTotal` 读 blob: | — | 72796（与 DOM 里 blob.size 一致）✅ |
| `__msRangeDownload`（Native Host） | `D:/…/文件存放处/tg-probe.mp4` | 72796 字节 ✅ |
| 宿主 `msfile_start/chunk/end` 手打一遍 | 同上 | 3 步全 `ok:true` ✅ |
| 浮层「保存到本地」→ `doSaveBlob` → `<a download>` | `C:/Users/l/Downloads/test-tg.jfif` | 72796 字节 ⚠️ |

- 宿主链路、blob 读取、探针全部正常，所以不是「下载器挂了」。
- 走 `<a download>` 那条把文件丢进 **Chrome 默认下载目录**，扩展名还被 MIME 改写成 `.jfif`。用户在插件配的「文件存放处」里看不到任何东西 → 主观感受就是「下载全部失效」。
- 顺带发现第二个坑：改走 Native Host 后文件名叫 `真机测试图.mp4`，但十六进制是 `ffd8ffe0`（JPEG）。根因是 `sniffExt` 只认音视频魔数、`guessExtFromType` 只认 `audio/*` `video/*`，两个都没命中就兜到写死的 `".mp4"`。

**解决**：

1. `extension/inject-main.js` 的 `runSave` 里，`blob:` 分支从 `doSaveBlob(key, name)` 改成 `startMediaDownload(it.key, it.name, {}, () => {})` —— 统一走 Range + Native Host，落到插件配置的目录、文件名由内容嗅探决定。
2. `sniffExt` 补图片魔数（JPEG `ffd8ff` / PNG / GIF / WEBP / BMP）。
3. `guessExtFromType` 补 `IMG_MIME_EXT` 表（jpeg/png/gif/webp/bmp/avif/svg/heic），并先按 `;` 切掉 charset。
4. 两处 `|| ".mp4"` 兜底改成 `|| ""` —— 认不出来时宁可没扩展名，也别把 JPEG 存成 mp4。

**验证**：

- 真机（重载扩展 + 刷新 Telegram）：浮层显示 `完成 · D:\软件应用\DSH\文件存放处\真机复验图_99398.jpg（71.1 KB，1s）`，落盘 72796 字节，魔数 `ffd8ffe0` ✅
- `test/site_registry.test.js` 新增 `[BLOB]` 7 项 + `[EXT]` 10 项，全套 89 项全绿。

**教训**：

- 「下载失败」要先分辨是**没下到**还是**下到了别处**。这次是后者，因为 `<a download>` 的文件去向完全不受扩展控制。
- 在页面里下东西，只有两条路：`<a download>`（去浏览器下载目录，扩展管不着）和 Native Messaging（去插件配置的目录）。凡是用户要求「保存到我的目录」，就必须走后者。
- 扩展名永远按**字节魔数**定，别信键名也别信调用方给的 MIME —— 兜底值写死成某个具体格式，一定会在别的格式上翻车。

## d-026 · 2026-10-21 · B 站视频页图片只留封面

**问题**：用户报 B 站视频页图片栏混进 banner / 活动图 / 推荐位封面。真机 `BV1Este6wExx` 的 state 里 33 条 `k:"image"`，只有 1 条是 `hint:"bili-cover"`。

**排查**：

- 页面侧 `isImageOnly` 实测**是生效的**：视频页 45 个 `<img>`，逐个调 `site.isImageOnly()`，通过数 **0**。所以 DOM 扫描这条通路没问题。
- 那 33 条**全部来自 webRequest**（`chrome.webRequest.onHeadersReceived` → `record()`），根本不经过页面，页面侧钩子管不到。
- 顺手发现第二个洞：`onScanImages` / `isImageOnly` 都用 `biliPlayinfo()`（有没有 `__playinfo__`）当「是不是视频页」。这个判据有两处会错：
  1. `__playinfo__` 是首页 JS 异步写入的，首屏几百毫秒里是 `undefined` —— 这段时间页面被判成「非视频页」→ 全放行；
  2. 番剧/课程页的播放清单根本不在 `__playinfo__`（在 `__INITIAL_STATE__.epInfo`）→ 这类页面**永远**判成非视频页，等于完全没有过滤。

**试过但没采用**：往 `isSiteUiAsset` 里继续加 URL 黑名单（`/bfs/banner/`、`/bfs/face/`、`loading-blue.gif`…）。不行——素材路径随改版换，而且用户真正想要的封面和推荐位封面在同一个 `/bfs/archive/` 目录下，只能靠「是不是这一集的封面」区分，靠 URL 区分不出来。

**解决方案**：

1. `extension/inject-main.js` 新增 `biliIsVideoPage()`，**只看 URL**（同步可读、不会闪）：`/video/(BV…|av…)`、`/(bangumi|cheese)/play/(ep|ss)…`。`onScanImages` 和 `isImageOnly` 都改用它。
2. `isImageOnly` 在「视频页但拿不到封面」时由 `return true`（放行）改成 `return false`（一张都不报）——放行的话 banner 会进 state，进去就清不掉了。
3. `extension/background.js` 新增 `preferBiliCover(items, tabUrl)`，在 `sniff:get` 里接在 `dedupeImagesByIdentity` 之后：视频页只留 `hint === "bili-cover"` 的图片，视频/音频条目不受影响；非视频页原样返回。这同时覆盖了 webRequest 那条通路。

**真机证据（1.3.24）**：

| 页面 | 改前 | 改后 |
|---|---|---|
| `/video/BV1Este6wExx`（视频页） | `image: 33` | **`image: 1`**（就是 bili-cover） |
| 首页 `/`（对照） | — | `image: 49`（**不被误筛**） |

**教训**：

- 一个站点可能有**两条互不相干**的发现通路（DOM 扫描 / webRequest），在一条上做过滤，另一条完全不受影响。修之前先问「这个条目是从哪条路进来的」。
- 拿「异步写入的全局变量存不存在」当页面类型判据很脆：首屏会闪，SPA 会滞留。页面类型要看 **URL**，内容要看 **state**，两件事分开。
- 过滤原则要一致：**宁可这一轮空，也不要把噪声放进 state**。进了 state 的条目，之后规则改严也清不掉（见 d-025）。

**涉及文件**：`extension/inject-main.js`（`biliIsVideoPage`、站点对象 `onScanImages`/`isImageOnly`）、`extension/background.js`（`preferBiliCover` + `sniff:get` 接线）、`test/site_registry.test.js`（[B10] 10 项 + [B10b] 10 项）。

---

## d-025 · 2026-10-21 · Telegram 陈旧封面条目清不掉

**问题**：1.3.21 已给 telegram 站点对象加了 `isDecorImg` 钩子，页面上下文调用确实返回 `true`，但列表里仍有 15 条 `media-preview--image` 封面。

**排查**：

- 在页面里对真实元素调 `site.isDecorImg(el, el.src)` → `true`，钩子本身没问题。
- 直接读 background 的 state：`imgs: 26`，其中 `media-preview` 命中 **15** 条。
- 关键：过滤只在**入口**（`scanImages` 的 `continue`）。Telegram 的封面是 `blob:` URL，页面每次刷新/重渲染都换一个地址 —— 新扫描挡掉的是**新地址**，而 state 里那批**旧地址**的条目没有人删，就一直留在列表里。

**解决方案**：`extension/background.js` 新增 `pruneStaleImages(rec)`，在 `sniff:get` 取快照**之前**按当前规则重算一遍，返回清掉的条数（>0 就 `flushSoon`）。只动 `k === "image"`，清三类：

1. 非白名单站点的 `hint` 含 `cover`；
2. `TG_COVER_HINT = /media-preview--image|media-preview\b/i`（Telegram 左栏列表预览）；
3. `TG_THUMB_HINT = /(?:^|\s)thumbnail(?:\s|$)/i` 且 URL 在 `web.telegram.org`（消息内封面）。

视频/音频一律不碰——它们不参与这套判定，误删代价远大于收益。

**真机证据（1.3.22）**：`image` 26 → **10**；`media-preview--image` 15 → **0**；`thumbnail` → **0**；剩 8 条 `full-media` 真照片。

**教训**：

- **过滤只在入口做是不够的。** 规则后来变严、或页面用一次性地址（`blob:`）时，已经进 state 的条目永远清不掉。需要一轮「按当前判定重算并清理」。
- 第一版红测是**假绿**：用 150×150 的假条目测 `looksLikeIcon`，它本来就撞上「方形小图→图标」规则返回 `true`，压根没测到新逻辑。是从真机 DOM 拿到「video + img 同容器」「`.media-preview` 配 `.icon-play`」两个特征后重写测试，才是真红测。

**涉及文件**：`extension/background.js`（`pruneStaleImages` + `sniff:get` 接线）、`test/site_registry.test.js`（[TGS] 7 项）。

---

---

## 索引

| # | 日期 | 主题 | 一句话结果 |
|---|---|---|---|
| [d-026](#d-026) | 2026-10-21 | B 站视频页图片只留封面 | 视频页判定改看 URL（`__playinfo__` 首屏为空、番剧页永远为空）；banner 全走 webRequest，得在 background 补一层 |
| [d-025](#d-025) | 2026-10-21 | Telegram 陈旧封面条目清不掉 | 过滤只做在入口不够：blob 地址每轮换，旧条目只能靠 `pruneStaleImages` 按当前规则重算 |
| [d-024](#d-024) | 2026-10-20 | 视频封面默认不当图片收 | 做成一张站点白名单表；小红书封面单独打 xhs-cover 才分得开 |
| [d-023](#d-023) | 2026-10-20 | 真机复测：编号跨消息错位 + 焦点上报永久失效 | ord 语义是「消息内」的，加 mid 层；焦点补发；同组编号压过 kind |
| [d-022](#d-022) | 2026-10-20 | 焦点收窄 + 编号对不上内容 | 编号挪到所有滤网之后；新增 focus() 钩子，Telegram 查看器只显示那条 |
| [d-021](#d-021) | 2026-10-20 | Telegram 同标题不聚拢 / 编号断裂 / blob 不能预览 | 分组键从「消息 id」改成「标题」，排序判据同步；预览门槛放开 blob |
| [d-020](#d-020) | 2026-10-20 | 只读审查报告落地：tabId=0 / 素材漏判 / SPA 迟到消息 | 先补 24 项红测再修，抓取诊断上浮到 popup |
| [d-019](#d-019) | 2026-10-19 | A2：B 站图片只留当前视频封面 | state 取封面 + isImageOnly 过滤，测试桩 FakeURL 教训 |
| [d-018](#d-018) | 2026-10-19 | 复查 1.3.11：noteId 闸从未生效 | blob/MSE 上报统一补 noteId 让闸可达，另修 4 处提示链路 |
| [d-017](#d-017) | 2026-10-19 | 「一个功能好了另一个就失效」的机制追问 | 拆掉 4 处下载层站点泄漏 + 修 2 个 tab 级共享状态 |
| [d-016](#d-016) | 2026-10-19 | B 站视频条目没标题（「完整 DASH 流」占位文案） | `biliTitle()` 改成 `__INITIAL_STATE__` 优先，空标题不再伪造站名 |
| [d-015](#d-015) | 2026-10-19 | A1 首页信息流封面不加序号 | 「有标题」不等于「该编号」，信息流每张各自独立 |
| [d-014](#d-014) | 2026-10-19 | A0 功能模块化：抽出站点注册表 | 通用层站点 if 归零，新增架构测试 |
| [d-013](#d-013) | 2026-10-18 | 小红书：视频抓不到 / 没标题 / 编号错乱 | 完整 mp4 优先于 m4s，blob 不再上报 |
| [d-012](#d-012) | 2026-10-18 | 小红书：图片无法预览 / 封面重复 / 列表噪声 | 补预览按钮，改读 imageList |
| [d-011](#d-011) | 2026-10-18 | 小红书：评论图 / 视频 / 标题 | 双判据拦评论图，state 里取真实 mp4 |
| [d-010](#d-010) | 2026-10-18 | 小红书：别人帖子的图混进来 | 三路信号判归属 |
| [d-009](#d-009) | 2026-10-18 | 用户提的六条问题（总览） | 1/2/4 完成，3/5 待定 |
| [d-008](#d-008) | 2026-10-18 | B 站视频名不显示 | 标题五个落点统一 |
| [d-007](#d-007) | 2026-10-18 | 提升广覆盖：三项低风险改动 | onResponseStarted + 体积门槛 + 通用去重 |
| [d-006](#d-006) | 2026-10-18 | 小红书点开笔记抓不到视频 / 保存卡住 | fetch 加超时保护 |
| [d-005](#d-005) | 2026-10-18 | 小红书只显示当前帖子的图 | 详情页按 noteId 过滤 |
| [d-004](#d-004) | 2026-10-18 | 图片和图标混用（历史遗留） | 多轮收紧，最终靠站点判据 |
| [d-003](#d-003) | 2026-10-18 | 改动不生效 / 页面没刷新 | 分三类文件各自的重载方式 |
| [d-002](#d-002) | 2026-10-18 | 全量测试与 CI | 手机号编码、flaky 修复 |
| [d-001](#d-001) | 2026-10-18 | 仓库初始化与上传 GitHub | ffmpeg 不进仓库，历史清理 |

---

<a id="d-024"></a>
## #d-024 · 2026-10-20 · 视频封面默认不当图片收（改成一张站点白名单表）

> 用户 m15108 原话：「改为默认情况下，不会获取视频封面作为一张图片，有需要再做
> 特殊处理，代码里留有改动的余地。目前来看只获取 B 站、小红书视频封面当作一张图片」

### 一、问题：封面确实是 image，但有两条不同的出路

先在代码里确认了「封面被当图片」的两个位置，都是**有意写的**、不是漏判：

| 位置 | 代码 | 为什么当初这么写 |
|---|---|---|
| 小红书视频帖 | `scanXhsNoteImages()` 读 `imageList`（视频帖只有一条 = 封面），`mime: "image/*"` | 封面占 ②、视频占 ①，用户能拿到视频预览图 |
| B 站视频页 | `onScanImages` 直接 `post({mime:"image/*", hint:"bili-cover"})` | A2 需求：「B 站图片只取所点开视频的封面」 |

所以不能简单删掉任何一处，得先有「默认 vs 例外」的层次。

### 二、方案：白名单表 + 一个判据函数

新增（放在图标判定区，这样测试能把它单独抽出来跑）：

```js
const VIDEO_COVER_SITES = ["bilibili.com", "xiaohongshu.com"];

function coverAllowed(host) {
  const h = "." + String(host || "").trim().toLowerCase().replace(/^\.+/, "") + ".";
  if (h === "..") return false;
  return VIDEO_COVER_SITES.some((site) => h.endsWith("." + site.toLowerCase() + "."));
}
```

**左右都补 `.` 再 `endsWith`** 是关键：不这样的话 `fakebilibili.com` 和
`bilibili.com.evil.net` 都会命中。子域（`www.` / `m.` / `space.`）自动跟随。

「留有改动余地」就落在这张表上：加站点往数组里塞一个域名，去站点删一个，
数组清空 = 全网都不收封面。

### 三、过滤落点为什么不在 record()

第一版想把判据塞进 `record()`，但那里拿到的 `d.tabUrl` 是请求发起时的地址；
小红书是 SPA，从信息流点进帖子**不触发 main_frame**，`rec.url` 还停在上一页。
`sniff:get` 里有一段专门为此做的修正（`chrome.tabs.get` 拿真实地址），
所以过滤必须放到 `visible` 那一步：

```js
const curHost = hostOfUrl(tabUrl);
const coverOK = coverAllowed(curHost);
const visible = items.filter((it) => it.k !== "icon"
  && !(!coverOK && String(it.hint || "").indexOf("cover") >= 0));
```

用 `indexOf("cover")` 而不是逐个枚举 hint：以后再加 `xxx-cover` 不用回来改这里。

### 四、踩到的真问题：hint 分不开封面和正文图

小红书视频帖的封面原来打的也是 `hint: "xhs-note"`——和正文图**一模一样**。
只靠 hint 根本区分不出来，要么误删正文图，要么放过封面。

改法：`scanXhsNoteImages()` 里按 `xhsNoteType() === "video"` 分开：

```js
const isVideoNote = xhsNoteType() === "video";
const hint = isVideoNote ? "xhs-cover" : "xhs-note";
```

图文帖的正文图仍然是 `xhs-note`，不受影响。

### 五、连带要改的三处（不改就会静默退化）

`xhs-cover` 是新 hint，凡是「按 hint 认直读条目」的地方都要跟上，否则视频帖会被
判成「没直读过」而退回全量噪声：

1. `renumberImages` 的 `const real = ...`（决定要不要编号）
2. `numberShown` 的同名判据
3. `preferXhsNoteList` 的 `direct` 筛选 —— 这条最隐蔽，它一漏，
   `preferXhsNoteList` 就认为「页面没报过」，把整份 `items` 原样返回。

### 六、真机验证

| 验证项 | 结果 |
|---|---|
| 后台真的换上新代码 | `chrome.runtime.getManifest().version === "1.3.20"` |
| 白名单内容 | `["bilibili.com","xiaohongshu.com"]` |
| 三站判定 | `xhs=true bili=true other=false` |
| 过滤模拟（`example.com`） | `kept = ["xhs-note","none"]` ← 两条 cover 被滤 |
| 过滤模拟（`xiaohongshu.com`） | `kept = ["bili-cover","xhs-cover","xhs-note","none"]` ← 全留 |
| 图文帖不误伤（真实页面 6ad49c1c） | `counts={image:1}`，正文图正常 |

### 七、教训

1. **「默认」要写成一张能一眼看完的表**，而不是散在 if 里的若干特例。
   用户要的就是「以后好改」，那变量名和注释就得承担这个职责。
2. **同一个 hint 值不能同时表示两件事。** `xhs-note` 既当「正文图」又当「封面」，
   一旦要区别对待就无解；先拆 hint 再谈过滤。
3. **新增一个 hint 值，要回头搜它所有使用点。** 本次漏改 `preferXhsNoteList`
   不会报错、测试也可能照绿，只是静默退回噪声——这类「不报错的退化」最难查。

### 八、涉及文件

- `extension/background.js` — `VIDEO_COVER_SITES` / `coverAllowed` / `hostOfUrl`；
  `sniff:get` 的 `visible` 过滤；`renumberImages`、`numberShown`、`preferXhsNoteList` 三处 hint 判据
- `extension/inject-main.js` — `scanXhsNoteImages()` 按 `note.type` 打 `xhs-cover`
- `test/background.test.js` — `[COVER]` 7 项；顺带把纯逻辑切片终点从 `indexOf("---- 监听")`
  改成「监听之前最后一次分节线」，否则切不到小红书规则块

---

<a id="d-023"></a>
## #d-023 · 2026-10-20 · 真机复测：编号跨消息错位 + 查看器焦点上报一次丢掉永久失效

> 用户 m14306 原话：「两个问题依旧存在，为什么不在真机上验证？」
> 用户 m14493 原话：「两个都按上述方案改，等修」
>
> 这一条是**给 d-022 打补丁**：d-022 的自动化测试全绿、也提交了，但两件事在真机上
> 依旧复现。教训见文末「教训 1」——只做到「自动化测试通过」就说完成，是要返工的。

### 一、问题①「编号对不上内容」的真正根因：跨消息的 ord 互相干扰

真机 dump（频道 ONE PIECE / General，标题「编号：#CC0385」）拿到的事实：

| mid | 条目 | 关键字段 |
|---|---|---|
| 7497 | 1 张图 | `ord=0` |
| 7498 | 5 图 + 7 视频 | `ord=0..9`；其中 1 条 `ref:"viewer"` 的 `ord` **也是 0** |
| 7508 | 1 张图 | `ord=0` |

`ord` 的语义是「**消息内部**的第几个」，每条消息都从 0 重新开始。而分组键对
「有标题」的条目用 `"t:" + title`（跨消息合组，这是 d-021 按用户要求改的），
于是三条消息的 `ord=0` 全撞在一起。组内排序原来只比 `ord`：

```js
const oa = typeof a.ord === "number" && a.ord >= 0 ? a.ord : 1e6;
const ob = typeof b.ord === "number" && b.ord >= 0 ? b.ord : 1e6;
if (oa !== ob) return oa - ob;
return (a.t || 0) - (b.t || 0);   // 平局只能退到抓取时间 = 随机
```

平局退到 `t`（异步到达的抓取时间），等于随机 → 真机看到 `①⑥②③④⑤` 这种跳号。

**修法**：抽出 `compareWithinGroup(a, b)`，加一层 **mid 数值升序**：

```js
function compareWithinGroup(a, b) {
  const ma = Number(a.mid), mb = Number(b.mid);
  const aHasMid = (a.mid != null && a.mid !== "" && Number.isFinite(ma));
  const bHasMid = (b.mid != null && b.mid !== "" && Number.isFinite(mb));
  if (aHasMid && bHasMid && ma !== mb) return ma - mb;
  if (aHasMid !== bHasMid) return aHasMid ? -1 : 1;
  const oa = typeof a.ord === "number" && a.ord >= 0 ? a.ord : 1e6;
  const ob = typeof b.ord === "number" && b.ord >= 0 ? b.ord : 1e6;
  if (oa !== ob) return oa - ob;
  return (a.t || 0) - (b.t || 0);
}
```

`renumberImages` 与 `numberShown` 两处**原本各写了一份一模一样的 sort**，这次合并成一个函数，
以后不会再改歪一处漏一处。无 mid 的条目（普通网站、小红书正文图）退回纯 ord，不受影响。

### 二、问题①的最后一环：popup 先按 kind 切，把序号顺序打烂了

background 已经按「mid 升序 → 组内 ord」编好 ①~⑳，但 popup 的 `visibleItems()` 第一行是：

```js
const order = ["video", "audio", "doc", "image", "font", "other", "seg"];
if (ka !== kb) return ka - kb;    // ← 所有 video 提到所有 image 前面
```

真机实测拿到的 20 条是 `②④⑥⑧…（video 在前）+ ①③⑤⑦…（image 在后）`——
典型的「编号和内容对不上」。**序号本来就是阅读顺序，kind 只能当兜底**，不能反过来压过它。

修法：把「同组判定」提成 `sameGroup(a, b)`，同组且都编号时 **idx 直接压过 kind**：

```js
if (sameGroup(a, b) && (a.idx || 0) && (b.idx || 0)) return a.idx - b.idx;
const ka = order.indexOf(a.k), kb = order.indexOf(b.k);
if (ka !== kb) return ka - kb;
```

不同组之间仍然按 kind 分块（这条规则保留，测试锁了）。

### 三、问题②「只看当前打开的那一条」：查看器 DOM 根本没有消息标识

真机实测（Telegram Web A 版），`#MediaViewer` 打开后的上溯链：

```
.MediaViewerSlide--active → .MediaViewerSlides → DIALOG#MediaViewer
  → div.opacity-transition → div.Transition → BODY
```

**全链没有任何 `data-message-id` / `data-peer-id` / `data-media-id`**；
`.message.highlighted` / `.selected` 也是空的（TG 的「跳转到该消息」用滚动定位，不加类）。
所以 d-022 里那两条「容器自己带消息号」「媒体元素往上找」在真机上**必然返回空**。

唯一还能对上的是**媒体地址本身**：查看器里的
`<video src="https://web.telegram.org/a/progressive/document4999508637404...">`
与聊天里那条消息里的同一个地址（`blob:` 地址在同一页面里也是同一个字符串）。

新增 `tgFocusByMedia()`（方案 B）：

1. `document.querySelectorAll(".MediaViewerSlide--active")` 取**当前展示那一页**
   （所有 slide 都渲染了，不挑 `--active` 会拿到邻张）；
2. 取它的 `img/video` 的 `currentSrc || src`；
3. 去 `[data-message-id] img, [data-message-id] video` 里找同地址的元素；
4. 上溯 ≤22 层取 `data-message-id`。

拿不到就返回 `""`（不收窄，显示全量）——**宁可多显示，也不猜一个错的**。

### 四、问题②的隐蔽缺陷：一次上报丢掉 = 永久失效

`reportFocus()` 原来只在**值变化**时发：

```js
if (id === lastFocus) return;
lastFocus = id;
post({ cmd: "focus", kind: id ? "mid" : "", id });
```

真机踩到的现象：查看器刚打开那一瞬间 `post` 发出去了，但 service worker 正在启动
（或 tab 记录还没建），后台没收到；可 `lastFocus` 已经被设成 `"7498"`，
之后每一轮都「没变化」直接 return —— **用户看到「明明打开了查看器，列表还是全量」，
而且无论怎么等都不会自己好**。

修法：加 `FOCUS_RESEND_MS = 5000`，没变化也每 5 秒补发一次，让后台最终一致。
补发只是一条几十字节的消息，代价可以忽略。修完真机立刻从 186 条收窄到 20 条。

### 五、真机验证结果（这是本轮唯一算数的证据）

```
{"tabId":54120535,"focus":{"kind":"mid","id":"7498"},
 "total":20,"counts":{"video":10,"image":10}}
```

popup 实际渲染出的 20 行（`#list` 的 innerText）：

```
▣① ▣③ ▶② ▶④ ▣⑤ ▶⑥ ▣⑦ ▶⑧ ▣⑨ ▶⑩ ▣⑪ ▶⑫ ▣⑬ ▶⑭ ▣⑮ ▶⑯ ▣⑰ ▶⑱ ▣⑲ ▶⑳
```

按 idx 排后连续 ①→⑳ 无跳号，图片/视频按真实阅读顺序交错，全部是「消息 7498」。

### 六、测试

- `test/group_key.test.js` 新增 `[G1b]` 4 项（跨 mid 升序、编号连续、viewer/album 互不干扰、无 mid 仍按 ord）；
- `[G4]` 新增 2 项（同组编号压过 kind、不同组仍按 kind）；
- `test/focus_scope.test.js` 新增 6 项（tgFocusByMedia 存在、比对 currentSrc、tgFocus 兜底调用、只取 --active、FOCUS_RESEND_MS、按间隔补发）。
- 结果：JS **504 → 517 项**全过（background 217 / detect 30 / main-hook 183 / pattern_sync 4 / popup_wiring 21 / range_parallel 14 / site_registry 39），Python **8/8**。

### 七、教训

1. **「自动化测试通过」不等于「做完了」。** d-022 全绿就提交，真机一测两个问题都在。
   凡是用户能在界面上看见的行为，都必须真机点过再交（AGENTS.md 第 4 节七级状态表）。
2. **测试断言写错了会假装通过。** 本轮 `[G1b]` 第一版按**数组原始顺序**取 mark，
   而 `numberShown` 只原地写 `idx/mark`、不重排数组（重排是 popup 的事），
   于是「编号连续」这条假绿、顺序那条真红。改成「按 idx 排一遍再断言」才对。
3. **真机数据比推理可靠。** 「三个 ord=0 并列」是 dump 出来的事实，不是猜的；
   也正因为 dump，才发现 viewer 那条和 album 的 ord 各自从 0 数、根本没法互相对齐。
4. **一个「只在变化时发」的同步机制，必须有自愈路径。** 否则任何一次丢包都会变成永久故障。

### 八、涉及文件

- `extension/background.js` — 新增 `compareWithinGroup()`，`renumberImages` / `numberShown` 共用
- `extension/inject-main.js` — 新增 `tgMediaKey()` / `tgFocusByMedia()`，`reportFocus()` 加周期性补发
- `extension/popup.js` — `visibleItems()` 的「同组编号压过 kind」
- `test/group_key.test.js` — `[G1b]` 4 项 + `[G4]` 2 项
- `test/focus_scope.test.js` — `[F2]` 6 项

---

<a id="d-022"></a>
## #d-022 · 2026-10-20 · 焦点收窄（只看当前打开的那一条）+ 编号对不上内容

> 用户 m13863 原话：「像这种一个消息包含多个图片或者视频，当我点开其中任意一个时，
> 列表只会出现该标题下的所有内容而不包含其他消息里的，这个功能实现了吗」
>
> 用户 m13975 原话：「上次改动，同标题的编号没有聚在一起，而且序号和内容对不上，
> 甚至超出了内容数量。一并改了」

### 一、两个问题其实是同一个

「编号对不上内容」不是分组键写错了（d-021 刚修过），而是**编号的时机错了**。

#### 现象

- 6 条内容里出现 ⑨；
- 真图从 ③ 直接跳到 ⑥；
- 序号总数超过列表条数。

#### 根因（代码事实）

`extension/background.js` 的 `renumberImages(rec)` 在 `sniff:get` 开头对**整份
`rec.items`** 编号，然后才轮到后面两道滤网：

```js
const visible = items.filter((it) => it.k !== "icon");   // 第一道：去图标
const shown = dedupeXhsNoteImages(...) / dedupeImagesByIdentity(...);  // 第二道：去重
```

被这两道剔掉的条目**序号照样发出去了** —— 编号池里躺着 9 个成员，用户只看到 6 个，
于是出现 ⑨、跳号、对不上。

#### 解决

把「编不编、编第几号」这件事挪到**所有滤网之后**：

1. `renumberImages(rec)` 只做分组计算，**不再写 `idx/mark`**（保留 `lastGroups` 备用）；
2. 新增 `numberDisplayed(groups)` / `numberShown(items, tabUrl)`，在**最终要显示的数组**上编号；
3. `sniff:get` 里的顺序改成
   `renumberImages → visible → shown → applyFocusFilter → numberShown`，
   并在注释里写死「编号必须在所有滤网之后做」；
4. **没进任何组的条目显式 `it.idx = 0; it.mark = ""`** —— 否则会留着上一轮的旧 mark
   （条目对象是复用的，这点很容易漏）。

### 二、焦点收窄：让 Telegram 也能「只看这条」

#### 为什么小红书和 B 站不需要额外做

两站的详情页 URL 里就带着 id（noteId / bvid），页面扫描天然只报当前那一帖。
`extension/inject-main.js` 的 `owns` 钩子已经把这个范围锁死了（d-010 / d-019）。

Telegram 不一样：地址永远是频道地址（`/a/#-100…`），点开任何一条消息都不变地址，
所以必须去 DOM 里反查「现在打开的是哪条」。

#### 做法：统一 `focus()` 钩子

沿用 d-014 的站点注册表，加第九个钩子：

| 站点 | `focus()` 返回 |
|---|---|
| 小红书 | `""`（URL 层已收窄） |
| B 站 | `""`（URL 层已收窄） |
| Telegram | `tgFocus()`：查看器容器上的 `data-message-id`，拿不到就上溯 ≤22 层找 |

链路：

```
inject-main.js  scanMedia() 开头 → reportFocus()
                  ↓ 变化才发
                post({cmd:"focus", kind:"mid", id})
                  ↓
background.js   ms:page 的 p.cmd === "focus" 分支 → cur.focus = {kind, id}
                  ↓ 只放内存，不落 storage（瞬时的界面状态）
sniff:get       applyFocusFilter(shown, rec.focus)  → 命中为空则原样返回（防误清空）
                  ↓
popup.js        res.focus 非空 → 显示 #focusBar 提示条 + 「显示全部」
```

#### 反向操作也要有出口

`#focusExit` 发 `ms:page-forget-focus`，background 里 `delete rec.focus`。
必须给这个出口，否则用户会以为「别的图片丢了」。

### 三、踩过的坑

1. **测试断言 `name: "xxx"[\s\S]{0,600}?focus:` 的窗口**：focus 一开始写在站点对象
   末尾，距 `name:` 有 1441（小红书）/ 2175（B 站）字符，超出窗口 → 测试红。
   改成紧跟 `match` 之后即绿。**这也说明钩子顺序有语义：先 match，再 focus。**
2. **`numberShown` 的 docblock 被 `edit` 吃掉开头**：留下孤立的 ` * 与 renumberImages 共用…`，
   `node --check` 直接报错。补回后通过。
3. **测试全部要改调用点**：`renumberImages` 不再写 mark，`test/background.test.js` 里
   12 处 `renumberImages(recN)` 与 `test/group_key.test.js` 的 `runRenum` 都必须改成走
   `numberShown` —— 因为测试要验的是「用户看到的序号」。

### 四、教训

- **「算法对了」不等于「输出对了」**：分组键从 d-021 起就是对的，错在它在错误的时机被调用。
  遇到「数字对不上」，先把数据通路的**顺序**画出来，再怀疑算法。
- **复用对象要显式清字段**：`it` 是复用对象，这一轮没分组就必须主动把上一轮的 `mark` 清掉。
- **给用户看得见的收窄，就必须给看得见的恢复**。

### 五、涉及文件

- `extension/background.js`：`renumberImages` 瘦身、新增 `numberDisplayed` / `numberShown` /
  `applyFocusFilter`、`sniff:get` 顺序调整与 `focus` 响应字段、`ms:page` 的 `focus` 分支、
  新增 `ms:page-forget-focus`。
- `extension/inject-main.js`：新增 `tgFocus()` / `reportFocus()`、三个站点对象的 `focus()`
  （小红书、B 站放 `match` 之后）、Telegram 站点对象。
- `extension/popup.js` / `popup.html` / `popup.css`：`focusInfo` 状态、`renderFocusBar()`、
  `exitFocus()`、`#focusBar` / `#focusText` / `#focusExit` 与其样式。
- `test/focus_scope.test.js`（新增，17 项）、`test/background.test.js`、`test/group_key.test.js`。
- `extension/manifest.json`：1.3.16 → 1.3.17。

### 六、测试

| 套件 | 项数 |
|---|---|
| background（含 review / group_key / focus_scope） | 205 |
| detect | 30 |
| main-hook | 183 |
| pattern_sync | 4 |
| popup_wiring | 21 |
| range_parallel | 14 |
| site_registry | 39 |
| **JS 合计** | **496** |
| Python | 8 / 8 PASS |

状态：**自动化测试通过**（未真机）。真机验证需要重载扩展 + 刷新 Telegram 页面。

---

<a id="d-021"></a>
## #d-021 · 2026-10-20 · Telegram 同标题媒体不聚拢 / 编号断裂 / blob 图片不能预览

> 用户 m13684 原话：「Telegram 功能基本实现了，只是有几个bug，1.把相同标题的视频或图片放在一起，
> 如图一图二所示，其他网站有没有同样问题；图三，为什么第一个没有编号 2 图四，为什么不能预览
> 3.是否能加一个功能，即点击视频或图片就会跳转到该图片或视频所在网页中的位置。先做前两个，
> 第三个我们讨论一下，记得存档，以后是否可以开分支做更改，测试通过后再合并」

### 问题

三张真机截图，三个不同现象：

1. **图一 / 图二**：列表里「身材不错编号 2026253」「真他么大啊编号 20262481」「鱼哥又吃嫩货了…」
   这些**同标题**的条目散落在列表不同位置，各自带 ①②，没有聚在一起。
2. **图三**：最上面一条是 `⑪ 医美工作室流出…编号 20262436`（消息 3161，72×72），
   紧下面却是 `② 页面图片 175×320` 和 `① 医美工作室流出…编号 20262436`（消息 3171）。
   用户问「为什么第一个没有编号」——其实它有编号，只是**编号 ⑪ 出现在 ① 上面**，看着像乱掉。
3. **图四**：Telegram 的图片条目**只有「保存」按钮，没有「预览」**。

### 排查

**先看分组键**（`extension/background.js` 的 `renumberImages`）：

```js
const gk = it.k + "|" + (it.mid ? "m:" + it.mid : "t:" + (it.title || "")) + "|" + (it.ref || "");
```

**代码事实**：分组键里 `mid` 优先于 `title`。Telegram 同一条频道的同标题媒体，是**分成好几条消息**
发的（消息 3197 / 3202 / 3218 / 3219 各不相同），`mid` 一不同就各自成组、各自编 ①。
再叠加 `ref`（`album` / `viewer`）——同一条消息里横排的相册还会再被拆一次。

**再看排序**（`extension/popup.js` 的 `visibleItems`）：

```js
const ma = a.mid || "", mb = b.mid || "";
if (ma === mb && (a.idx || 0) && (b.idx || 0)) return a.idx - b.idx;
```

只在 `mid` 相同时才按序号排。所以即使编号是对的，**跨消息的同标题条目也不会挨在一起**，
它们掉到后面按体积/时间排——这正是图三「⑪ 在 ① 上面」的成因。

**再看预览门槛**（`extension/popup.js` 的 `renderItem`）：

```js
if (["image", "video", "audio"].includes(it.k) && /^https?:/i.test(it.u || "")) { … }
```

Telegram 页面的 `<img>` / `<video>` 的 src 是 `blob:https://web.telegram.org/…`，
`/^https?:/` 直接判假 → **预览按钮根本没生成**（不是点了失败，是压根没有）。

> 「其他网站有没有同样问题」的答案：**有**。分组键是全局的，所有站点都走它。
> 只是 Telegram 会额外产生 `album` / `viewer` 两种 `ref`，拆得最碎、最先暴露；
> 其它站点 `ref` 通常为空，表现为「同标题但不同消息被拆成多个 ①」。

### 解决方案

三处都改，缺一不可（只改分组键，排序还会把它们拆开）：

1. **分组键改成标题优先**（`extension/background.js`）：
   有标题就用 `"t:" + title`，**跨消息、跨 ref、跨 kind 全部并到一组**；
   没标题才退回原来的 `kind + mid + ref`。小红书详情页仍走 `"xhs"` 单池，首页 feed 仍整段跳过，
   两条旧规则都在上面的 `continue` 里，不受影响。
2. **排序判据同步**（`extension/popup.js` 的 `visibleItems`）：
   「两都有标题且相同 → 按 idx 排；都无标题 → 退回比 mid」。这样同标题跨消息的成员
   会按 ①②③… 连续排在相邻位置。
3. **抽出 `canPreviewSrc(it)`**（`extension/popup.js`）：
   只排除 MSE 合成条目（`u` 形如 `m1`/`m2`，不是真 URL）和非媒体类型，
   `http/https/blob/data` 一律放行。画不出来时预览框自己会显示「预览加载失败」，
   比没有按钮更容易理解。

### 试过但失败的

- **只改分组键就收工**：跑测试 `[G4] 同标题跨 mid 时按序号排` 直接红（`"⑪①②"`），
  证实排序判据不改，编号再对也排不到一起。这条是写测试时「顺手多写一条」才发现的，
  **不是靠读代码想出来的**。
- **第一版测试桩按行 `split("\n")` 抽 `const CIRCLE`**：`CIRCLE` 是跨两行的数组
  （`:792-793`），只截到第一行 → `SyntaxError: Unexpected token 'const'`。
  改成按 `indexOf("const CIRCLE")` 到 `indexOf("];")` 整段截取。

### 教训

1. **同一件事的判据分散在两个文件时，必须成对改**。分组键在 background、排序在 popup，
   两边各有一套「什么叫同一组」的隐含假设，改一边不改另一边 = 没改。现在两边的判据
   都收敛到「标题相同即同组」这一句话上，代码里互相引用了对方的注释。
2. **「没有按钮」和「按钮点了失败」是两类问题**，排查时先确认按钮在不在，
   别一上来就查网络/权限。
3. 用户描述的「第一个没有编号」不一定是「没编号」，可能是「编号顺序看起来不对」。
   **先把真实现象复述一遍再动手**，否则会去修一个不存在的问题。

### 涉及文件

- `extension/background.js`（`renumberImages` 的分组键 `gk`）
- `extension/popup.js`（`visibleItems` 排序 comparator、新增 `canPreviewSrc`、两处预览按钮条件）
- `test/group_key.test.js`（新增，15 项：G1 分组 4 / G2 小红书回归 2 / G3 预览 6 / G4 排序 3）
- `test/background.test.js`（末尾 require 新测试文件）
- `.github/workflows/tests.yml`（background 项数 174 → 189）
- `extension/manifest.json`（1.3.15 → 1.3.16）

---

<a id="d-020"></a>
## #d-020 · 2026-10-20 · 只读审查报告的三个高危项：tabId=0 / 素材漏判 / SPA 迟到消息

**问题**

用户给了一份第三方只读审查报告（`media-sniffer-readonly-review-and-fix-plan.md`，基准 `1736426`），其中三条和跨站兼容性相关：

1. `record()` 的 `if (!d || !d.tabId || d.tabId < 0) return;` 会把 **tabId=0** 当假值丢掉 —— Chrome 的标签页 id 从 0 开始，0 是合法值。
2. B 站列表里混进 `bfs/archive/xxx.jpg@.avif`（47KB）、`bfs/svg-next/xxx.png`（29KB）这类站方 UI 素材。
3. 切视频后上一页的封面残留在列表里。

**排查**

先按报告给的定位逐条读代码，得到的结论：

1. 属实。`!d.tabId` 对 `0` 是假值，直接 return。
2. 根因不是「缺规则」，是**规则顺序错了**：`looksLikeIcon` 末尾是

   ```js
   if (s && s > 24 * 1024) return false;   // 大于 24KB 的先当真图
   if (THUMB_HINT.test(u)) return true;
   if (/\.(svg|ico)(\?|$)/i.test(u)) return true;
   if (CDN_HINT.test(u)) return true;      // ← 永远轮不到
   ```

   47KB 的素材在第一行就放行了，后面所有 URL 特征全部作废。
3. `watchSpaNav`（`inject-main.js`）和 `p.cmd === "nav"` 的重建逻辑**都已经存在**，导航时 `state` 也确实被清空了。真正的洞是**清空之后**：页面 A 还挂着一个 `setTimeout` 的扫描回调，导航到 B 之后它把 A 的图发上来，background 刚建的新记录就被污染了。报告说「SPA 生命周期没处理」不准确，准确的说法是「**迟到消息没有代次可以拒绝**」。

**解决方案**

先写测试，看着它们红，再改代码（`test/review.test.js`，通过 `background.test.js` 末尾 `require` 接入同一套 `check()`）：

- `[R1]` 6 项：tabId 为 `0` / `-1` / 缺失 / `42` / `1.5` / `"0"`。
- `[R2]` 11 项：两条真机素材必须判装饰、**同 CDN 的真封面不能被误杀**、尺寸 95/96/97 边界、体积 24576/24577 边界、`hint=bili-cover` 保留。
- `[R3]` 5 项：A→B 切换后 A 的迟到 `gen` 必须被拒、不带 `gen` 兼容放行、重复上报幂等。
- `[R4]` 2 项：整页导航后旧条目清空。

改代码：

1. 抽出 `isValidTabId(t)` = `Number.isInteger(t) && t >= 0`，`record()` 改用它。
2. 新增 `isSiteUiAsset(u)`，把「站点素材形状」的判断**提到体积线之前**。判据落在路径形状上而不是域名上 —— 封面和 UI 素材在同一个 `hdslb.com` 上，域名一刀切会把真封面一起砍掉：
   - `/(?:^|\/)(?:svg-next|sprite[s]?|favicon|placeholder|loading|spinner|logo|icons?)\//i` 直接命中；
   - `xxxx.jpg@.avif` 这类**带变换后缀**且位于 `svg-next|archive` 目录、文件名是纯 24 位以上 hash 的，判素材。
   - 真封面 `5242750857.jpg@.webp` 名字带语义，不会被最后一条命中（测试 `[R2]` 专门守着）。
3. `looksLikeIcon` 里加正向豁免：`hint === "bili-cover"` 直接 `return false`，不让后面的尺寸启发式把 100×100 的小封面误杀。
4. 导航代次：`inject-main.js` 的 `watchSpaNav` 维护 `gen`，每次 `pushState/replaceState/popstate/hashchange` 变化时 `gen += 1` 并随 `nav` 消息发出；`post()` 统一给 `found/progress` 补 `gen`（`window.__msNavGen()`）。
   - background 在 `nav` 重建记录时记下 `gen`，`recordPageMedia` 入口 `if (p.gen < rec.gen) return;`。
   - `tabs.onUpdated` 的 `loading` 重建把 `gen` 置 **0**：整页刷新后页面侧计数器从 0 重来，不同步归零会让新页面（gen=0/1）的上报被旧的大代次拦掉，表现是「刷新后什么都抓不到」。
5. 抓取诊断：`diagBump(tabId, 原因, url)` 按 tab 记 `{seen, drop:{原因:次数}, sample:{原因:[url×5]}}`，在 `record()` 的每条丢弃路径打点（`bad-tabid` / `bad-scheme` / `too-small:<kind>`），`sniff:get` 把 `diag` 带回 popup；popup 空列表时渲染一行「本次共收到 N 个请求，已丢弃：…」。这是给「51cg1.com 视频列表为空」这类问题准备的**通用**排查口（该站点本身按用户要求不单独处理）。

**试过但失败的**

- 第一版 `isSiteUiAsset` 要求文件名同时匹配 `nbr|icon|logo|sprite|ico|badge`，结果 47KB 那条（文件名是纯 hash `fac5c6d5ce…`）不匹配，测试仍红。加「纯 hash + 变换后缀」这一支才通。
- 测试桩里 `headerValue` 一开始写成 `() => ""`，`too-small` 的诊断断言全红 —— 体量门槛测试必须真读 `content-length`，改成从 headers 数组里找。
- `review.test.js` 被 `run_all` 风格的循环单独跑时输出空行被当成失败，加 `require.main === module` 早退说明。

**教训**

1. **规则顺序就是规则本身**。`s > 24KB` 写在 `CDN_HINT` 前面，等于把后者删掉了。补测试时要专门断言「后置规则在前置规则放行时确实轮不到」。
2. **站点素材的判据要落在路径形状上，不能落在域名上**。同一个 CDN 上既有 UI 素材也有真封面，域名一刀切必然误杀。
3. **「已经清空了」不等于「不会脏」**。清空只解决存量，迟到的异步回调会制造增量；跨页面共享的容器必须带一个**代次/纪元**，让旧上下文的消息可以被识别并丢弃。
4. **代次要两头对齐**。SPA 内切页时页面侧自增、background 跟随；整页刷新时页面侧归零、background 也必须归零，否则刷新后全丢。
5. **诊断要打在丢弃点，不是出口**。「列表为空」有无数种原因，只有在每一个 `return` 前记一笔，用户看到的那一行才有信息量。

**涉及文件**

- `extension/background.js`（`isValidTabId` / `isSiteUiAsset` / `looksLikeIcon` / `record` / `diagBump` / `recordPageMedia` 代次闸 / `sniff:get` 带 diag / `nav` 与 `tabs.onUpdated` 记 gen）
- `extension/inject-main.js`（`watchSpaNav` 的 `gen`、`post()` 补 `gen`、`window.__msNavGen`）
- `extension/popup.js` / `extension/popup.css`（空列表诊断行 + `.diag` 样式）
- `test/review.test.js`（新增 24 项）、`test/background.test.js`（末尾接入）
- `DEVLOG.md` / `DEVELOPMENT.md` / `extension/manifest.json`（1.3.15）

---

<a id="d-019"></a>
## #d-019 · 2026-10-19 · A2：B 站图片只留所点开视频的封面

**问题**：用户 m11900 第 2 条——「B站的图片获取我想改为仅获取所点开视频的封面」。B 站视频页 DOM 里的 `<img>` 全是噪声（头像、推荐位、广告、直播卡），用户要的只有当前视频那张封面。

**排查**：class 选择器随 B 站改版会变（d-016 刚吃过亏）；唯一稳的判据是「是不是 `__INITIAL_STATE__` 里那个 cover」。`videoData.pic` 是协议相对 `//i0.hdslb.com/...` 且可能带 `http://`，必须规整成 https，否则和 webRequest 抓到的 https 条目对不上。

**解决方案**（`extension/inject-main.js`）：
- `biliCoverImage()`：候选 `videoData.pic` → `vd.cover` → `epInfo.cover` → `mediaInfo.cover` → `videoData.pages[0].first_frame`，`norm()` 规整协议；返回 `{url, title: biliTitle()}`。
- 站点钩子 `onScanImages`：有 `__playinfo__` 且拿到封面时，直接发一条 `hint:"bili-cover"` 的 found 并接管本次扫描（return true）；拿不到封面则 return false 退回通用扫描——宁可多抓也不漏。
- 站点钩子 `isImageOnly`：视频页上非封面的 `<img>` 一律拦下；`biliIsCoverSrc(src, cover)` 用 `new URL(u, location.href)` 取 hostname+pathname、`replace(/@[^/]*$/,"")` 去掉 CDN 的 `@672w_378h` 尺寸段后比对——同一张封面带 query 或 @ 尺寸段都认得。

**教训（测试桩）**：
1. vm 裸脚本里顶层标识符 `URL` 解析的是 **context 顶层属性**，不是 `window.URL`——`sandbox.window.URL = URL` 无效，必须 `sandbox.URL = URL`（用完换回去）。
2. 测试里的 `FakeURL` 只解析 href、没有 hostname/pathname，`biliIsCoverSrc` 的 `cut()` 拿到 undefined 全返回 ""，断言全 false 且不报错——**假桩让函数「静默说谎」，先怀疑桩再怀疑实现**。
3. 测试不能引用别的用例块里的局部函数（`toTelegram()` 是 `[12]` 块内局部函数），清场直接赋值恢复 `sandboxLocation`。

---

<a id="d-018"></a>
## #d-018 · 2026-10-19 · 复查 1.3.11：noteId 闸从未生效（死代码）

**问题**
对 d-017 的两个提交（b7aa34f / 307d8b9）做复查，逐条核对「拆泄漏是否拆干净、
noteId 隔离有没有洞、提示会不会误报」。结论：架构方向都对，但**核心修复本身
是死代码**，另有一批提示链路只接了一半。

**主问题：拦截门不可达**
background 的「同帖分片让位」闸条件是
`!p.hint && rec.xhsVid && xhsVidNote === p.noteId && (mse || blob)`。
但全扩展只有 `reportXhsVideo` 的 found/progress 带 noteId，而它们**都带
hint=xhs-note** —— 被 `!p.hint` 排除。blob/MSE 那条路（createObjectURL hook、
MSE hook、rescan 重放、handleMediaSrc）**全都不带 noteId**。两条路互斥，
`xhsVidNote === curNote` 永远比不中，闸从未拦过任何一条消息：

- 同帖的重扫（popup ⟳）会把 blob/MSE 条目原样重放回来，「页面视频（录制中）」复活；
- 真实地址上报后，`handleMediaSrc` 的 progress（w/h/dur 后到）也会重建 blob 条目。

「换帖抓不到」的症状实际是更早的 `watchSpaNav`（nav 消息 → 按 path 整个重置 tab）
兜住的，1.3.11 的净效果等于**删掉了旧闸**，而不是「按 noteId 精准隔离」。
没有任何行为测试喂过真实形状的消息，所以全绿地漏过去了。

**修法**
- 页面侧：`post()` 统一给不带 noteId 的 found/progress 注入 `siteContentId()`
  （新站点钩子，小红书 = `xhsCurrentNoteId()`，首页/其它站点返回 "" 不注）。
  注入点选在 post 而不是各上报点，是因为 blob/MSE 的上报点有 6+ 处，逐个补
  必然再漏。`hint=xhs-note` 自带的 noteId 幂等不覆盖。
- background 侧：`xhsVidNote` 补上生命周期 —— 真实地址缺 noteId 时**清空**，
  不能留着上一个帖子的旧值挡新帖。
- 测试：background.test.js 新增 `[11]` 段把 recordPageMedia 抽出来跑七个方向
  （同帖拦 / 换帖留 / 缺 noteId 留 / 图片留 / http 留 / 状态点亮 / 旧值清空）；
  main-hook.test.js 新增 `[12]` 段验证 post 注入的三向行为 + 幂等；
  site_registry.test.js 加「回放不许直调 reportBiliDash」的架构断言。

**顺带修掉的提示链路问题（同一批复查发现）**
1. `content.js` 的 `sendMessage` 没有回调 —— MV3 里它返回 Promise，
   「Receiving end doesn't exist」是**异步拒绝**，同步 try/catch 接不到，
   结果是每条失败消息留一个 unhandled rejection（提示没弹出来，控制台先刷屏了）。
   补 `.catch(warnInvalidatedOnce)`。
2. `warnInvalidatedOnce` 的一次性标志**先烧后判**：第一条不匹配的异常
   （消息太大之类）会烧掉唯一一次提示机会。改成先匹配、再动标志。
3. `__ms_sniffer_stale` 的 postMessage **没有任何监听者**（inject-main 只认
   `__ms_sniffer`/`__ms_sniffer_cmd` 两个标志）。补上：inject-main 收到后显示
   页内提示条（主世界脚本还活着，正好由它把话亮出来），点一下关。
4. rescan 通用块里 `siteResetReport(); reportBiliDash();` 并排 —— 拆泄漏停在
   差一行的地方。加 `replayReport()` 站点钩子（bilibili = `reportBiliDash`），
   通用块改调 `siteReplayReport()`，架构测试同步收紧。
5. popup 的 pingPageScript 在 chrome:// / 商店页 / PDF 查看器这类**从未注入过
   脚本的页面**也报「本页脚本已失效」—— 误诊（重载也无用）。加
   `^https?:` 门禁直接不问；文案改成同时盖住「刚装」和「刚更新」两种成因；
   8 秒清空定时器加内容守卫（期间用户点了别的按钮不再误清别人的提示）。

**教训**
- d-017 说「状态的作用域必须和语义一致」，这轮再补半句：**语义对了的闸还必须
  可达**。`xhsVidNote === curNote` 的语义完全正确，但数据管道没接通，等于没写。
  判据：给任何门写完，问一句「满足这个条件的消息，真的存在吗？」—— 用真实
  上报形状在脑子里走一遍，或者直接写成行为测试。
- 「只提示一次」的防刷屏机制自己也要防两个坑：标志在分流**之前**烧掉
  （真提示永远不来）、以及异步拒绝走不进同步 catch（提示根本没机会发）。
- MV3 的 `chrome.runtime.sendMessage` 不带回调时返回 Promise，失败走 rejection
  而不是同步 throw —— try/catch 包不住，必须显式 `.catch`。

---

<a id="d-017"></a>
## #d-017 · 2026-10-19 · 「为什么一个功能好了，另一个就失效」

**问题**
用户连续看到两次「修好 A 之后 B 坏了」，直接发问：
「通用代码是否已经抽出，小红书和 B 站等特有代码是否完全独立且互不影响、
图片和视频等特有代码是否完全独立且互不影响？为什么一个功能写好了，
另一个功能就失效，是本来就没有写好，还是怎么回事，先搞清楚」

**排查（先量化，再猜）**
写脚本扫 `extension/inject-main.js`：共 3409 行、92 个顶层函数，其中 44 个含站点专属
引用，全文 112 处 `isXhsHost|isBiliHost|xhs*|bili*`。分层看：
- 扫描层（`scanMedia` / `scanImages` / `guessTitle`）：A0 之后已经干净，全走 `site.*` 钩子。
- **下载层：还有 4 处硬编码的站点判断**（`startMediaDownload` 里的 `isBiliHost() && biliPlayinfo()`、
  `overlayShow` 的 `runSave`、浮层底部文案、`hello`/`rescan` 里的 `biliSig = ""`）。

**再找「互相影响」的真正机制** —— 两处 tab 级共享状态：
1. `background.js` 的 `rec.xhsVid` 是**整个标签页**的开关。它的本意是
   「本条视频已经有真实 mp4 了，就别再收 m1/m2 分片」，但写成了 tab 级：
   在小红书看完一个视频后 SPA 切到另一个帖子（不换 tab），新帖子的 blob/MSE
   条目**全被这道闸拦掉** → 表现就是「换了个视频就抓不到了」。
2. `content.js` 里 `chrome.runtime.sendMessage` 的 catch 是**完全静默**的。
   扩展重载后没刷新页面时，所有 found 消息无声丢失，用户看到「什么都没抓到」，
   却没有任何线索指向真正原因（页面没刷新）。

**解决方案**
- 拆 4 处泄漏：站点注册表新增 `canFeedDownload` / `feedDownload` / `saveHint` /
  `onSaveStart` 四个下载层钩子，注册 `bilibili` 站点对象，通用函数改调
  `siteCanFeed(ctx)` / `siteSaveHint()` / `siteResetReport()`。
- 修共享状态 1：`xhsVid` 从「tab 级开关」改成「按 noteId 绑定」。新增
  `rec.xhsVidNote`，拦截条件加 `xhsVidNote === curNote`；页面侧 `reportXhsVideo`
  的 found/progress 都带上 `noteId`，`recordPageMedia` 存进条目。
- 修共享状态 2：`content.js` 的 catch 改成 `warnInvalidatedOnce(err)`，只对
  `context invalidated|extension context|receiving end` 提示，且**只提示一次**；
  同时 popup 打开时主动 `ms:ping` 一次，拿不到回应就在提示栏写上
  「本页脚本已失效（扩展更新过），点右上角 ⟳ 重新载入页面」。

**教训**
- 「功能互相影响」绝大多数不是逻辑写错，而是**共享状态的作用域写大了**。
  看到「A 好了 B 坏了」，先去 grep 有没有 tab 级 / 全局级的标志位，
  比逐行读业务逻辑快得多。
- 架构上「抽钩子」只解决**代码耦合**，不解决**状态耦合**。A0 做完扫描层干净了，
  但同一个 `rec` 对象还被下载层和记录层共用。要真隔离，状态也得按作用域
  分桶（如 `rec.xhsVidNote` 这种「按内容 id 绑定」）。
- 静默 catch 是排障毒药。当时写 `catch (err) { /* 忽略 */ }` 是为了防刷屏，
  代价是「扩展失效」和「功能坏掉」在用户眼里完全一样。

---

<a id="d-016"></a>
## #d-016 · 2026-10-19 · B 站视频条目没标题（列表里永远显示「完整 DASH 流」）

**问题**
用户在 B 站普通投稿视频页（`/video/BV...`）点扩展，列表里那条完整视频的名字是
「B 站视频（完整 DASH 流）」——这其实是 `popup.js` 补合成条目时写死的**占位文案**，
说明真实标题根本没传到 popup。用户的原话很尖锐：
「视频条目没有标题，为什么一个功能好了，另一个功能就失效？」

**排查（一路排除到根因）**
1. 先怀疑「桥梁断了」：`content.js` 里 `chrome.runtime.sendMessage` 被 catch 静默吞掉，
   扩展重载后页面里旧的注入脚本会失效。→ 但用户确认「重载扩展后刷新过 B 站页面」，
   这条排除。
2. 查 background 有没有覆盖 title：`recordPageMedia`（`background.js:452`
   `if (p.title) existed.title = p.title;`、`:500` `title: p.title || ""`）都正常；
   `sniff:get`（`:1302` 起）不碰 title；没有任何过滤 `__bili_dash__` 的规则。
3. 查页面侧上报：`inject-main.js:77` 的 `post` 正常；`reportBiliDash` 每 2.5s
   `setInterval`（`:1187`）注册着；`title` 算完直接塞进 `post`。
4. **真正的问题在 `biliTitle()`（`inject-main.js:2390`）**：选择器全是上一代 B 站的
   —— `h1.video-title`、`#viewbox_report h1`、`.video-info-title h1`……
   2025 年 B 站改版后一个都命不中，于是退到 `document.title`；
   而 SPA 首屏的 `document.title` 常常还是「哔哩哔哩 (゜-゜)つロ 干杯~」这种站点名，
   剥后缀也剥不干净，最后 `return "bilibili"`。

**试过但失败的**
- 只用 DOM 选择器「补几个新的」：治标。B 站改版频率高，加选择器等于永远在追。
- 用 `<title>` 兜底：SPA 场景不可靠（首屏是站名，切换分P后滞后）。

**解决方案**
`biliTitle()` 改成**三级来源，从稳到脆**：
1. `window.__INITIAL_STATE__.videoData.title` / `h1Title` / `pages[0].part` /
   `epInfo.title` / `mediaInfo.title` —— 页面数据总仓，**不随 DOM 改版失效**（主来源）。
2. DOM 选择器（新版 `#arc_toolbar_report h1` 在前、旧版在后）—— 兜底。
3. `<title>` 剥后缀 —— 最后一层兜底。
4. **三个都不中返回 `""`，绝不返回 `"bilibili"`**；`cleanBiliTitle` 新增两条正则，
   把「哔哩哔哩 (゜-゜)つロ 干杯~」这种纯站名整条剥掉。

同时修了 `reportBiliDash` 的一个隐藏 bug：签名 `cid|title|part` 在「先空后有」的两次上报里
**完全相同**，第二次带着好标题的那条会被去重挡掉。签名尾部加 `|t`/`|n` 区分有无标题。

**教训**
- **「一个功能好了，另一个就失效」通常不是回归，是另一个功能从没真正生效过。**
  这次 B 站标题看似被我之前的改动弄坏，实际是 `biliTitle()` 从 2025 年改版起就一直在返回 `"bilibili"`，
  只是以前列表里条目少、没人注意。
- **选择器是租来的，`__INITIAL_STATE__` 才是自己的。** 小红书的 `imageList` 经验同样适用于 B 站。
- 兜底值不能用「看起来像数据」的假数据（`"bilibili"`）。返回空串，让上层决定怎么显示。

**验证**
`test/main-hook.test.js` 新增 `[11]` 块 10 项（state 优先 / h1Title / 番剧 epInfo /
新版 DOM / 旧版 DOM / `<title>` 剥后缀 / 空串回归 / 不返回 bilibili / state 优先于 DOM）。
main-hook 160 → 169 项，全量 JS 390 项、Python 8 套件全 PASS。

---

<a id="d-015"></a>
## #d-015 · 2026-10-19 · A1 首页信息流封面不加序号

**问题**

用户附截图：「既然标题不一样就不要加序号了」。
截图里小红书首页信息流的九张封面，每张前面都顶着一个「①」，
标题分别是「千万不要点这个肯德基的虾仁肉堡」「好像 Maybe Tomorrow」「存一个血糖爆炸的食物…」，
互相毫无关系。

**排查**

序号是 `renumberImages()` 发的，规则是「同一组的多张图才编号」（`list.length > 1`）。
那么为什么会各自成组、各自拿到 ①？

看分组前的准入条件：

```js
if (!xhsDetail && !it.mid && !(it.title || "").trim()) continue;
```

翻译过来：**只要有 mid 或有 title，就允许编号**。
这个规则对 Telegram 是对的（同一条消息的多张图共用一个 mid），
对小红书详情页也是对的（整帖共用一个分组键 `"xhs"`）。

但第八轮给信息流封面补了 `xhsFeedTitle()` 之后，**每张封面都拿到了自己的标题**。
于是每张都通过准入 → 各进各的组（分组键里含 `title`）→ **每组只有它一张**……
等一下，每组只有一张的话，`list.length > 1` 不成立，应该不编号才对。

**真正的坑在这里**：分组键是 `k + "|" + "t:" + title + "|" + ref`。
详情页被特判成常量 `"xhs"`，但**首页没有特判，走的是标题分组**。
如果两张封面恰好标题相同（或者都是空串被归一），才会落进同一组。
而实测的现象是「每张都是 ①」——说明它们**确实各自成组且各自 length > 1**？

不对。重新看截图：九张封面，每张都是 `①`。如果每组只有一张，`length > 1` 为假，
`mark` 应该是 `""`。所以真相是另一条路：

**`mark` 不是这次 `renumberImages` 发的**——它是上一轮遗留的值。
`renumberImages` 末尾只对 `groups` 里的条目写 `idx`/`mark`，
**不在 groups 里的条目，`mark` 保持上一轮的值不变**。
而首页的图在「有标题后进 groups、下轮内容变化后又不进 groups」之间来回切换，
每次进 groups 时若恰好 length > 1 就写了 ①，之后出组了也没人清。

不管具体是哪条路径，**根因是同一个**：编号机制假设「有标题 = 属于同一个可排序集合」，
而信息流的标题是**每条各自独立**的，这个假设从一开始就不成立。

**解决方案**

在准入条件前面加一条**硬排除**：小红书的非详情页（首页/发现/搜索），
只要有标题就直接跳过，不参与编号。

```js
if (!xhsDetail && isXhsHostUrl((rec && rec.url) || "") && (it.title || "").trim()) continue;
if (!xhsDetail && !it.mid && !(it.title || "").trim()) continue;
```

为什么用「有标题就排除」而不是「标题相同才排除」：信息流的语义是
**每条笔记一张封面、彼此无关**，编号表达的是「同一条内容里的第几张」，
对信息流没有任何意义。宁可全部不编号，也不要去猜哪些该归一组。

**验证**

补了三条测试（`[4c]`）：

| 测试 | 断言 |
|---|---|
| A1 首页信息流封面有标题也不编号 | 三条带不同标题的 feed 条目，`mark` 和 `idx` 全为空 |
| A1 详情页不受影响 | 详情页两条仍编号 ①② |
| A1 非小红书站点照常编号 | Telegram 相册（有 mid）仍 ①②，没被误伤 |

`background.test.js` 135 → 138 项，全过；全量 JS 378 → 381 项全过。

**教训**

1. **编号表达的语义是「同一条内容里的第几张」**。信息流、推荐位、搜索结果里
   每条都是独立内容，给它们编号从语义上就是错的——不是实现问题。
2. **`mark` 是状态，不是每轮重算的结果**。不在本组里的条目不写 `mark`，
   于是它会**保留上一轮的值**。这类「只写不改」的循环迟早留下脏数据，
   正确的写法应该先清空所有条目再重新分配。
3. **加功能会激活旧假设**。第八轮补标题时没人想到「标题是编号的准入条件之一」，
   结果一个纯粹的显示改进，把另一处八竿子打不着的逻辑弄崩了。

**涉及**：`extension/background.js`（`renumberImages`）、`test/background.test.js`

---

<a id="d-014"></a>
## #d-014 · 2026-10-19 · A0 功能模块化：抽出站点注册表

**问题**

用户问：「图片和视频下载是否有通用的代码，是否需要针对特定应用添加逻辑」。
翻译成代码问题就是：每加一个站点，要去改几个通用函数？

答案是 **4~5 个**。`guessTitle`、`scanImages`、`scanMedia`、`handleMediaSrc`、
`reportXhsVideo` 里都嵌着 `if (isXhsHost())`。这不叫模块化，叫 if 汤。

**排查**

按数据流把 `inject-main.js`（3256 行）切了一遍，逐层问「这层认不认站点」：

| 层 | 结论 |
|---|---|
| 发现层（轮询 / MSE hook / 媒体请求拦截） | 100% 通用 |
| 下载层（Range 链 / 并发 / 探针） | 100% 通用 |
| 上下文层（标题 / 尺寸 / 顺序） | 接口通用、实现特化 |
| 归属层（属于当前内容吗） | 接口通用、实现特化 |
| 清单层（`__playinfo__` / `imageList`） | 只有 B 站、小红书有 |

所以答案是：**通用代码确实是通用的，病灶只在「站点判断散落各处」**。

**方案选择**

给了三个方案让用户选：

- **A. 站点插件对象**：每站一个对象，通用层只认接口。改动中等，治本。← **用户选这个**
- **B. 只抽配置表**：判定条件收进表，逻辑仍留原地。改动小但治标不治本。
- **C. 拆成 `sites/` 目录**：文件最清晰，但 `inject-main.js` 是 IIFE 闭包，
  多文件注入会破坏私有作用域，等于重构整个模块系统，风险大。

选 A 后分两步：**第一步只建骨架不搬代码**（把 if 换成 `site.xxx?.()` 调用，
特化实现原样保留），第二步再把 564 行小红书 + 389 行 B 站代码物理搬进对象内部。

**试过但失败的**

一开始把 `imgIsXhsNote(src)`（只认 CDN 大图签名）塞进了 `owns` 钩子里，
想着「归属判断顺便把签名也筛了」。结果 `[5z]` 两项视频测试立刻变红：

```
✗ blob 视频被换成真实 mp4 后再上报 → []
✗ 上报的视频带 ord=0 → []
```

原因：`<video>` 元素的 `src` 是 `blob:https://...`，而签名判据针对图片 URL，
`blob:` 必然不匹配 → 视频被误杀。

**解决方案**

把「类型相关」的检查从 `owns` 里拆出来，独立成 `isImageOnly` 钩子，
只在 `scanImages` 校验 `<img>` 时调用。`owns` 回到纯粹的「归属」语义。

最终钩子列表（全部可选，不实现走通用默认）：

```js
match()            // 是否当前站点（唯一必须实现的）
isDecorImg(el,src) // 装饰图：头像/logo/二维码/评论图
isImageOnly(el,src)// 只对 <img> 生效的额外筛选
isDecorVideo(el)   // 装饰视频
owns(el)           // 归属
title(el)          // 标题（"" = 没结论）
videoSrc(el,src)   // blob: → 真实地址
feedImages()       // 完整清单
onScanImages()     // 清单类站点一次性上报
```

**教训**

1. **`owns` 只该回答「归属」**，不该掺「类型相关」的检查。语义一混，
   第一个受害者就是另一条数据通路（视频）。
2. **模块化必须有测试兜底**。新增 `test/site_registry.test.js`（14 项），
   核心断言是「通用函数体内（去掉注释后）不许出现 `isXhsHost()` / `xiaohongshu` 等」。
   没有这条约束，下一个人加站点最省事的做法仍是在 `scanImages` 里再抄一个 if，
   几个月后又变回原样。

**涉及**：`extension/inject-main.js`（新增 `SITES` 注册表 + 5 处通用函数改写）、
`test/site_registry.test.js`（新）、`.github/workflows/tests.yml`

---

<a id="d-013"></a>
## #d-013 · 2026-10-18 · 小红书：视频抓不到 / 没标题 / 编号错乱

**问题**

用户报三件事：「捕捉不到视频」「视频没有标题」「编号错乱」。

**排查**

「捕捉不到视频」其实是**抓到了 DASH 分片**。真机 dump 小红书视频的
`__INITIAL_STATE__.note.noteDetailMap[noteId].note.video.media.stream`，
同一个视频有好几档：

| 清晰度档 | URL 形态 | 实际是什么 |
|---|---|---|
| EF4 | `..._259.mp4` | 1280×720 **完整文件** |
| EF5 | `..._3090.m4s` / `..._3092.m4s` | 2560×1440，但只是**分片** |

原代码按 `(width|0)*(height|0)` 面积挑清晰度，2560×1440 面积更大 ⇒ 永远选到分片 ⇒
下下来不能播。

「没标题」是 `blob:` 条目抢先占了位。`scanMedia` 换不到真实地址就退回上报 `blob:`，
它成为该视频唯一的 `found`（`seenSrc` 挡着后续），弹「页面视频（录制中）」，标题恒空。

**解决方案**

1. 视频档位改「**完整文件优先、其次比面积**」：

```js
const isSeg = (u) => /\.m4s(\?|$)/i.test(u);
const rankOf = (u) => (isSeg(u) ? 0 : 1);
if (rank > bestRank || (rank === bestRank && area > bestArea)) { ... }
```

2. `blob:` 换不到真实地址就 `continue`（本轮跳过，600ms 后再来），**永不报 blob**。
3. `renumberImages` 加小红书跳过规则：`m1`/`m2` 这类 MSE 条目不编号；
   详情页视频/图片/封面共用一个序号池（`gk = "xhs"`）；
   视频帖封面 `ord` 加偏移 1，让视频占 ①。

**验证**

直接 `curl -I` 真实 URL：`200` / `video/mp4` / `Content-Length: 912619` / `Accept-Ranges: bytes`。
下载后 `ffprobe` → h264 1280×720 + aac、`duration=21.233`、`size=912619`，**完整可播放**。

真机复测（帖子 `6ad46958000000002f03b260`）：
`全部2 / 视频1 / 音频0 / 图片1`，两行分别是
`▶ ① 「当卡片可以收纳」 1280×720 · 0:21 · video/mp4` 和 `▣ ② 「当卡片可以收纳」 2560×1440`。

**教训**

1. **「抓不到」有三种截然不同的真相**：没抓到 / 抓到了分片 / 抓到了但地址不可播。
   先 dump 真实数据看清是哪种，别急着改逻辑。
2. **`blob:` 是个陷阱**：它看起来像一条有效的视频，但页面侧下不了。
   宁可不报（等真实地址），也不要报一条坏数据占位——它有 `seenSrc` 保护，一占就再不更新。

**涉及**：`extension/inject-main.js`、`extension/background.js`、`extension/popup.js`

---

<a id="d-012"></a>
## #d-012 · 2026-10-18 · 小红书：图片无法预览 / 封面重复 / 列表噪声

**问题**

用户提供截图：「有些图片无法预览」，并给出帖子链接。澄清后是三个现象：
① 带标题的四张图都无法预览 ② 实际有 18 张 ③ 带标题的每行只有一个按钮。

**排查（三层根因）**

**根因 1：预览按钮压根没有。**
`popup.js` 的 `renderItem()` 里 `const isPage = !!it.page;`，
`isPage` 分支只 append 一个「保存」按钮；「复制/打开/预览/下载」四个按钮全在 `else` 分支。
而小红书所有图都来自页面扫描（`source:"imgctx"` → `page:1`），所以一张预览按钮都没有。

> 用户说的「无法预览」= **没有入口**，不是加载失败。这个歧义卡了很久。

**根因 2：`page` 标记停在 0。**
`confirmPageItem(it)` 要求 `it.mid || it.title`，但 webRequest 常常比页面的 `found` 消息先到，
那时 `title` 还空 → 直接 return，之后再没人补。

**根因 3：同一张图 3~4 条。**
小红书 CDN 路径是 `/202610181600/<随机hash>/spectrum/<fileId>!后缀`，
**时间戳段和 hash 段每次请求都变**（实测同一张图 16:00 是 `004ef08…`，16:05 变 `b5b96ec…`），
拿整条 pathname 当身份永远对不上。

**试过但失败的**

一开始以为 `!n` 后缀导致的加载失败——因为实测 `!n` 后缀确实全部 ERR。
但 dump state 后发现有 `!n` 后缀的记录只有 1 条，而且用户的问题是「没有按钮」不是「按钮点了失败」。
**误判方向浪费了一轮。**

**解决方案**

1. `isPage` 分支补预览按钮（只给 `http(s)` 的 image/video/audio）。
2. `existed` 更新分支里补调 `confirmPageItem(existed)`。
3. 新增 `xhsImgIdentity(u)`：只取 `<类型>/<fileId>` 稳定段作为身份。
4. 新增 `preferXhsNoteList(items)`：有 `hint === "xhs-note"` 就只留它们，滤掉 SVG 雪碧图、
   别帖封面缩略图、无后缀随机 hex 的 UI 素材。
5. **改读 `__INITIAL_STATE__.note.noteDetailMap[noteId].note.imageList`**，
   DOM 扫描降级为兜底。

真机实测对比（帖子 `6ab221bd`）：

| 项 | `imageList` | DOM 扫描 |
|---|---|---|
| 张数 | **7 张，正好正确** | 7 条但 3 条 `s=0`（懒加载未解码）|
| 尺寸 | 全有 | 3 张没有 |
| 顺序 | 数组顺序 = 发布顺序 | 靠 `ord` 猜 |
| 归属 | 天然只含当前帖 | 从 **77 个** 带 1040g 的 `<img>` 里猜 |

**教训**

1. **用户的「无法预览」可能是「没有入口」**，不是「加载失败」。先问清现象比猜快得多。
2. **CDN 的 pathname 不一定稳定**。小红书的 `<时间戳>/<hash>` 两段每次都变，
   真正的身份证是末尾的 fileId。找稳定段要 dump 两次不同时间的真实 URL 对比。
3. **懒加载让 DOM 不可信**。轮播里只渲染首张，`naturalWidth` 全是 0。
   页面自己有 `__INITIAL_STATE__` 时，直读永远优于 DOM 扫描。

**涉及**：`extension/popup.js`、`extension/background.js`、`extension/inject-main.js`

---

<a id="d-011"></a>
## #d-011 · 2026-10-18 · 小红书：评论图 / 视频 / 标题

**问题**

用户六条里的第 1、2 条：评论区的图也会被抓、视频读不出来且名字对不上。

**排查**

真机登录态 dump 了帖子 `6ad32adb000000001b01d8a2`：

- **视频 `src` 是 blob**：`blob:https://www.xiaohongshu.com/364d1c52-...`，
  属性只有 `mediatype=video`，没有 `<source>`。真实 mp4 在
  `__INITIAL_STATE__.note.noteDetailMap[noteId].note.video.media.stream`。
- **属性名不一致**：信息流卡片是 `<section class="note-item" data-note-id=…>`（带 data- 前缀），
  而**正文容器是 `<div class="note-detail-mask" note-id="…">`（无 data- 前缀）**。
  原代码只查三个带前缀的名字 → 正文容器完全命不中。
- **评论图与正文图的区别只在路径里多一段 `/comment/`**：
  正文 `.../{hash}/1040g2sg326dsc2...!n`，评论 `.../{hash}/comment/1040g4b8326f...`。
- **标题在 `desc` 不在 `title`**：该帖 `note.title = ""`，`note.desc = "哇塞！"`。

**解决方案**

1. `xhsAncestorNoteId` 的 getAttribute 链改为 `note-id` → `data-note-id` → `data-noteid` → `data-note`
   （**`note-id` 必须放第一个**）。
2. 评论图双判据：URL 含 `/comment/` 段 + DOM 上溯命中评论容器。
3. 归属判断最前面加 `if (xhsInComment(el)) return false;`
   —— **必须在 noteId 核对之前**，因为评论区在正文容器内部，同一个 note-id，noteId 拦不住。
4. `xhsVideoSource()` 从 state 取真实 mp4，**`masterUrl` 是 `http://` 必须转 `https://`**
   （否则和 webRequest 的 https 条目 key 不同，列表里出现同一个视频两条）。
5. 标题取 `note.title || note.desc`。

**试错最多的：晚到标题补发（lateTitle）连错两次**

小红书首轮 `guessTitle` 必空，`found` 只发一次（被 `seenSrc` 挡着），需要补发。判据改了三次：

| 版本 | 判据 | 结果 |
|---|---|---|
| ① | `if (!title && !seenSrc.has(url)) lateTitle = true;` 放在取标题**之后** | `title` 已有值，**死代码**，永不触发 |
| ② | `const hadTitle = !!titles.get(url)` | 首次 `titles` 必空 → 对 Telegram「首轮就有标题」也误触发，红 3 项 |
| ③ | `!seenSrc.has(url)` | **正确**。`seenSrc` 在首轮 found 后立刻加入，次轮才为 true |

**教训**

1. **判断「第几轮」要用标记集合，不要用「字段是否已有值」**。
   字段为空既可能是「还没轮到」，也可能是「本来就没有」。
2. **同一个页面可能用两套命名**（`note-id` vs `data-note-id`）。只认一套必然漏。
3. **评论区在正文容器内部**。所有「容器归属」判断都必须先处理「是不是评论区」，
   否则子容器永远跟着父容器一起通过。

**涉及**：`extension/inject-main.js`

---

<a id="d-010"></a>
## #d-010 · 2026-10-18 · 小红书：别人帖子的图混进来

**问题**

用户：「不仅包含当前帖子所属图片，还有其他帖子的」。

**排查**

旧代码按 `im.parentElement` 分组打分（`图数×1e9 + 容器面积`），取「图最多」的组当正文。

但真实小红书详情页是 **swiper 轮播**：**每张正文图各占一个 slide 容器**。
于是每组只有 1 张图，「图最多」退化成「面积最大」→ 只认一张、误杀其余。
而且猜的类名 `note-item|feed-item|recommend...` 根本命不中。

**解决方案**

换成三路独立信号（按强度）：

1. **URL noteId**：`xhsIdInUrl(src)` 含当前 noteId ⇒ true；含别的 24 位 hex ⇒ false。
2. **祖先 `data-note-id`**：上溯 40 层查。
3. **祖先链容器推算**：逐层 `contains()` 数覆盖数，取最大；覆盖不足一半时放行。

**踩坑：裸正则会把视频 URL 拼出假 noteId**

最开始写 `/[0-9a-f]{24}/gi`，结果视频 URL
`https://sns-video-hw.xhscdn.com/stream/abc/110/258/01e8f0.mp4`
里的 `110/258/01e8f0` 被跨段拼成 24 位 hex → 正文视频全被过滤。

必须边界锚定：

```js
const XHS_NOTE_ID_RE = /(?:^|[\/=&_-])([0-9a-f]{24})(?=$|[\/=&_.!-])/gi;
```

**教训**

1. **不要按「父节点分组」猜归属**。轮播布局里每张图一个容器，分组思路从根上就错。
2. **裸写 `/[0-9a-f]{24}/` 一定会误伤**。24 位 hex 是 96 bit，太容易在 URL 里凑出来。
   必须锚定边界。
3. **测试「假绿」比测试失败更危险**。当时两项红测卡了很久，最后发现是测试桩里
   `[5z]` 忘了把 `sandboxLocation` 切回小红书，归属函数第一句就 `return true` 放行了
   —— **逻辑压根没执行**。教训：先证明函数被执行了没有，再怀疑函数内容。

**涉及**：`extension/inject-main.js`、`test/main-hook.test.js`

---

<a id="d-009"></a>
## #d-009 · 2026-10-18 · 用户提的六条问题（总览与状态）

**问题**

用户一次提了六条，要求「写入开发文档，一个一个地解决」。

> 原话：「1.评论区里的图片也会抓取，这个要改 2.小红书的视频无法读取，名字对不上等和图片之前
> 遇到的问题一样 3.视频或图片的水印能否去掉 4.给代码添加注释，方便以后读取更改
> 5.给功能分组，方便快速定位问题（待定，之后在商量）6.在开发文档里写一个章节，
> 把整个开发过程中，实现功能时遇到的问题以及解决方案全部写进去。」

**各条处置**

| # | 处理 | 详见 |
|---|---|---|
| 1 | 双判据拦下评论图 | [d-011](#d-011) |
| 2 | state 里取真实 mp4 + 标题回退 desc + 晚到标题补发 | [d-011](#d-011)、[d-013](#d-013) |
| 3 | **评估后建议不做**（见下） | — |
| 4 | 四个文件注释从 6~11% 补到 16~36%，全项目 39% | 本文档下方 |
| 5 | 用户标注「待定」，不擅自动手 | — |
| 6 | 本章即该条的落点 | 全部条目 |

**第 3 条（去水印）为什么建议不做**

- 烧进画面的水印要去除只能靠 inpainting，**必然有损重编码**，画质下降明显；
- 平台水印属版权标识，去除有法律风险；
- 我们抓到的源文件本就**不含独立水印图层**（水印是服务端烧进去的），
  技术上没有「去掉图层」这条路，只有「抹掉像素」。

**第 4 条：注释补完的实际数字**

最初用 `grep -cE '^\s*(//|#|\*|/\*)'` 统计，得出 library.py 只有 2%——
但实际读下来它的 docstring 很完整。**统计口径骗人**，真实缺口是
popup.js、downloader.py、setup.py、sniffer_host.py。

| 文件 | 补前 | 补后 |
|---|---|---|
| `extension/popup.js` | 11% | 36% |
| `native-host/sniffer_host.py` | 11% | 21% |
| `native-host/downloader.py` | 6% | 16% |
| `native-host/setup.py` | 7% | 22% |

**教训**

1. **行级注释密度不等于可读性**。docstring 完整的文件可能密度很低但很好读。
   统计只能用来找「明显没人管」的文件，不能当质量指标。
2. **「做不到」也是一种结论**。第 3 条评估后明确说不做，比勉强做一个有损、有法律风险的功能好。

---

<a id="d-008"></a>
## #d-008 · 2026-10-18 · B 站视频名字不显示

**问题**

用户：「B站视频名字不显示」。

**排查**

popup 列表显示的标题是对的，真凶在别处：`popup.js` 的 `pageSaveItem` 把 B 站条目
`name` 写死成 `"bilibili"`。

**解决方案**

标题有五个落点，必须全部一致：

| # | 落点 | 位置 |
|---|---|---|
| 1 | background 条目 `title` | `reportBiliDash()` |
| 2 | popup 载荷 `name` | `pageSaveItem()` |
| 3 | 浮层显示名 | `overlayShow()` |
| 4 | 最终文件名 | `runBiliDownload()` 的 `base` |
| 5 | 去重签名 | `reportBiliDash()` 的 `fullSig` |

补了三处漏洞：

- `shortTitle()` 截断会吃掉扩展名 → 改为截断前先摘出 `/\.([a-z0-9]{2,5})$/i` 再拼回。
- `fileNameTitle()` 加前缀剥离 `^[a-z0-9.-]*bilibili(\.com)?\s*[/|·]\s*`。
- `runBiliDownload` 文件名基名改两级兜底（popup 的 title 可能是几秒前的）。

新增 `safeFileName()`（`%XX` 解码 + 非法字符替换 + 去首尾点空格）与
`biliPartTag()`（`?p=N` → `-PN`，番剧 ep 页返回空）。

**真机验证**

真实 h1 =「张也&吕继宏 对唱采访合集1（更新P1/P2/P16）」
→ 落盘 `张也&吕继宏 对唱采访合集1（更新P1_P2_P16）-P3.mp4`（斜杠变 `_` 是 `sanitize` 既定行为），
`ffprobe` = h264 1066x480 + aac 双流，源流已清理。

**教训**

1. **「显示的标题」和「保存的文件名」是两条独立路径**。改标题要清点全部落点，
   漏一个就出现「列表对、文件错」。
2. **分P 是唯一可靠的换集信号**。有些页面切集后 `__INITIAL_STATE__` 会滞后，
   只有 URL 里的 `?p=N` 立即变。所以 `fullSig` 里必须带 part。

**涉及**：`extension/popup.js`、`extension/inject-main.js`

---

<a id="d-007"></a>
## #d-007 · 2026-10-18 · 提升广覆盖：三项低风险改动

**问题**

用户：「它几乎能捕捉到大部分网页上的资源，而我们的几乎不能正常使用」，
要求参考主流下载器的做法。

**排查**

对比后定位到三个结构性差距：

1. 我们只挂 `onHeadersReceived`，主流做法还挂 `onResponseStarted`（能多抓到一部分响应头）。
2. 分类只靠扩展名 + mime，没有体积门槛 → 一堆幽灵条目（2KB 的"视频"）。
3. 去重只按完整 URL，没有任何通用归一化。

**解决方案**

| 改动 | 做法 |
|---|---|
| 体积门槛 | `MIN_MEDIA_BYTES = {video:2048, audio:10240, image:512}`；206 分段跳过（content-length 只是分段长） |
| 通用去重 | `identityOf(url)` = hostname + pathname（去 query/hash），只合并「裸条目」 |
| 双监听 | 加 `onResponseStarted` + `recordedRequestIds` 防重复记录 |

**教训**

1. **体积门槛要排除 206**。Range 分段的 `content-length` 是分段长，不是文件长，
   拿它做门槛会把大文件的分段全过滤掉。
2. **通用去重要保守**。只合并「没有任何上下文」（无 mid/title/page/hint）的裸条目，
   带上下文的条目各有各的语义，贸然合并会误删。

**涉及**：`extension/background.js`

---

<a id="d-006"></a>
## #d-006 · 2026-10-18 · 小红书点开笔记抓不到视频 / 保存卡在「正在读取媒体信息…」

**问题**

用户截图：浮层停在「正在读取媒体信息… / 等待数据…」，进度条空，一天不动。

**排查**

`runRangeDownload` 第 1 步是「第一个分段充当探针」，而 `fetchRange()` 和 `probeTotal()`
里所有 `fetch()` **都没有超时**。CDN 把连接挂住不回响应时，Promise 永远 pending。

**解决方案**

新增 `fetchWithTimeout(url, opts, ms)`：

- 外层 `opts.signal` 中止 → 抛 `AbortError`（真取消）
- 自己掐表 → 抛带 `timeout` 标记的普通 Error（可重试的网络错误）

常量：`FETCH_TIMEOUT_PROBE = 20s`、`FETCH_TIMEOUT_CHUNK = 40s`、`PROBE_HINT_AFTER = 8s`。

**为什么 40s 这么长**：4MB 段在 100KB/s 的弱网要 40 秒。再短会误杀大分段。

超过 8 秒没回来，阶段行补一句「已等 Ns，仍在连接，可点取消」，让用户知道没死。

**教训**

1. **`fetch()` 没有任何超时**。这是 Web 平台的设计，每个可能挂住的请求都必须自己掐表。
2. **超时值要匹配最坏情况**。按「最快情况」算超时，弱网下全是误杀。
3. **长时间等待必须给反馈**。哪怕只是「已等 Ns」也比静止不动强。

**涉及**：`extension/inject-main.js`、`test/main-hook.test.js`

---

<a id="d-005"></a>
## #d-005 · 2026-10-18 · 小红书只显示当前帖子的图

**问题**

用户：「打开帖子时，只会显示当前帖子所包括的图片」。
第一版只修了「封面重复两张」，后来发现还有别的帖子混入（见 [d-010](#d-010)）。

**排查**

详情页把同一张图用**不同尺寸后缀**引用多次（主图位 + 缩略图/预载），URL 不同
⇒ `rec.items`（Map，key=URL）记了两条。

**解决方案**

- `xhsImgIdentity(u)` 取稳定段（见 [d-012](#d-012)）
- `dedupeXhsNoteImages(items)` 同身份只留体量最大
- `sniff:get` 出口按 `isXhsDetailUrl(tabUrl)` 分流去重

**教训**

**URL 是 Map 的 key 时，一定要先问「这个 URL 稳定吗」**。
带时间戳/随机 hash 的 CDN 路径会一次性产生多条重复条目。

**涉及**：`extension/background.js`

---

<a id="d-004"></a>
## #d-004 · 2026-10-18 · 图片和图标混用（历史遗留，多轮）

**问题**

从项目第一天就存在：图片列表里混着头像、emoji、favicon、雪碧图。

**处理历程（多轮收紧）**

| 轮次 | 做法 | 结果 |
|---|---|---|
| 1 | `looksLikeIcon(it)` 按尺寸 ≤96、URL 关键词判断 | 大量漏判 |
| 2 | 加体积线 `>24KB 当图` | svg 雪碧图 82KB 混进来 |
| 3 | 加 `THUMB_HINT`/`CDN_HINT` 正则 | 仍有站内素材漏网 |
| 4 | 小红书专项：`.svg/.ico`、`fe-static/fe-platform`、评论图前缀 | 基本干净 |

**关键认识**

**「图标」没有通用定义**。同一个 URL 形状在不同站点可能是正文图也可能是装饰。
通用规则永远在「漏判」和「误杀」之间摇摆，**最终必须落到站点判据**（这正是 A0 模块化的动机）。

**教训**

**通用启发式只能过滤掉最明显的一批**。剩下的必须靠站点知识（哪个 CDN 是素材域名、
哪些 class 是装饰、哪种路径段是评论图）。

**涉及**：`extension/background.js`、`extension/inject-main.js`

---

<a id="d-003"></a>
## #d-003 · 2026-10-18 · 改动不生效 / 页面没刷新

**问题**

用户反复反馈「上述功能全都没有实现」。但代码明明改好了，测试也过了。

**排查**

写 CDP 探针直接查页面里的实际情况，发现：

- 扩展注册正常（`Secure Preferences` 里无 `disable_reasons`）
- 页面里 `window.__ms*` 存在，但**是旧版本的**
- 磁盘上 `inject-main.js` 83978 字节 = UTF-8 解码 71031 字符，与页面里拿到的完全一致

结论：**代码正确且已被 Chrome 加载，但页面里跑的是旧注入脚本**。

**根因**

`inject-main.js` 是页面注入脚本（`document_start`，`MAIN` world）。
**重载扩展不会重新注入已打开的页面**——必须刷新标签页。

**解决方案**

写进「三条铁律」：

| 改了什么 | 必须做什么 |
|---|---|
| `background.js` | 重载扩展 |
| `inject-main.js` | **重载扩展 + 刷新标签页** |
| `popup.*` | 重开弹窗（popup 是扩展页面，不用刷新网页） |

**反向坑（第二次踩）**

只 `Page.reload` 不 `Extensions.loadUnpacked` 也不行——页面里仍是旧注入脚本，
因为扩展本身还是旧代码。

**教训**

1. **「改了但没效果」的第一嫌疑永远是「没生效」，不是「改错了」**。
   先用探针确认页面里跑的是哪个版本，再怀疑逻辑。
2. **扩展的三种文件有各自的生效方式**，混起来就会反复踩坑。
3. **看 state 条数比看代码更早发现问题**。state 只剩 4 条 other 就是没注入成功。

---

<a id="d-002"></a>
## #d-002 · 2026-10-18 · 全量测试与 CI

**问题**

本地全绿，CI 在 Windows runner 上却挂。

**排查**

```
UnicodeEncodeError: 'charmap' codec can't encode characters in position 41-42
```

GitHub 的 Windows runner 默认用 **cp1252** 解码 stdout，而每个测试脚本都 `print` 中文。

本地复现：`PYTHONIOENCODING=cp1252 python test/library_dir_test.py` → 精确重现。

**解决方案**

`run_all.py` 给子进程设 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`，
本进程也 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`。

**还修了一个 flaky**

`host_merge_test.py` 偶发 FAIL「worker 成功后同样删除源流」——
它只看产物出现就断言源流已删，而 worker 的 `unlink` 在写完成状态之后（几毫秒窗口）。
改成轮询 10 秒窗口后连跑三次稳定 PASS。

**教训**

1. **本地全绿不代表 CI 绿**。编码、路径、时区、文件名大小写都是环境差异。
2. **偶发失败不是「运气」**，是竞态。找到那个几毫秒的窗口，改成轮询/重试。

**涉及**：`test/run_all.py`、`test/host_merge_test.py`、`.github/workflows/tests.yml`

---

<a id="d-001"></a>
## #d-001 · 2026-10-18 · 仓库初始化与上传 GitHub

**问题**

用户要把项目上传 GitHub，但网络登不上；且目录里有不该进仓库的东西。

**排查与处置**

| 项 | 体积/性质 | 处置 |
|---|---|---|
| `bin/ffmpeg.exe` + `ffprobe.exe` | **323 MB** | 不进仓库（GitHub 单文件上限 100MB） |
| `keys/private_key.pem` | 签名私钥 | 不进仓库，`.gitignore` |
| 40+ 个 `cdp_*.js` / `bench_*.js` | 调试脚本 | 清理 |
| `native-host/host_manifest.json` | 含本机绝对路径 | `.gitignore`，提供 `.example` |

**网络诊断结论**

- `api.github.com:443` ✅ 通
- **`github.com:443` ❌ TLS 握手失败**（`schannel` 拒绝）
- `github.com:22` 与 `ssh.github.com:443` ✅ TCP 通

结论：**不是 GitHub 登不上，是 443 被针对性阻断，SSH 通道可用**。改用 `git@github.com` 即成功。

**文档拆分**

用户问「HANDOVER.md 这个不是交接文档吗，不需要上传吧」→ 判断为混合文档，
拆成：`DEVELOPMENT.md`（上传）、`HANDOVER.md`（本地、gitignore）。

**历史清理**

`PUSH_TO_GITHUB.md` 含公钥与网络诊断，用 `git filter-repo` 从全部历史移除，
并把 `C:\Users\l\...` → `<HOME>`、`WorkBuddy` → `WorkArea`。

**踩坑**

- **Git Bash 的 `/tmp` = `C:\Users\l\AppData\Local\Temp`**，Python 看不到 `/tmp/x.py`，
  必须 `cygpath -w` 换算。
- **正则里 `\/` 在 Python 会触发 `SyntaxWarning` 且反斜杠不匹配**，
  必须用 `chr(92)` 构造。
- **`git-filter-repo` 的回调必须是顶层语句**，写成 `def blob_callback()` 不生效。

**教训**

1. **「网络问题」要分层测**。域名级 TLS 失败 ≠ 整站不可达，SSH 和 API 可能都是通的。
2. **大文件绝不进 Git 历史**。一旦进去，清理成本远高于一开始就 `.gitignore`。
3. **文档要分工**。「交接给我的同事」和「给开源社区看」不是同一份东西。

---

## 写法约定

新增条目时请遵守：

1. **编号递增**，格式 `#d-NNN · YYYY-MM-DD · 一句话主题`
2. **四个必需小节**：`问题` / `排查` / `试过但失败的`（没有可省）/ `解决方案` / `教训`
3. **教训至少写一条**，且要具体（「要注意」这种不算，写清「什么时候会踩、为什么」）
4. **涉及文件**列在最后
5. 在顶部索引表加一行
6. **`DEVELOPMENT.md` 的结论段落要链回这里**：`详见 [d-NNN](#d-NNN)`
