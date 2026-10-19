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

---

## 索引

| # | 日期 | 主题 | 一句话结果 |
|---|---|---|---|
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
