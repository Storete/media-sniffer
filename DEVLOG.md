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

## d-074 · 2026-10-24 · 真机白屏：B27 UI 只落了一半——「测试全绿」和「能用」之间隔着一条渲染路径

### 现场

用户 51cg1.com 截图：计数正常（视频 1 / 图片 71）、筛选「视频 1」后**列表区纯灰**
（连空态提示都没有），「检测本地下载器…」卡住。当时 JS 全量 1153 项全绿、
真机首验四项全过——「测试全绿」与「能用」同时成立，问题在哪？

### 复现与定位

headless 复现两次失败（popup 作为普通 tab 打开时 `tabs.query({active,
currentWindow})` 拿到的是 popup 自己，构造不出用户场景）。换路：**从 SW 的
内部 state 直接抓 51cg1 的真实条目（185 条），用 chrome 桩 + vm 加载 popup.js
跑完整 `load()`**——第一条就抛 `timeRangePick is not defined`（renderItem →
renderList → load），复现成立。

### 根因：一个多轮编辑事故

B27 UI 的修改经了多轮 heredoc/转义失败与重试，最终状态是：**渲染块
（`tr.value = timeRangePick.get(...)`）落了，`const timeRangePick = new Map()`
声明没落**——引用了不存在的变量。它只在渲染 video/audio 条目时触发：
popup_wiring 的 76 项全是**源码正则断言**（「有这个字符串」），不执行渲染；
run_js 的 1153 项里没有 popup 渲染路径。全绿是真实的，全绿是没用的。

### 修复（两层）

1. 补声明——B27 UI 恢复完整；
2. **renderList 加兜底**：渲染抛错时列表区显示「列表渲染出错：{message}，
   请截图这行字反馈」——用户从「无从报告的空白」变成「一句话的证据」。
   replaceChildren 在行构建前清空是白屏的机制，兜底必须在同一个函数里接住。

### 流程教训（比 bug 本身值钱）

- **「测试全绿」的覆盖范围要说得出**：popup_wiring 是接线检查不是行为检查；
  渲染路径零运行时覆盖，任何 UI 刀都可能在全绿下白屏；
- **补上这块覆盖**：回放 harness 收编 `test/replay_51cg1.js`——真实条目
  （SW state 抓取）+ chrome 桩 + vm 跑 popup 的 load 全链，筛选/渲染全走。
  数据文件在 %TEMP%（用户再报 popup 问题时：SW 抓 state → 跑 harness →
  直接看抛错）。不进 run_all（依赖数据文件），但每次动 popup 渲染都该跑；
- 多轮编辑（heredoc 转义地狱反复重试）后必须**整体重读落盘结果**，
  「改过」不等于「改对了」——这次的半落盘就是三轮 heredoc 失败后的残留拼图。

### 数字

popup.js：补声明 2 行 + renderList 兜底 12 行；manifest → **1.3.63**；
replay harness 入库；JS 全量 1153 项不变（harness 不带 .test 后缀不进 CI）。

## d-073 · 2026-10-24 · B27 ③层：自实现 HLS 按分片截取——省流量的最后一块

### 起点：推送后继续做（剩余唯一可离线开发的项）

②层（yt-dlp --download-sections）已落地，但产品里 **HLS 默认走自实现链**
（run_hls_self）——它不吃 sections，timeRange 在最常用的 HLS 场景其实不生效。
③层补上：自实现链按 EXTINF 时间轴挑分片，只下覆盖区间的部分。

### 实现（三段，全部最小牵动）

1. **`_parse_extinf_durs(text)`**：清单正文 → 每片时长。不改动
   parse_hls_playlist（它服务 20 处调用方 + fuzz 不变量）——独立轻量解析，
   EXTINF 正则天然跳过 MAP 等标签行。调用方校验 `len(durs) == len(segments)`，
   **不齐就放弃选片整段下**——诚实降级永远是对的兜底。
2. **`select_segment_window(durs, tr)`**：覆盖式选片（时间轴 >= start 的第一片
   到 >= end 的第一片）。end 超总长**钳到最后一片**（「下到结尾」是常见意图）；
   start 超总长 → None（整段下）。
3. **run_hls_self 接线**：选中窗口后只下那几片（write_status 说人话
   「只下第 x-y 片」），remux 段按剩余偏移 `-ss/-t` 精切——分片对齐保证省流量，
   精切保证起点准。notes 进收尾文案。

### 测试折出的两条

- **夹具错误自查**：假分片（G 填充）被验证四层的真 ffprobe 正确拒收
  （VERIFY_MISMATCH）——换真 ffmpeg 生成的 TS 等分 5 片后，**顺带发现测试清单里
  放 `#EXT-X-MAP` 是我自己造的错**：TS 流没有 MAP，init 段（ftyp 头）拼进 TS
  开头 ffprobe 必然打不开。夹具要贴真实世界的清单形态，不是「越多标签越全」；
- **临时目录生命周期**：[2] 段 finally rmtree 的 tmp 被 [3] 段复用——
  跨段共享目录要么各自建要么 makedirs(exist_ok=True)。

### 数字

- `host_timerange_test` 24 → **35 项**：EXTINF 解析 + 选片边界 7 项、
  **本地 HTTP 服务器请求计数集成**（真 TS 分片、断言只请求 seg1-3）3 项；
- 反向验证：选片逻辑失效 → 「只请求选中分片」红（请求了全部 5 片）；
- 干净副本 **27 通过 / 2 跳过 / 0 失败**（工作区内 5 套已知沙箱假红集合不变）；
- 版本 1.3.62 不变（同版本第二刀）。

## d-072 · 2026-10-24 · 真机首验四项全过——外加三条探针基础设施的教训

### 结果（headless Chrome 真实加载 1.3.62、真实下载链路，四项全绿）

| 功能 | 判据 | 结果 |
|---|---|---|
| ① 保存直下 | 页面无 `__ms_sniffer_overlay` + 文件真实落盘 | ✓ 不弹浮层；`ms-probe-direct.mp4` 73821 字节落在「文件存放处」 |
| ② 诊断按钮 | ms:diag 数据链路 | ✓ 回包带 version 1.3.62 + 内部错误数组 |
| ③ 整页解析 | 任务打到宿主 | ✓ native:download-page 受理 → jobs 状态文件出现（本地页被 yt-dlp generic 下载成文档，done 无害） |
| ④ 时间段截取 | 见下节 | ✓✓ 两半各自证实 |

### ④ 的两半：能力证实 + 边界如实确认

- **产品链**：本地 HLS + timeRange 跑产品 downloader → done（自实现 HLS 链整段下）
  ——B27 方案的③层（自实现链按 EXTINF 挑分片）本来就是未做的边界，如实确认；
- **yt-dlp 链能力**：同一条 HLS 直喂 yt-dlp `--download-sections "*1-3"` →
  **ffprobe 实测产物 2.000 秒**，精确。②层在 yt-dlp 链上的能力没有疑问
  （真实触发场景 = 整页解析 + 非 m3u8 的 yt-dlp 能解析的站）。

**踩出一条上游边界**：无扩展名裸直链 + generic extractor 时，yt-dlp 的
sections 输出名是 `file:xxx.unknown_video.part`——ffmpeg 推断不出输出格式
直接报错（`Unable to choose an output format`）。真实场景（HLS/DASH/
带扩展名直链）不踩；未做特判，记在这里。

### 三条探针基础设施的教训（下次做真机自动化直接复用）

1. **profile 必须每次清空**：`Extensions.loadUnpacked` 对同 ID 的已装扩展
   静默跳过——复用旧 profile 时 SW 跑的是上一版代码，新 case（ms:diag）
   落进 default 分支，症状是「回包 unknown message」，极易误判成代码 bug；
2. **match pattern 不支持端口**：`*://127.0.0.1:18080/*` 是非法 pattern，
   `chrome.tabs.query` 挂死（callback 不回、异常不出）——全量 query 后
   JS 侧过滤才是对的；
3. **SW 的 sendMessage 不回环给自己**：SW 里验「消息处理」要么直调函数
   （top-level 函数声明就是 globalThis 属性），要么从 popup/页面发；
   另外 CDP WS 的响应要按 id 匹配——keep-alive 线程和主流程并发 evaluate
   会让响应交错，diag 读到 ping 的 `1`。

### 数字

探针（TEMP，不入仓库）；本地素材 ffmpeg 生成（mp4 + 2 段 HLS + 页面）；
验证全程产品代码零改动，版本保持 1.3.62。

## d-071 · 2026-10-24 · B27 UI 接通 + 诊断包 + 空态「粘贴链接」——§6 产品件清掉两件

### 三件小活，一个共同点：都是「等到了前置条件」的动作

- **B27 UI**：宿主侧（parse_time_range + --download-sections）1.3.61 已就绪，
  本刀补 popup 的「时间段」输入行（video/audio 且非直播条目行内，placeholder 给
  格式示例；直播没有绝对时间轴，不显示），native:download 透传。合法性与
  「非法=整段下」的兜底全在宿主（测试钉住）。
- **诊断包**：footer「诊断」按钮 → `ms:diag` 汇总（版本 + 内部错误日志）→
  popup 组装进剪贴板：扩展版本、页面（脱敏）、条目统计、抓取诊断（diagText
  原有）、最近 5 条下载记录（含错误码——errcode 表的 15 个码在这里第一次
  系统性露出）、内部错误（URL 域名化脱敏：留 origin + 两段路径，**去查询串
  ——里面常有 token**）、本地引擎状态。§6 原话「降低支持成本的唯一杠杆」。
- **空态「粘贴链接」**：§6 三动作之一，之前一直没做是因为没有实体——
  「粘贴一个链接」然后呢？B28 落地后答案出现了：连本站 cookie 交给本地
  解析器（native:download-page）。**前置条件到位的功能才值得做**。
  「打开示例」暂缓：需要挑一个长期稳定、不构成站点推荐的示例页。

### 测试

popup_wiring 71 → **76**：诊断按钮存在/接线/ms:diag 双端/脱敏口径、
粘贴链接入口/native:download-page 双端。JS 全量 **1153 项 / 20 文件 / 0 失败**。

### 顺带

B27 的 host_timerange_test（24 项）补齐——1.3.61 提交时宿主侧实现已在但测试
没跟上（被保存直下打断），本次一起入库：纯函数 17 项（三形态归一/非法 None/
start≥end）+ FakePopen 接线 7 项（合法区间带参数、**非法区间零参数且任务照常
完成**——用户手滑不该变成整单失败）。纯秒归一最初漏了换算（"60" 原样进秒位），
测试第一轮抓出来。

**记录**：S6 发版三件（PRIVACY/DISCLAIMER/RELEASE/make_release.py）确认已随
「暂不发行」决定被移除（1.3.57 的交付不再在仓库里）；本刀不动它们，恢复等发版决定。

## d-070 · 2026-10-24 · 保存直下：删掉「保存媒体」确认浮层——一个为已消失的约束服务的 UI

### 起点：用户截图两张

「图一点保存或下载后，直接开始下载，不必弹出图二」。图二就是那个页面内
「资源嗅探 · 保存媒体」浮层：popup 点保存 → 页面弹卡片 → 再点「保存到本地」
才开始下。用户说得对——这是**每存一张图都多点一次**的仪式。

### 浮层为什么曾经存在，又为什么该删

overlayShow 的注释写着「让用户的手势落在按钮上」。这是真实的约束：**当年**
blob 保存走 `<a download>` 模拟点击，没有用户手势会被 Chrome 拦，浮层的按钮
就是手势来源。但 1.3.x 里 blob 保存已全部改走「页面 fetch → Native Host」
（消息驱动，真机证据 tg-probe.mp4 落对目录那次重构），浮层的存在理由**已经
消失了**，只剩确认仪式。为已消失的约束服务的 UI，就是纯摩擦。

### 改法

删 overlayShow/overlayOpen/overlayClose/闭包 queue+runQueue+runSave 整段
（约 170 行），换模块级三件：

- `saveQueue` + `runSaveQueue()`：串行队列原样保留（Range 链一次一条），
  但从「每次开浮层重建」改成模块级——顺带修掉一个潜在缺陷：原来浮层关了
  队列状态就丢；
- `dispatchSaveItem(it)`：原 runSave 正文去掉浮层收尾，per-item 分派
  （B 站接管 → Range；blob → Range；m\d+ → doSaveMse；其余进队列）。
  **顺带修正**：原批量路径把所有条目无差别 push 进队列，MSE 条目
  （m\d+）在批量里会走错通道——现在统一走 per-item 分派；
- `beginSaveBatch` → 逐条 dispatch + runSaveQueue。

MSE 条目仍走 downloadBlob 的 `<a download>`：同源单个 blob 的程序化点击
Chrome 不拦，真机如有拦截反馈再单独处理（已写在代码注释里）。

**保存中反馈不变差**：startMediaDownload 自带页面内进度卡（d-040 的 UI，
带取消按钮），直下后它立即出现——用户看到的不是「没反应」，是进度条
直接开始走。popup 任务区/下载记录照旧。

### 测试折出来的一条：什么叫「保存已开始」

main-hook 的断言最初想用「host-send 已发出」当直下证据，实测为 0——
fake fetch 没配 Range 流，链路停在第一步。可观察的证据是产品自己发的
`progress` 事件（进度卡阶段消息）：**测「开始了」要找产品发出开始的信号，
不是测下游走了多远**。

### 反向验证（2 组全红）

① beginSaveBatch 里重新弹浮层 → 「不再弹确认浮层」2 红；
② blob 分支退回 doSaveBlob → 「[BLOB] 走 startMediaDownload」2 红。

### 数字

- inject-main.js 净 -160 行；main-hook 194 → **196**、site_registry **103**
  （三处浮层断言改为分派断言）、JS 全量 **1146 项 / 20 文件 / 0 失败**；
- 版本 1.3.60 → **1.3.61**（extension：inject-main.js + manifest）。

## d-069 · 2026-10-24 · B28 落地：整页解析——cookiejar 链路 + 两个入口，测试顺手钉住「cmd 批处理转发 % 会炸」

### 起点：d-068 判 GO，用户拍板「你自己决定，彻底解决问题」

半天刀按计划落地。四个文件各改一层，全部复用既有链路：

- **downloader.py**：`write_cookie_netscape()`（chrome.cookies 结构 → Netscape 七列；
  hostOnly 决定加不加"."前缀、会话 cookie 给远期时间——写 0 会被 jar 当过期丢掉、
  带制表符的坏行跳过）；`run_ytdlp` 拆成薄壳（try/finally 管 cookie 临时文件的
  生命周期——文件里有登录态，**每条退出路径都必须删**）+ `_run_ytdlp` 主体；
  有 cookie_file 时抑制 legacy `--add-header Cookie:`（两份同源 cookie 同发，
  一部分 CDN 因重复头直接 4xx），Referer/Origin/抓到的请求头照常。
- **background.js**：`native:download-page` 消息（页面 URL + `chrome.cookies.getAll`
  全量结构化导出；jar 形态在手就不发 header Cookie）；右键菜单第四项
  「用本地解析器下载此页」（contexts:["page"]，B29 当初留的位子）。
- **popup**：footer「整页解析」按钮——「插件列表抓不全的站」的兜底入口，
  chrome:// 页面有拦截提示，失败落下载记录。

### 测试折出来的两条

**① cmd 批处理转发会二次解析 %。** 集成测试最初想用 .bat 包装真进程的假 yt-dlp：
`--progress-template` 的参数含 `%(progress...)s`，经 `%*` 展开后 cmd 重扫出坏变量
引用，实测报「'%' 不是内部或外部命令」。这是批处理的本质缺陷不是产品 bug——
测试改用 FakePopen 捕获 cmd 列表（要验证的参数构造与文件清理完全覆盖）。
教训记下：**以后任何「经 cmd 转发的参数含 %」的场景都要先想这一层**。

**② 薄壳 try/finally 的位置。** `_run_ytdlp` 主体有 6 个 return 点，让每个都记得
删登录态文件不现实；拆 `run_ytdlp`（壳，管生命周期）+ `_run_ytdlp`（主体，不动）
零重排完成，且异常照常穿透（测试 2c 钉住「删了文件且异常没被吞」）。

### 反向验证（3 组全红）

① 抑制 legacy header 的逻辑去掉 → 「argv 不含 Cookie:」红；② finally 清理去掉 →
「临时文件用完即删」等 2 红；③ page 菜单分支不导出 cookie → 「结构化数组」红 2。
（第一组变异还顺带暴露过测试自身的问题：cookie 文件在读之前就被 finally 删了——
改由 FakeProc 构造时当场读；异常穿透被吞过一次——补了 raised 断言。）

### 数字

- 新增 `test/host_cookie_jar_test.py` **24 项**（run_all 自动发现）；context_menu
  19 → **26**（第四项 + page 流程）；popup_wiring 71 → **76**（pageDl 五断言）；
- Python 干净副本 **26 通过 / 2 跳过 / 0 失败**（工作区内跑仍有已知沙箱假红 5 套，
  集合与改动前一致）；JS **1145 项 / 20 文件 / 0 失败**；
- 版本 1.3.59 → **1.3.60**（extension 四文件 + downloader.py）。

## d-068 · 2026-10-24 · B28 可行性一小时：页面 URL → yt-dlp 的「传递层」设想成立，GO

### 裸验三步（不经扩展，按 B28 既定判据）

**① Netscape 转换器写通。** headless Chrome 访问 B 站视频页 → CDP `Storage.getCookies`
（等价扩展侧 `chrome.cookies.getAll`）→ 七列 tab 分隔 + `# Netscape HTTP Cookie File`
头 → yt-dlp `--cookies` 照单全收（回显服务器见 cookie 到达）。B28 拦路石的前半句
「没有 Netscape 格式的 cookie 文件」从此不成立——转换就是十几行。

**② 页面 URL 直接喂 yt-dlp。** B 站视频页 URL、零站点适配、零扩展改动：
`yt-dlp --simulate <BV 页>` 直接提出 title + 1080p 格式。「1800+ extractor 接管解析，
扩展退化成凭据 + URL 传递层」的设想**机械成立**。

**③ cookie 形态判别（本地回显服务器 + generic extractor）。** 同一个 URL 两种形态：
`--add-header Cookie:` 与 `--cookies` 的请求**都带上了 cookie**（2026.08.19 版 yt-dlp
没有封 header）——传输层分不出胜负。但机制上 `_get_cookies()` 读的是 `self.cookiejar`
（只有 `--cookies` 填充），extractor 内部自建 API 请求时 header 形态不可编程读取。
**B28 原判断成立：产品应切到 `--cookies`**。现状 `downloader.py:704` 注释自认
「我们没有 Netscape 格式的 cookie 文件，只能把整条 Cookie 头递过去」——该理由已失效。

### 探测边界（如实记）

抖音对 headless Chrome 直接弹**验证码中间页**，匿名裸验做不了。但这只是探测手段的
局限：产品路径用的是**用户真浏览器**的 cookie（大概率已有 ttwid/登录态），
B25 的「C 方案半天」估计维持不动。

### 结论

**GO**。落地 = 扩展 `chrome.cookies.getAll({url})` → Netscape 写临时文件 → job 传
`cookiesFile` → downloader 传 `--cookies`（与现有 header 路径叠加，用完删文件），约半天。
是否排期（在 B25 之前做，直接决定 B25 是半天还是两天）**留给用户拍板**——本刀只交可行性。

## d-067 · 2026-10-24 · B29 右键菜单：指哪打哪，测试顺手抓到一个「picture 优先级写反」

### 起点：T-D3，方案两年前就定了

DEVELOPMENT B29 的设计（用户 2026-10-23 提出）已把难点写死：**右键替代不了名称优化，
替代的是「在几百条里找那一条」**——电商/图文页 316 张图的场景，右键点哪张下哪张。
硬边界也早写死：MSE 站 `<video>` 的 src 是 blob:，右键对抖音/B 站播放器无效，
那不是菜单能救的。本刀按既定方案落地，范围砍掉「解析此页」项（B28 未排期，
不注册一个点了空转的菜单）。

### 四处各改一层，全部复用既有链路

- **manifest**：+`contextMenus` 权限；
- **background**：onInstalled 注册三类菜单（contexts 自然分流）；onClicked 里
  srcUrl 可用直接走 `startNativeDownload`——popup 同一条链，下载记录/错误码/
  续传/超时重试全自动有；blob/空地址才回页面问（`ms:ctx-get`，800ms 超时降级）；
  问不到**不静默**：右键没有 popup 可看，失败原因必须落在下载记录里（notifySaved）；
- **content.js**：转发 ctx-get（纯搬运层，10 行）；
- **inject-main**：`contextmenu` 的 **capture** 阶段监听（菜单弹出前记录，
  站点 stopPropagation 拦不掉），解析真实地址：currentSrc→src→picture
  `<source>`→srcset 最大候选→懒加载属性（data-src/data-original/data-lazy-src）
  →背景图（getComputedStyle）。记录带 60 秒时效，右键后干了别的就不给陈旧答案。

### 测试抓到的真缺陷：picture 优先级写反

`msPickSrcset` 的注释写「`<picture>` 的 `<source>` 优先级高于 img 自身」，
但调用顺序是 `el.currentSrc || el.src || msPickSrcset(el)`——有 src 就根本
不看 picture。而 `<picture>` 场景下浏览器**实际渲染的是 `<source>` 的候选**
（通常是更大的 webp/avif 变体），img.src 只是 fallback。结果：右键下载拿到的
常常是降级格式。修法：`msPickSrcset(el) || el.currentSrc || el.src || ...`。
ctx_pick 测试的「picture 的 source 被选中」一条先红后绿，钉住这个顺序。

### 反向验证（4 组变异，全红）

① 解析器丢懒加载兜底 → data-src 断言处崩（exit=1，红的正是那行）；
② srcset 不取最大候选 → 1 红；③ 背景页去掉问页面降级 → 1 红（ms:ctx-get 消失）；
④ blob 失败不写记录 → 2 红（失败记录消失）。

### 数字

- 新增 `test/context_menu.test.js` 19 项（注册/直下/blob 降级/双 blob 不静默/
  超时降级/link 菜单）+ `test/ctx_pick.test.js` 16 项（五类元素形态 + 命名链）；
- JS 1098 → **1133 项 / 20 文件 / 0 失败**；CI 接入两套；
- 版本 1.3.58 → **1.3.59**（`extension/`：manifest / background / content /
  inject-main 四文件）。

## d-066 · 2026-10-24 · T-C10：主清单地址不再混进 variants——判据是现成的，难点在双跑口径

### 起点：挂了三轮的账

d-058 就写明「会话的 tracks[].variants 里混进了主清单自己的地址，留给 S3 一起处理」，
S3 早就做完了它还挂着。影响：S1 的选档数据里有一条没有分辨率的假档位；
未来任何按 variants 消费的逻辑都会把它当成可直下的媒体流。

### 为什么比看上去小，又比看上去险

**小**：判定主清单的能力 1.3.45 就有了——hls-meta.js 解析清单正文，applyHlsMetaTo
把 `listKind:"master"` 打在条目上且随 storage 持久化。修复就是在会话层用它。

**险**：直接排除会破坏双跑——旧模型 items 里有这条合法条目，新模型 variants 没有
它，msDiffSession 立刻报 missing，T-E2 刚验证过的「shadow 恒绿」每天假红。
所以两端必须**同一个判据**（`isMasterListEntry`，共享函数）：构建端排除、
比较端豁免并计入新计数 `masterSkipped`。它不是 missing（popup 列表条目原样保留，
点它宿主仍会选默认档下载——旧模型的能力一条没少），也不是 dropped（那条在旧模型
是合法存在）。

**保守边界**：只有 `listKind==="master"` 才排除；没有元数据（webRequest 先到、
清单正文还没读到）**不凭 URL 形状猜**——它可能只是还没证据的普通媒体。代价是
「只抓到 master 的页面」variants 为空、kind 落 unknown——诚实的空比假档位好，
且用户仍可从 popup 列表点那条 master 下载。

### 反向验证（三组变异，各红各的）

- A 构建端不排除 → **4 红**：假档位回归 variants、双跑 ok 变 false、「只剩 master
  时 kind 误判 video」（最后这条红的正是「假档位让会话把清单页当成视频页」）；
- B 比较端不豁免 → **2 红**：master 进 missing、双跑假红；
- C 判据漂移（两端判据不一致）→ **4 红**：共享函数存在的意义，漂移立刻暴露。

### 数字

- `session_shadow` 49 → **56 项**（[9] 段 7 项：排除/保留/masterSkipped/无元数据
  边界/只剩 master）；JS 全量 1091 → **1098 项 / 18 文件 / 0 失败**；
- 无头真机复验（`tools/verify_headless.py --pages`）：B 站首页 + 视频页 shadow
  仍 `ok:true`；
- 版本 1.3.57 → **1.3.58**（产品代码 `extension/session.js`）。

## d-064 · 2026-10-24 · 真机验证自动化：headless Chrome + CDP 把 E 组打穿大半，顺带把 ffmpeg 拦截的新形态钉死

### 起点：「你去做真机验证」

E 组六条原来全在等用户手点。盘点后发现大头其实可以在本机自动化：headless Chrome
能加载未打包扩展、Service Worker 能被 CDP 直连评估——不依赖登录态和 popup 交互的
判据全部可跑。唯一的坎：Chrome 137+ 的 branded Chrome **移除了 `--load-extension`**，
本机 156 走官方留给自动化的通道 `Extensions.loadUnpacked` + `--enable-unsafe-extension-debugging`。
python 没有 websocket 库，CDP 客户端手写（RFC6455 文本帧 + mask，~70 行），
工具收编为 `tools/verify_headless.py`（`--sw` / `--pages` 两个子命令，全部稳定复现）。

### 结果（全部走产品代码，零测试桩）

| 判据 | 结果 |
|---|---|
| T-E1 SW 内 `typeof MSSession === "object"` | ✅ 1.3.57 的 SW（background.js）里为 object，三个方法全 function |
| T-E3 items 回放喂 `msBuildSession` | ✅ SW 内喂真形态 items：sid 非空（d-058 的「沙箱缺 URL 静默空串」在真 SW 环境不存在——那本来就是测试环境的病）、xhs-cover 正确分离、正文图收进 images、m3u8 进 tracks |
| T-E2 双跑字段级等价 | 🔄 **两页过**：B 站首页 + 视频页（从首页 DOM 取的真实 BV，非写死 URL）`ms:shadow` 均 `ok:true`；首页 kind 判 `image-set`、视频页判 `video`（3 video + 1 audio + 4 seg = DASH 双流形态） |
| T-E4 真页面行为 | 🔄 大头过：真抓取、折叠、列表、`sniff:get` 全链路在真页面活；剩 popup 交互细节随日常使用 |
| T-E6 选档产物宽高 | ✅ x36xhzz 真流（5 档）job 传 `variant:"720"` → 产品整链 → **ffprobe 实测 `h264,1280,720`**（不是默认的 1080 档），634.6s 完整，状态文件 `quality:"1280x720"` 与产物一致 |
| T-E5 ffmpeg | 🔄→实质达成（见下节） |

### T-E5 的曲折：拦截形态变了，结论反而更硬

本来的预期是复现 d-056 的「bin/ 内 exe 启动即崩」。实际：

1. 拷到 TEMP（无标签）跑 `-version` → 成功，合并验证（`run_merge` **同款命令行**）
   → 退出码 0，ffprobe 确认产物 h264+aac 双轨；
2. 跑**产品本体**下真实多档流 → done，但 remux 报 `Error opening output files: Permission denied`；
3. 控制变量逐一排除：不是时序（大文件刚写完立即 remux 成功）、不是 `CREATE_NO_WINDOW`、
   不是 cwd（项目目录内派生成功）、不是后台进程树、不是脚本文件位置——全都成功；
4. 真因：`find_tool` 返回的是 **bin/ 里的 ffmpeg**（它今天**能启动**了，`tool_runs`
   探测通过——d-056 的「启动即崩」不再成立），而 WorkBuddy 对**源自低完整性标签目录
   的 exe** 拦写盘。定案实验：bin/ 与 TEMP 两个位置的同款 ffmpeg 跑同一条写盘命令，
   前者 `Permission denied`、后者成功——拦截按 **exe 所在目录的标签**，与启动方式无关；
5. 产品行为完全正确：`find_tool` 优先 bin/（真机上就该用它）、remux 失败按设计降级为
   「TS 完整可播 + 原因可见」（done 100 + 一句人话），降级路径真实工作了一次。

**结论**：T-E5 的实质（同一 ffmpeg 文件能启动、能合并、能转封装）已验；「bin/ 位置
的写盘」被沙箱拦是本机假象，真机无此标签。用户剩一次日常点击复验即可关条目。

### 顺带

- 手动同款 remux 把 170MB 真实 TS 转成了 mp4（HLS 转 mp4 能力本体证实）；
- E 组表格顶部加了说明与工具入口，T-E2 剩的第三页（小红书/TG）需要登录态，
  headless 做不了，改判据为「用户日常使用时观察 shadow 恒绿」；
- 本刀只动 `tools/` + `docs/`，产品代码零改动，按 AGENTS 例外条款**不升版本**
  （保持 1.3.57）。

## d-063 · 2026-10-24 · 规则库落地：模板 + CI 门禁 + 六条真实案例；顺带把「本机全量假红」的根因钉死在沙箱标签上

### 起点：T-C7 剩下的另一半

解释库（自动通道）1.3.55/1.3.56 已全部落地，剩下交接文档（`HANDOFF-T-C7-规则库.md`）
点名的三样：`docs/compatibility/` 目录 + 模板、CI「每条启用规则必须有测试引用」门禁、
从 DEVLOG 回填真实案例。交接文档还留了两条纪律：**先立门禁再填案例**（空库也要能绿）、
**不是每条 DEVLOG 都配进 compatibility**（收「用户会撞见的失败模式」，不收「我开发时的坑」
——所以 d-052 测试脚手架、d-054 诊断链路这类内部笔记没进来，进来的是 d-047 和 B6~B11）。

### 三个决定

**① 门禁验的是「解析出路径 + 文件存在」，不是「有『测试』两个字」。**
d-052/d-058 的教训是假绿比真红更危险——一句「见 sanitize 测试」的门禁等于没设。
所以 `tools/check_compat_rules.py` 把「测试引用」拆成 token（`test/xxx_test.py` 形态
正则 + 禁 `..` 穿越 + 在 `test/` 下真实存在），缺一步就红。

**② 空库绿，模板豁免。** 「还没攒够真实失败」不是错；卡死所有提交的门禁第一天就会
被人绕掉。豁免按**精确文件名**（`README.md`、`000-template.md`），不给通配——
别的文件一律必须有合法 frontmatter，解析不了是红不是跳过。

**③ 已停用的案例允许引用留空。** 规则停用常常正因为站方改版、它钉的测试已经删了，
这时候要求引用存在反而做不到。但写了引用就验存在性——「停用」不是「随便写」。

实现细节里藏了一条自家教训：门禁自己用 `utf-8-sig` 读案例——d-047 刚抓过 BOM 让
首行匹配不上的坑，不能在门禁身上复发（测试里专门有一条带 BOM 的好案例必须绿）。

### 六条案例（全部「现象+复现+根因+修复+测试引用」齐全，引用逐一验真）

| 案例 | 失败模式 | 来源 | 引用 |
|---|---|---|---|
| 001 | 文件名边界：超长扩展名建不出文件 / 全角空格不幂等 / 尾随脏字符 | d-047（B30） | sanitize_test |
| 002 | 带 BOM 的 m3u8 首行被当成第一个分片 | d-047（B30） | sanitize_test |
| 003 | 同标题媒体不聚拢 / blob 不能预览 | B6 | group_key |
| 004 | 编号对不上内容（编号做在滤网前 / 跨消息跳号） | B7+B8 | focus_scope + group_key |
| 005 | 焦点收窄从未生效 / 上报丢一次永久失效 | B8 | focus_scope |
| 006 | 封面横幅混进正文（错抓比漏抓重的典型） | B9/B10/B11 | background |

转录时每条都逼自己回答「根因是什么因果」——写着写着发现 B7 和 B8 是同一个洞的两层
（时机错 + 排序错），B9/B10/B11 是一个失败模式的三个站点形态，各收一条而不是三条。

### 反向验证（门禁自身被 25 项测试钉住，`test/compat_gate_test.py`）

空库绿 / README+模板绿 / 好案例绿 / 全角冒号绿 / **带 BOM 绿**；
无引用红 / 引用写人话红 / 引用不存在红 / 多引用坏一个红 / `..` 穿越红 /
引用指向 test/ 外红 / 停用+坏引用红；状态表外值红 / 缺字段红 / 缺小节红 /
空小节红 / id 与文件名不一致红 / 无 frontmatter 红（不是静默跳过）/ 目录不存在红。

过程里测试自己先抓了我一次：「已停用允许引用留空」最初被必填字段一刀切死——
这正是「停用案例」的真实形态，改门禁不改判据。

### 意外收获：把「本机全量 5 红」钉死在沙箱标签上

收尾跑全量，Python 出现 **5 套假红**（urllib 重试 / 续传指纹 / 分片重试 / 变体选档 /
伪装分片），症状全是「重试后该成功的场景拿到 error，成品文件不存在」。这刀没动
`native-host/` 和 `extension/` 一行，于是做因果切割：

1. `git worktree` 建干净 HEAD 副本 → 同样测试**全过**（失败与代码无关）；
2. 把本刀 4 处改动复制进副本 → **Python 25 通过 / 2 跳过 / 0 失败，JS 1091 项全过**
   （改动无害）；
3. `icacls` 对比：工作区根目录带 **`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`**
   （WorkBuddy 沙箱打的，T-E5 里 `bin/ffmpeg.exe` 起不来就是它），worktree 没有。

结论：**工作区目录内跑会起子进程/写盘的全量回归，本机会假红**——标签打了
`(OI)(CI)`，目录里新建的一切继承低完整性。真机与 CI（GitHub runner 无此标签）
不受影响。以后本机验「真绿」要么在 CI、要么在干净副本跑；T-E5 的备注已更新。

### 数字

- 新增 `docs/compatibility/`（README + 000-template + 6 案例）、
  `tools/check_compat_rules.py`（纯标准库）、`test/compat_gate_test.py`（25 项）
- `.github/workflows/tests.yml` 加「规则库门禁」一步（Python 矩阵内，纯离线）
- Python **25 套通过 / 2 跳过 / 0 失败**（干净副本验证；工作区内跑见上节假红）；
  JS 1091 项不变（本刀 `extension/` 仅 manifest 版本号）
- 版本 1.3.56 → **1.3.57**

### 没做完、留给后续

- 规则库的**后续案例**按准入三件套随真机失败逐条进（硬塞 = 造假规则库）；
- T-C7 的状态转 ✅（档位：自动化通过，案例真实度待真机），T-E2/T-E3/T-E5 等
  真机项不变。

## d-062 · 2026-10-24 · 解释库收尾：站点级建议从「拼进 message」改成独立字段，popup 单独一行展示

### 起点：d-061 遗留的「popup 侧展示没做」

d-061 把解释库的自动通道（记账 + 查建议）接到宿主 `poll_job` 失败收尾，但建议是
**拼在 message 字符串末尾**，扩展侧拿到的是一个把「这一次为什么失败」（describe 的
单次话）和「这个站为什么老失败」（解释库的站点级话）糊在一起的长句。popup 只能当
普通失败文案显示，既没有「已知问题」标题，也分不出哪句是本次报错、哪句是规律。

### 改法：结构化字段一路透传，不在字符串里做文章

一句话：「这一次为什么失败」和「这个站老失败」是两种语义，就该是两个字段，
不该拼成一个字符串再让下游用中文正则拆（那是 d-054 之前的老毛病）。

- **宿主**（`sniffer_host.py`）：失败收尾不再把 `advice["advice"]` 拼进 `final_msg`，
  改成独立字段 `advice`（怎么办）+ `adviceTitle`（已知问题标题）发出，二者成对
  （有 advice 必有 title，title 是「这个站的分片经常断」这类站点级定性）。
- **扩展**（`background.js`）：透传 `advice`/`adviceTitle` 进 `notifySaved`，
  存进 `session.history`（各截 120/40 字）和 `local.lastResult`。
- **popup**（`popup.js`）：失败记录里 `.h-why`（红、本次原因）之下，`.h-advice`
  （琥珀、站点级建议）单独一行，带 `<b>` 标题「{adviceTitle} · 」。用颜色区分：
  红=哪里错了，琥珀=这个站的老毛病。

### 反向验证（三组，全部当场红）

- 宿主丢 `adviceTitle` → **1 红**（「adviceTitle 成对出现」）
- 宿主退回「拼进 message」的旧行为 → **3 红**（message 保持原样 / advice 非空 / 建议是那条）
- popup 把建议并进 `.h-why` → **2 红**（popup_wiring 钉 `.h-advice` + `adviceTitle||"已知问题"`）

### 数字

- `host_knowledge_host_test.py` 第 3 段断言从「message 附建议」改成「advice/adviceTitle 独立字段」，
  仍 13 项全过。
- `native_done_history.test.js` 16 → **19 项**（+建议独立透传 / adviceTitle 透传 / lastResult 带建议）；
  `popup_wiring.test.js` 68 → **71 项**（+`.h-advice` 独立行 / 「已知问题」兜底 / CSS 琥珀整行）。
- JS 1085 → **1091 项**；Python 24 套通过 / 2 跳过 / 0 失败；版本 1.3.55 → **1.3.56**。

### 没做完、留给后续

- **规则库（人工通道）**：`docs/compatibility/NNN-slug.md` 模板 + CI「每条启用规则必须有测试引用」。
  这是 S5 的另一半，靠「用户报告 + 根因 + 可复现测试」三件齐全才准入，本就不该现在硬塞。

## d-061 · 2026-10-25 · 解释库：同站失败 3 次自动出建议，顺带抓到一个「学习功能先把自己锁死」的死锁

### 起点：T-C7 判据「同站失败 3 次自动出建议」

L4 知识库分两通道：解释库自动长（同站+同码 ≥3 次 → popup 给「已知问题+建议」），
规则库人工进（三件齐全才允许新增）。这一刀做解释库的**自动通道**，不碰规则库。

判据里最难的是「自动」两个字落哪。它不在「写一句建议」上——建议文案谁都会写，
在**「同站 + 同码」的归一化和「第 2 次闭嘴、第 3 次开口」的边界**上：
- `www.a.com` 和 `a.com` 必须算同站，否则同一个站两个 host 永远凑不够 3 次；
- 第 2 次就开口会把「两次偶发」吓成「这个站有问题」，延后等于白学。

### 三个决定

**① 全纯函数，持久化由调用方做。** `knowledge.py` 里 `site_key` / `fail_signature` /
`record_failure` / `explain` 全是输入数据、输出数据，不碰文件不碰网络。这样
「第 2 次 vs 第 3 次」的边界、site 归一化、跨站不串、跨码不串，全都能表驱动测，
不用真起下载、真写磁盘。

**② 失败记账放宿主，不放 worker。** worker（downloader.py）每任务一进程、短命，
记了也活不过下次；宿主（sniffer_host.py）常驻，是唯一适合「跨任务累计」的主体。
接线点选在 `poll_job` 的失败收尾：worker 写 `error` 状态 → 宿主轮询看到 →
`append_failure` + `failure_advice`，≥3 就把建议拼进发给扩展的 message。

**③ 只学失败模式，不学站点规则。** `FAILURE_MODES` 表里只有 `code`（失败模式），
没有站点字段；表外的码（如 DISK_FULL，是本机问题不是站点问题）累计够也不开口，
退回 `describe` 的单次建议。硬编一句万能建议，等于把「解释库」降级成
「每 3 次失败弹一句废话」。

### 挖出来的东西（测试抓到一个真死锁）

**`threading.Lock` 非可重入，`append_failure` 持锁后调 `load_failures`（它自己也加锁）
→ 直接死锁。** 讽刺的是这个功能的本意是「记账失败不该崩掉下载流程」，
结果它自己先把宿主锁死了。症状是 `poll_job` 挂住（SIGTERM），不是报错——死锁是
「挂」不是「红」，测试要设 `MS_JOB_TIMEOUT=5` 上限，否则未来有人把 RLock 改回 Lock，
测试会挂满 6 小时而不是快速失败。改成 `threading.RLock()`。

另一个细节：失败日志有坏行时 `load_failures` 要跳过坏行、保留好行——学习功能
永远不能因为「日志坏了一行」让下载流程崩掉（测试里专门塞了 `"这不是合法的 json"`）。

### 反向验证（纯函数 3 组 + 接线 2 组，全部当场红）

- 阈值 `EXPLAIN_AFTER=1`（第 1 次就开口）→ **5 红**
- site 不归一化 → **6 红**
- 签名不看码 → **3 红**
- `failure_advice` 恒 None → **2 红**
- `append_failure` 不记账 → **2 红**

### 数字

- 新增 `native-host/knowledge.py`（纯函数）+ 两个测试：
  `host_knowledge_test.py`（纯函数 52 项）、`host_knowledge_host_test.py`（接线 13 项）
- Python 24 套通过 / 2 跳过 / 0 失败；JS 无改动（1085 项不变）

### 没做完、留给后续

- **popup 侧展示**：现在建议拼在 message 里，跟「这一次为什么失败」是同一句。
  T-C7 完整的「popup 直接显示『已知问题 + 处理建议』」要单独一行（像 `.h-why` 那样
  独立展示），这属于 T-C6/T-C7 的 UI 部分，和「规则库 + CI」一起做。
- **规则库（人工通道）** 没做：`docs/compatibility/NNN-slug.md` 模板 + CI 校验
  「每条启用规则必须有测试引用」。这是 S5 的另一半。

## d-060 · 2026-10-25 · 规划表外置：把「这条为什么走 yt-dlp」从 if 里抠出来，变成能答、能测的数据

### 起点：L2-a 说「分派散落在各处 if 里，连你自己都难说清这条为什么走了 yt-dlp」

去核的时候发现，分派其实**没有散得到处都是**，它集中在 `main()` 一段内嵌 if 里：
`merge` → 地址校验 → `use_ytdlp` 判定 → `looks_like_hls_url` 优先自实现 → 否则 `run_urllib`。
问题不是「散」，是「**内嵌**」：这段逻辑没有名字、没有返回值、没法单独问一句
「这条地址会走哪条链、为什么」，要答只能靠人肉读完十几行 if 然后心算。

所以这一刀做的事很具体：**把这段 if 抠成一个纯函数 `plan_download(job, tools)`**，
返回 `{chain, reason, args, expect}`。

### 三个决定

**① `tools` 是入参，不是函数自己 `find_tool`。**
`use_ytdlp` 的判定依赖「有没有 yt-dlp」，而 `find_tool` 要真跑 `-version` 起子进程。
如果让 `plan_download` 自己去找工具，它就变成不纯的（依赖机器状态），
表驱动测试就得真装/真卸 yt-dlp 才能驱动「有/没有 yt-dlp」两种分支 —— 不可能。
把能力塞进 `tools` 参数，测试传 `{"ytdlp": "/fake"}` 就模拟「有」、
传 `{}` 就模拟「没有」，30 条用例跑起来零成本。

**② `reason` 是判据本体。** 判据写的是「『这条为什么走 yt-dlp』能答」。
能答不是「代码里能看出来」，是**运行时能问出来**。所以 reason 不止在测试里断言，
还进了 `main()` 失败时的 `trail` 第一项（`规划=...`）—— 三条路都失败时，
诊断包里第一行就是「当初为什么选了这条路」，以后查「这站为什么老走 yt-dlp 超时」
不用再翻代码。

**③ 分派顺序刻意固定成优先级，不是并列 if。** `merge > reject > hls/ytdlp > urllib`。
这一点原来就隐含着（merge 在最前、地址校验其次），但没人写下来，改了顺序就会
悄悄改变行为。现在 `plan_download` 的 docstring 把这条优先级明说了，
表驱动测试里也专门有一条「merge 优先级最高（即便给了 url）」锁住。

### 挖出来的东西

- **「reject」原来没有名字。** 相对地址/blob 那条 `if not re.match("^https?://")` 是
  一个「路由判断」，但它既不返回、也不命名，注释里还留着「等 T-C5 的规划表建好」。
  现在它成了 `chain="reject"`，是规划表的一个正规分支，不再是段注释里的 TODO。

- **`expect` 字段大部分是空的。** 规划表本该喂 `verify_product` 的产物验证预期
  （PRODUCT-PLAN 的 `planDownload.expect`），但真接的时候发现：只有 merge 能给出
  `tracks=["video"]`（合并产物必含视频轨），其余链（直链/yt-dlp/hls）在规划阶段
  **根本拿不到清单元数据**——时长、轨道、码率都得下完才知道。所以 expect 现在是
  「能给就给、给不了就空」，空代表「交给 verify_product 的前三层兜底」。
  这不是偷懒，是**诚实**：硬在规划阶段编一个 expect 出来，等于让验证层信一个
  它不该信的假数字。

### 反向验证（三组，全部当场红）

- 废掉 `looks_like_hls_url` 判定（m3u8 不再优先自实现）→ **2 红**
- 废掉 `use_ytdlp`（站点页不再走 yt-dlp）→ **7 红**（含 hls 那条被连带）
- 废掉 merge 优先级（merge 判到 url 校验之后）→ **4 红**

### 数字

- 新增 `test/host_plan_test.py` **32 项**；Python 从 21 套 → **22 套通过 / 2 跳过 / 0 失败**
- `host_paths_converge_test.py` 45 项里 trail 断言从 `==3` 改成 `==4`（多了「规划=」第一项）
- JS 无改动（1085 项不变）

### 留给真机 / 后续

- `plan_download` 目前只在 `main()` 里被消费。等 S4 工作站时，popup 侧可以**复用**
  这个函数在「下载到本地」按钮出现前就判断该不该显示（reject 的地址直接不显示按钮），
  这是 T-C5 注释里早就留的那句「连踩都踩不到」的落地路径。

## d-059 · 2026-10-25 · 输出验证四层：把「下完=成功」改成一个统一的闸门

### 起点：PRODUCT-PLAN 的 L2-b 说「验证产物这一步不存在」

L2-b 原话很直白：`downloader.py` 里 `status` 出现 60 次，但「验证产物」这一步不存在。
它列了四层——①文件存在 ②非空 ③字节数符合预期 ④ffprobe 能解析出 expect 轨道、时长偏差 < 2s。
「任一层不过 → 输出明确错误码，绝不把坏文件当成功」。

我去核的时候发现**不是不存在，是散成了三份、各写各的**：
- 直链 `run_urllib` 收尾查 `done < total`（第 3 层）+ `looks_like_playlist`（第 3 层）
- `run_ytdlp` 收尾查 `looks_like_playlist` + `find_done_product`（魔数判真视频）
- `run_hls_self` 收尾只查 `getsize <= 0`（第 2 层），别的都没有
- 第 4 层（ffprobe）**全项目零落地**——`probe_duration` 只用来算进度条百分比，从没验过产物

所以这一刀的本质不是「加新功能」，是**把已经零散存在的验证收成一个统一出口**，
再补上缺失的第 4 层。

### 三个决定

**① 验证做成纯函数 `verify_product(path, expect, ffprobe)`，返回 `(ok, code, detail, extra)`。**
`ffprobe` 是入参不是自己去找 —— 这样测试能塞假 ffprobe 验证逻辑，本机没有真 ffmpeg 也能全绿。
这是 T-E5（本机 ffmpeg 起不来）逼出来的：判据不能因为「工具不在」就整体退化成「没测」。

**② `ffprobe=None` 时只做前三层，`extra["probed"]=False` 明说「第 4 层没做」。**
前三层已经能拦住三种最脏的假成功：下到清单、下到 0 字节、下到半截。
第 4 层是「锦上添花」不是「保底」，所以它可跳过，但**跳过这件事必须写进返回值**，
不能让调用方分不清「验过了没问题」和「根本没验」。

**③ 收尾统一走 `finish_verified`，done 一定是验证过的 done。**
各链原来的 `write_status(done)` 换成 `finish_verified(job_id, path, msg, expect, notes)`。
一个刻意的顺序：HLS 转 mp4 和合并都**先验产物、再删源文件** —— 验不过时源文件（TS / 双流）
还留着当退路；删了才验就等于把唯一完整文件赌在一个还没验过的产物上。

### 挖出来的东西

- **`is_real_media`（魔数判真视频）早就存在，但没人接到验证层。** 它能拦住「mp4 里装 TS」
  （d-032 真机），比只看扩展名强。我没把它塞进 `verify_product` 默认逻辑——它有 64KB 门槛，
  会把正常小视频误判；它留给需要更强判定的调用方（`find_done_product` 已经用了）。
  但这条让我意识到：**验证层的判断力是分散的**，这一刀只收拢了「清单 + 字节数 + ffprobe」，
  魔数这条线还是各管各的，留了 T-C10 一起看。

- **ffprobe 输出解析里 `codec_name=` 那个分支是空的**（写了 `pass` 占位）。一开始想收集
  codec 名，后来发现 `expect.tracks` 要的是 stream 类型（video/audio）不是编码名，
  空的 elif 只会误导后来读码的人，删掉了。

### 反向验证（四组，全部当场红）

- 废掉 `looks_like_playlist`（下到清单不再拦）→ **6 红**
- 废掉 ffprobe `returncode != 0` 判定 → **2 红**
- 废掉「缺轨道」判定 → **2 红**
- 废掉「时长太短」判定 → **2 红**

第 4 层的三个判定（打不开 / 缺轨道 / 时长太短）各自有独立测试钉住，不是摆设。

### 数字

- 新增 `test/host_verify_test.py` **36 项**；Python 从 20 套 → **21 套通过 / 2 跳过 / 0 失败**
- JS 无改动（1085 项不变）
- `run_all.py` 自动 glob `*_test.py`，新套件无需手动登记

### 没做完、留给真机（T-E5）

- `run_merge` / HLS 转 mp4 的第 4 层验证，本机 ffmpeg 起不来，只能靠假 subprocess 验逻辑；
  真 ffprobe 对真实产物的宽高/时长/轨道判定要等 T-E5。
- `verify_product` 目前没有一条「真·端到端」路径（真下 + 真 ffprobe + 真删分片看报错），
  T-C4 的判据「删掉一个分片 → 界面说『分片缺失，已重试 3 次』」后半句要在真机复验。

## d-058 · 2026-10-25 · 双跑：新模型一比对就露了两个洞，还有一个「测试环境比线上少一个 URL」

### 起点：S0 的 Step2 是「接上 + 证明没丢东西」

`session.js` 在 1.3.43（B31）就写好了，但**从来没被调用过** ——
`background.js` 里只有一行 `importScripts("session.js")`。S0 计划里这叫 Step1。
Step2 是「接进 `background.js`，与旧 `items` 双跑比对」。

双跑最容易做成形式主义：两袋数据各自摆着，谁也不会去比。所以先定一件事 ——
**必须有能自动判定的比对函数**，否则「双跑」只是自我安慰。

### 决定一：比对放在纯函数层，不放在 background 里

最直觉的做法是在 `background.js` 里写个 `diff()`，然后测试去切那段源码跑。
上一轮（d-057）刚被这个做法坑过：`indexOf("\n}\n")` 切出空串，什么都没测还「通过」。

所以 `msDiffSession(session, items)` 放进 `session.js`，和 `msBuildSession` 并排。
好处是三重的：测试直接 `vm` 加载整个文件、不用切片；`background` 只剩一行调用；
将来 popup 或诊断工具要复算，拿到的还是同一个函数。

### 决定二：`ok` 要严格，口径要「只允许新增」

三页真机跑下来，diff 里只要出现 `missing` / `changed` / `extra`，就说明新模型丢了
东西或者凭空多出东西 —— S1~S6 全建在它上面，不能带着隐患往前走。所以：

```
ok = missing.length === 0 && changed.length === 0 && extra.length === 0
```

`added` 是唯一允许的差异，而且**由数据算出来**（拿第一条变体的键减去映射后的旧键），
不写死 `["id","source","quality"]` —— 写死的话，哪天变体少了 `source`，
diff 照样会报告「新增了 source」，那就是在撒谎。

### 决定三：两条刻意不报错

真机的清单页动辄 400 条，如果 diff 天天满屏红，第一次之后没人再看它。所以：

- **同地址多条**：旧模型是两条条目，新模型按地址合并（`buildTrack` 取 max）。
  这是故意的，计入 `merged`，不进 `changed`；
- **分片 / 图标 / 封面 / 文档 / 字体**：两边都不该出现（约束 2），计入 `dropped`。

### 洞一：会话里根本没有图片

第一条断言就红了：

```
✗ xhs：missing 为空 -> ["https://sns-img.xhscdn.com/a.jpg", "...b.jpg", ...]
```

`msBuildSession` 只把封面挑出来放进 `cover`，**其余图片直接丢掉了** —— 也没进
`tracks`（那是音视频的），也没别的地方放。于是小红书图集这种页面在会话里是空的，
`kind` 只能靠 `images.length` 判，而 `images` 是个循环里的临时数组，出了函数就没了。

这不是「少一个字段」，是**Step1 的模型是照着「一个视频」想的**：
S1 选清晰度、S2 验证轨道，全是视频视角。可这个插件一半的使用场景是存图。

补 `images: [...]` 之后，`msDiffSession` 才比得动图片。顺带把 `evidenceOf` 里的
`img.u` 改成 `img.url`（原来那个循环里塞的是原始条目，字段名是 `u`）。

### 洞二：`mime` 被当成数字比，双跑每天满屏假红

第一版字段比较是一行：

```js
if (Number(before) !== Number(after)) changed.push(...)
```

`Number("video/mp4")` 是 `NaN`，而 **`NaN !== NaN`** —— 于是每一条变体的 mime
都「变了」。测试里 10 条红的，全是这个。

这类 bug 的可怕之处不在逻辑，在**它会把这个工具废掉**：第一次打开 diff 看到
一屏假差异，之后再也不会有人看第二眼，真有差异也发现不了。

### 洞三（最值得记的一条）：测试环境比线上少一个 `URL`

```
✗ 影子带 sid / kind -> ["", "video"]
```

`sid` 是空串。`msSessionSid` 里有 `new URL(tabUrl)`，包在 `try/catch` 里，
非法地址返回 `""`。当时我以为是自己传错了地址，打出来一看：`"https://site.example/v/1"`，
完全合法。

真因：`test/background.test.js` 的沙箱是手写的字面量，塞了 `JSON/Object/Array/Map/...`，
**没有 `URL`**。vm 的上下文只带 ECMAScript 内建，`URL` 是 Web API，默认不存在。
于是每一次 `new URL()` 都抛、都被 catch 吞掉、都返回空串。

更阴的是：**这个洞不会让测试变红**。因为 `msDiffSession` 两边用的是同一个会话对象，
`sid` 空就两边都空，`ok` 照样 `true`。我是靠「顺手断言一下 sid 非空」才撞见的。

这和 d-057 的空切片是同一个病：**测试环境比线上少一样东西，而代码正好把缺东西
的后果 catch 掉了**。区别只是这次少的是全局对象、上次少的是字符。

修法：给沙箱补 `URL`，并在注释里写清「不补这一行会让所有 new URL() 静默失败」。
顺手查出 `test/icon_filter.test.js` 也整份加载 `background.js` 而没给 `URL`，
一起补上 —— 那个文件现在只测 `looksLikeIcon`，但迟早会有人在那儿加一条
「按域判断」的断言，然后假绿。

顺带补了 `chrome.storage.session` 的桩。缺它的后果是 `onRemoved` 里
`chrome.storage.session.remove(...)` 抛 TypeError，而抛错点在「清理」分支上，
于是「关标签页后影子被清掉」这条测试红得莫名其妙 —— **桩不全，红的地方往往不是错的地方。**

### 反向验证

改 `session.js` 三个地方，看测试会不会红（都是运行时改源码文本，不动仓库文件）：

| 变异 | 结果 |
|---|---|
| 返回的会话去掉 `images` | **3 红**（xhs 的 ok / missing /「有 images 字段」） |
| `ok` 恒为 true | **3 红**（少变体 / 改大小 / 多一条，三条都抓到了） |
| mime 退回按 `Number()` 比 | **7 红**（xhs 与 tg 的 ok / changed 全红） |

如果第三条不红，说明这个文件测的是「代码跑得过」，不是「差异抓得住」。

### 已知问题（记下来，本轮不改）

会话的 `tracks[].variants` 里混进了**主清单自己的地址**（`x36xhzz.m3u8` 被当成
一条「没有分辨率的变体」）。旧模型也把它当一条 video 条目，所以双跑不报差异 ——
但这在 S1 眼里是个假档位、在 S3 规划里会被当成「可以直下的地址」。留给 S3
（规划表外置）一起处理，见 TODO `T-C10`。

### 数字

- JS **1085 项 / 18 个文件 / 0 失败**（新增 `session_shadow.test.js` 49 项；
  `background` 275 → 290）
- Python 未变（20 通过 / 2 跳过）
- 真机三页的字段级 diff 用 `ms:shadow` 消息取，判据落在 `T-E2` / `T-E3`

## d-057 · 2026-10-25 · 选清晰度：一条「默认档按高度选」的决定，和一个把空切片当跑通的测试

### 起点：S1 的硬指标只剩这一条

`PRODUCT-PLAN` 的 S1 写着「用户能看到有哪些清晰度，并且选哪档就下到哪档」。
前半句在 1.3.33（B33）就做了 —— 清单正文能读出时长与档位；后半句一直空着：
popup 里那条 HLS 条目只是一行字，用户没有任何可选的东西。

这条不做，产品定位那句话就是虚的：

> 不帮你找到 200 个能下的站；保证你下下来的那一个是对的。

「对」包括**是你要的那个清晰度**。手机流量下到 4K、或者存了 360P 想重来，
都算「下下来的不是你要的」。

### 数据链：五段，每段都要自己证明

```
inject-main.js  读主清单 → msg.vlist（[带宽, 分辨率, 地址]，≤8 档）
      ↓
background.js   normVariants() 逐项重建 ← **信任边界在这一行**
      ↓
   meta.vlist → popup.js 渲染 <select>
      ↓
native:download  variant → startNativeDownload 再校验一次
      ↓
downloader.py    pick_variant() 选档（纯函数）→ 分片从这一档的目录拉
```

三段是「不可信输入的两次过关」+「一次纯函数决策」。这不是过度设计：
`inject-main` 跑在**站点自己的 JS 环境**里，它上报的东西和网页里任意脚本
上报的东西等价。bilibili 的页面能改自己的 `window`，也能改我们读到的清单文本。

`normVariants` 只收四件事：`http(s)`、地址 ≤2048 字符、最多 8 档、`res` 截 20 字符。
2048 不是拍脑袋 —— native messaging 的单条消息有大小上限，一个恶意页面塞进
十万档，popup 在渲染那一瞬间就卡死了，用户只会觉得「这插件坏了」。

### 一个决定：默认档按**高度**选，不按带宽

清单里每档有两个数：`BANDWIDTH`（平均码率，bps）和 `RESOLUTION`（1920x1080）。

一开始写的是 `max(variants, key=bandwidth)` —— 直觉上「码率高的画质好」。
这是错的：带宽高的那一档常常是**同分辨率的高帧率/HDR 版本**（1080p60 的带宽
能压过 1080p30 一截），也可能只是编码器给得松。用户心里的量是「720 还是 1080」，
不是「2.4 Mbps 还是 3.1 Mbps」—— 后者他既看不见也没有直觉。

所以：**先比高度，同高度再比带宽**。这样「最高档」永远等于「最大的那个数字」，
和 UI 上的 `1080P` 标签对得上。

（这一条改了之后，端到端测试红了 9 条，其中一条是「请求到了 `/lo/` 目录的分片」
—— 也就是说，改错了会**真的下到低清**，而不是只让标签难看。）

### 第二个决定：用户选的档没了，要回落，并且**说出来**

主清单是会变的（直播切片、CDN 换配置、token 过期重发）。
用户选了 720P，点下载时那一档已经不在清单里 —— 这里有三种写法：

| 写法 | 用户看到什么 |
|---|---|
| 直接失败 | 「下载失败」，不知道为什么 |
| **静默**下最高档 | 下完了，文件是 1080P，他不知道 |
| 下最高档 **+ 说出来** | 「你选的那一档已经不在这条清单里，改用最好的 1920x1080」 |

第三种。第二种是最容易写出来的，也是最坏的：**它把一次降级伪装成成功**。
用户可能过了半小时才发现文件太大、或者手机存不下。

实现上踩了一个小坑：一开始把这句话写进 `message`，然后被收尾的
「已拼成完整视频」覆盖掉了 —— 用户永远看不到。改成 `notes` 列表，
两处收尾各自拼接。**同一件事两个写入点，后写的会吃掉先写的**，
这和 d-055 那条 `err` 断链是同一种形状。

### 判据：没有 ffprobe，怎么证明「选哪档下哪档」

S1-2 的原判据是「`ffprobe` 实测宽高 == 所选档」。本机 ffmpeg 起不来（T-E5），
这条判据在本机不可执行。没有为此把判据放宽成「代码看起来对」，而是换了
一条**更靠前**的等价证据：

> 起一个真的 HTTP 服务器当 master 清单，三档分别在 `/lo/` `/mid/` `/hi/` 目录下。
> 看它**实际请求了哪个目录的分片**。

为什么这条比 ffprobe 更硬：ffprobe 验的是**产物**，而这条验的是**行为**。
产物对了可能是巧合（三档内容一样时），行为对了则不可能巧合 ——
请求了 `/hi/` 就说明选档真的走到了分片请求那一层。
真机上再用 ffprobe 补一次产物验证，记在 T-E5。

### 坑：一个「什么都没测」的测试，跑得比谁都顺

收尾跑全量时发现 `manifest_classify.test.js` 挂了：

```
ReferenceError: classify is not defined
```

这个文件切 `background.js` 的一段代码到沙箱里跑，切法是：

```js
const slice = bgsrc.slice(start, bgsrc.indexOf("\n}\n", cStart) + 3);
```

而本仓库 `core.autocrlf=true`，**检出后是 CRLF** —— `indexOf("\n}\n")` 返回 `-1`，
`+3` 变成 `2`，`slice(1255, 2)` 得到**空字符串**。

空字符串在沙箱里当然不报错（它没有语法错误），错的是下一行。
于是真因和症状隔了一层，报错指向的地方跟问题毫无关系。

更糟的是我在反向验证时发现的第二种形态：把收尾大括号改成 `} `（多一个空格），
`"\n}\n"` 又匹配不到，但这次它**滑到了后面另一个函数的 `}`** —— 切片变长，
把一串无关函数也吞进来，测试**照样绿**。

所以「切错」有两个方向，都骗人：

- **切空了** → 什么都不测，报错还指错地方；
- **切多了** → 测到别的东西上，而且不报错。

修法是不用文本锚点，**数括号**：

```js
function bodyEnd(src, from) {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}
```

外加三道当场炸的检查：切片 <200 字符、切片里没有 `classify`、
切片里出现了紧邻下一段的代码（`new Map()` / `function record(`）。
**「什么都没测」必须炸，不能往下走** —— 这是 d-056 那条「SKIP 记成 PASS」
的同一个原则，只是这次发生在切片上。

顺手做了 `test/run_js.py`。原因是这轮收尾时我在 993 / 995 / 1021 三个数字
之间来回飘：JS 套件的汇总行有三种写法（`全部通过：N 通过`、`通过 N 项`、`PASS N`），
手工 `grep -c "✓"` 只认得第一种用 ✓ 标记的。**数不清总数本身就在掩盖红灯** ——
它把「少了一个文件」和「文件里多了几条」混成同一件事。

### 数字

- Python **20/20 通过 + 2 套跳过**（新增 `host_variant_pick_test.py` 28 项；
  `host_phase_test` 由 10 项涨到 18 项）
- JS **1021 项 / 17 个文件 / 0 失败**（`hls_meta` 64、`popup_wiring` 68、`background` 275）
- 反向验证三轮：默认档改按带宽 → **9 红**；popup 不传 `variant` → **1 红**；
  `normVariants` 不校验协议 → **2 红**
- 另加本轮：`manifest_classify` 的切空/切多两种变异，各自当场炸

### 收尾又捞出一个真竞态：阶段文案会盖掉「下载完成」

提交前照例跑全量，`host_phase_test` 从 PASS 变成了 8/10：

```
FAIL [T4c] 且状态是 done  -> error
```

半小时前它还是 PASS，而且 `extension/`、`downloader.py` 这轮一个字没动。
单独复跑三次全过 —— 典型的 flake。**概率性的红灯最容易被顺手忽略**，
但它通常指向一个真的时序问题，所以我盯着跑，25 次里红了 4 次，
而且红的不固定：有时是 T3（`写完 done 之后不许再被阶段文案覆盖`），
有时是 T4。

根因在 `Phase` 那个自限 ticker 里：

```python
cur = read_status(...).get("message")
if cur != self._mine:
    return                       # 别人接管了，我闭嘴
write_status(job_id, message=...)   # ← 缝在这里
```

「读」和「写」之间没有锁。主流程在这条缝里写 `done` + 清空 `message` 之后，
ticker 把上一轮的阶段文案又盖了回去。用户看到的是：

> 下载完成了，但下面还写着「探测请求头 1/4（已等 0 秒）」。

**这就是 d-034 那个「全程挂着解析播放列表」的同一个界面症状，从另一个入口进来。**
当时的修法是「自限」——ticker 自己发现 message 被别人改了就不写了。
自限的设计是对的，但它只在**单线程顺序**下成立。

修法是把「比较」和「写」并成一步：`write_message_if(job_id, expect, message)`，
读-比较-写在同一个 `_STATUS_LOCK`（RLock，因为 CAS 里还要调 `write_status`）里完成。
`write_status` 本身也进同一把锁 —— 只锁读不锁写等于没锁。

**怎么证明修好了？** 这里有个方法论问题：概率性 bug 的「修好了」不能靠「跑几次没红」。
三件事都做：

1. **T5 确定性摆时序**：手工构造「ticker 记下旧值 → 主流程写 done → ticker 才来写」，
   断言它写不进去。这条钉住 CAS 的**语义**，但它挡不住「比较和写之间没锁」
   ——顺序调用永远撞不上那条缝。
2. **T6 真线程压 20 轮**：直接并发写 done，断言 20 轮 message 全空。
   能撞上缝，但**仍是概率的**。
3. **T7 看锁归属**：用 `RLock._is_owned()` 断言「落盘那一刻锁被当前线程持有」。
   这条不依赖时序，也不依赖概率。

反向验证两组变异：CAS 退回无锁旧写法 → **T7a 红**；`write_status` 退回不进锁 →
**T7b 红**（两种情况下 T6 也红）。修完连跑 15 次，0 红。

**这一课**：「单独跑三次都过」不是证据。修 flake 的正确姿势是先把它跑出概率
（25 次红 4 次 ≈ 16%），再问「这个概率对应什么时序」，最后用水概率的
结构性断言把它钉死 —— 否则下一次它再红，所有人都会说「哦这个 flake 一直有」。

## d-056 · 2026-10-24 · 一条 SKIP 顺藤摸出三个问题：ffmpeg 起不来、SKIP 记成 PASS、超时不写状态

### 起点：一条本该是「收尾」的小活

`TODO.md` 的 T-B6 写的是「把 `run_merge` 和宿主 6 小时超时接进码表」。
按 d-055 的经验，这应该是最便宜的一刀：两个调用点，半小时。

结果第一件事就卡住了 —— 合并测试跑出：

```
SKIP ffmpeg 没有可用的视频编码器（libx264/mpeg4 都失败）
```

### 第一层：`bin/ffmpeg.exe` 在本机根本起不来

`bin/` 里那个 168 MB 的 ffmpeg，`-version` 输出为空、退出码 `0xC0000409`
（STATUS_STACK_BUFFER_OVERRUN）。而 `os.path.exists()` 高高兴兴返回 True。

排查过程（每一步都在排除一个假设）：

| 假设 | 实验 | 结论 |
|---|---|---|
| 文件坏了 | 拷到 `%TEMP%` 跑 | **能跑**，版本 `N-127579-g5cb9fcd211` |
| 路径有中文 | 拷到 `资源嗅探2\`、`中文测试\` | **能跑** |
| 盘符问题 | 拷到 `D://软件应用//DSH//` | **能跑** |
| 沙箱干扰 | `dangerouslyDisableSandbox` 重跑 | 同样崩 |
| 目录本身 | `whoami.exe` 拷进去 | **也失败**（rc=1，无输出） |

`icacls` 给出了答案：

```
资源嗅探   Everyone:(CI)(DENY)(DC)
           S-1-4-919135770-494898939:(OI)(CI)(W,D,DC)
           Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
资源嗅探2  （没有后两行）
```

**这个目录被打上了 `Low Mandatory Level` 标签**（WorkBuddy 沙箱对工作区做的）。
低完整性目录里启动的进程也继承低完整性，于是任何 exe 在里面都跑不起来 ——
连微软自己的 `whoami.exe` 都失败。这不是 ffmpeg 的问题，也不是产品的问题。

想用计划任务以中完整性交叉验证，`schtasks` 在程序黑名单里，被硬阻止，不能重试。
所以**结论只能写到「推断」这一步**：真机上进程完整性由 token 决定、不由 exe
所在目录决定，合并应该正常 —— 但我没能在本机证明。记进 `T-E5`，等真机。

### 第二层（更要紧）：一条断言都没跑的套件，被记成了 PASS

`host_merge_test.py` 找不到 ffmpeg 时做的是：

```python
print("SKIP ...")
sys.exit(0)          # ← 退出码 0
```

`run_all.py` 把退出码 0 记成 PASS。于是**「通过 20/20」里躺着一条什么都没验的套件**。

这比直接 FAIL 危险得多：FAIL 会让人去查，PASS 会让人放心。
上一轮（d-054）刚为「JS 952 是低估」做过一次数字修正，这次是同一个病的另一面 ——
**统计口径错，比数字错更根本。**

修法三条，缺一不可：

1. 套件内部跳过 → `sys.exit(77)`（automake 的 SKIP 约定），`run_all` 认 77；
2. `run_all.have_ffmpeg()` 也改成**能启动才算有**（它原来只 `os.path.exists`，
   和产品代码犯的是同一个错）；
3. 汇总行下面必须打一句：**「跳过的 N 套没有验证任何东西，别把上面那行读成全绿」**。

顺手把 `host_merge_test` 重排：**不需要 ffmpeg 的那半放到前面**（缺流报什么码、
缺 ffmpeg 报什么码、`tool_runs` 判得对不对），这样本机 ffmpeg 一坏，
那 14 条仍然照跑照验。部分跳过时，`run_all` 会注明「另有 14 条已通过」。

### 第三层：产品代码里的同一个错 —— `find_tool` 只查存在性

`find_tool` 三级查找，找到就返回路径，从不问「这个路径能不能跑」。
于是上面那个 0xC0000409 会变成用户看到的一行：

```
合并失败：ffmpeg 退出码 3221226505，输出为空
```

**存在性检查会骗人，可执行性不会。** 加 `tool_runs()`：真跑一次 `-version`
（yt-dlp 是 `--version`），看退出码与输出，结果按路径缓存（一次任务只探一次）。
宿主 `sniffer_host.py` 和 worker `downloader.py` 各留一份 —— 两个进程，
不能共用模块级缓存（这条 d-054 就吃过亏：两端各有一份，改一份等于没改）。

顺带一个副作用：`do_ping` 原来会报告「ffmpeg 就绪」，而实际点合并就崩。
两端对同一件事的认知不一致，比两端都错更难查。

### 第四层：超时原来什么都不写

`poll_job` 等满 6 小时，只 `send({"message": "任务超时"})`：

· 没有错误码 → popup 的「为什么失败」那一行永远是空的；
· **状态文件还停在 `downloading 37%`** → 用户下次打开 popup 看到「还在下」，
  而宿主早就不管它了。

这正是 d-055 那条 `err` 断链的同一种病：**跳板不说话，两端各自觉得没问题。**

改成 `mark_timeout()`：写状态文件（`error` + `JOB_TIMEOUT` + 一句人话，
进度留在原地、速度/ETA 清空），再通知扩展。已经 `done`/`cancelled`/`error`
的任务一律不覆盖 —— 超时逻辑只能收尾，不能翻案。

6 小时这个数字**可配**（`MS_JOB_TIMEOUT`）：不可配的超时等于不可测的超时，
而这条路径写错的话，用户看到的是「进度条永远停在 37%」。

### 码表：13 → 15

加两个，都是被上面这些现场推着加的，不是分类洁癖：

· `MISSING_DEP`（phase=setup）：缺 ffmpeg / yt-dlp。落 `INTERNAL` 等于把
  「你没装东西」说成「我们写错了」，用户会来报 bug 而不是去装。合并时最常见。
· `JOB_TIMEOUT`（phase=transfer）：6 小时没等到终点。落 `NET_TIMEOUT` 等于把
  「任务卡死」说成「网络慢」，用户会一直重试同一条地址。

`setup` 是第五个阶段值。硬塞进 connect/transfer/write/verify 会让「阶段」这个词失去意义。

`run_merge` 的三个失败点：缺流 → `VERIFY_MISMATCH` + **覆盖建议**（表里那句
「再点一次会重试」在合并任务里是错的，它没有 URL）；缺 ffmpeg → `MISSING_DEP`
且 detail 区分「启动即崩」和「缺文件」；搬流失败 → 先按 ffmpeg 尾巴翻译，
对不上就 `CODEC_UNSUPPORTED`（这一路只做 `-c copy`，合不起来几乎总是封装不合）。

主流程里那条「这不是外部进程能直接取的地址」**刻意不进码表**：它不是失败原因，
是路由判断。等 T-C5 的规划表建好，这类地址在 popup 里就不该出现「下载到本地」按钮，
连踩都踩不到。在路由修好之前留一句话，比给它编一个码更诚实。

### 反向验证（三轮）

| 破坏方式 | 结果 |
|---|---|
| `mark_timeout` 只发消息、不写状态文件 | **7 红** —— 状态、err、文案、速度清空全灭 |
| `tool_runs` 恒返回 True（回到老写法） | **2 红** —— 垃圾 exe 判成「有」 |
| `_give_up` 漏写 `err` | **2 红** —— 恰好是那两条码断言 |

### 数字

Python **20/20 通过 + 2 套跳过**（新增 `host_job_timeout_test.py` 27 项；
`host_merge_test` 新增 14 项且**在没有 ffmpeg 的机器上也能验**）。
跳过不是通过 —— 汇总行现在会自己说这句话。

版本 **1.3.50**，`extension/` 零改动（R2 结构证据）。

---

## d-055 · 2026-10-24 · 三条路说三种话：码表建好了，却只有一条路在用

### 起点：上一刀的验收单自己写着「只接了三分之一」

d-054 的收尾里写着「HLS / yt-dlp 两条路径的接线留给 T-B5」。当时的判断是
「表已存在，只差两个调用点」—— 听起来是最便宜的一刀。实际打开代码才发现，
两个调用点只是最小的那一部分。

同一个 403，三条路径给用户三句话：

```
HLS   ：拉取播放列表失败：HTTP 403 Forbidden（该站地址有时效，请刷新页面后重试）
yt-dlp：ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden
直连  ：站点拒绝了这个请求（403）。多半是防盗链：刷新页面重新抓一次。
```

三条都在描述同一件事，两种还是英文。而 main 的兜底链把三句拼起来：

```
自实现 HLS: … ／ yt-dlp: … ／ 直连: …
```

那是写给作者看的。用户拿到 200 字的串，反而更不知道该干什么 ——
d-054 花了整篇去消灭 `HTTP Error 429: Too Many Requests`，转头在 main 里
亲手又拼了一个更长的。

### 第一个决定：翻译表要「有序」，而且不许硬猜

yt-dlp 没有状态码，只有英文输出。要把它翻回码表，只能靠模式匹配 ——
而模式匹配最危险的地方是**顺序**：`login` 和 `not found` 同时出现在一行里时，
先匹配哪个，决定了用户下一步是「去登录」还是「换地址」。

所以规则是**有序列表**，注释里写明为什么是这个顺序：

```python
_YT_RULES = [
    (r"drm|widevine|playready",                     "DRM_PROTECTED"),
    (r"http error 429",                             "HTTP_429"),
    (r"http error 401",                             "AUTH_REQUIRED"),
    (r"http error 403|forbidden",                   "HTTP_403"),
    (r"http error 404|410",                         "HTTP_404"),
    (r"http error (5\d\d)",                        "_5XX"),     # 原样留数字
    (r"sign in to confirm|members-only|需要登录",     "AUTH_REQUIRED"),
    ...
]
```

两条判断写在这里，以后别再改回去：

1. **HTTP 状态码排在「登录」前面**。403 是站点给的**事实**，登录是它的解释；
   事实优先，解释只在没有事实时使用。
2. **认不出来就落 `INTERNAL`，不许猜**。它在这个模块里的语义是「我们漏了一种
   说法」，不是「不知道」。落进去的时候调用方必须把原文带上，否则诊断信息就断了。

### 第二个决定：HLS 的每个失败点都要有码，但不要自己编原因

原来 HLS 的报错全是自己编的长句，比如：

```
下载分片失败（30/178 已下）：第 31 片重试 3 轮仍失败：IncompleteRead(...)。网络抖一下不会这样，多半是这一片在服务端有问题，刷新页面换个地址重试
```

信息是对的，但它是**文章**不是数据：统计时数不出「分片失败」有多少次，
用户也没法一眼看到建议。改成：

```
有分片一直取不到（第 31 片重试 3 轮仍失败，已下 30/178）。换一条地址，或稍后再试。
```

码是 `SEGMENT_GAP`，事实进括号，建议来自表。拉清单的 403 则**不带 detail** ——
`HTTP_403` 自己的话里已经有「403」，再拼一句「HTTP 403」就变成
「站点拒绝了这个请求（403）（HTTP 403）」。这不是美观问题：三条路径要逐字相同，
谁多写一句就不一致了。

### 第三个决定：三条都失败时，`consensus` 选最具体的那一个

`errcode.consensus(codes)`：一致就直接用（同一条原因撞了三次，最强证据）；
不一致时按一张 `_PRIORITY` 表挑 —— 越能说明用户下一步做什么的越靠前。

```
DRM_PROTECTED > AUTH_REQUIRED > CODEC_UNSUPPORTED > TOKEN_EXPIRED
> HTTP_403 > HTTP_404 > SEGMENT_GAP > DISK_FULL > VERIFY_MISMATCH
> HTTP_429 > NET_TIMEOUT > NET_DNS > INTERNAL
```

现场的典型分歧：HLS 与直连都被 403 挡住（它们根本解不出内容），只有 yt-dlp
认出了 DRM。这时候报 403 是**把用户往一条永远走不通的路上推** —— 他会去刷新
页面、换地址，然后再撞一次。所以 DRM 压过 403。

三条原话进 `trail`（状态文件里的一个字符串），给以后的诊断包用：
**人看一句，机器看三条**。有码记码，没码记那句话 —— 早期实现只记「无码」，
等于把三条路的诊断信息一起丢了，而 trail 存在的唯一理由就是查「是谁的锅」。

### 顺带修的一条断链

查证时发现：`err` 字段 downloader 早就写了，`background.js` 也早就读了
（`code: msg.err`），中间的 `sniffer_host.poll_job` **不转发**。

于是 UI 上永远没有错误码 —— 而两边的代码看起来都没问题。这种「中间的跳板
不说话」的 bug 最难查：两个端点各自都能自证清白。现在 `progress` 和收尾消息
都带 `err`，并且有一条断言专门钉这一跳。

### 一个把测试自己坑了的坑

想用 `.cmd` 假装 yt-dlp：Windows 下 `Popen` 启动批处理会把整条命令行交给
cmd.exe **再解析一遍**，而我们传的 `--progress-template` 里带 `|`：

```
download:MSPROG|%(progress._percent_str)s|%(progress._speed_str)s|…
```

`|` 被当成管道，后半段变成一条新命令，报 `'%' 不是内部或外部命令` ——
**假程序自己先坏了**，跑出来 7 条红全都指向同一个原因，看起来像产品代码崩了。
换成在 `subprocess` 层打假（只换 `Popen`，读 stdout、判退出码、扫 ERROR 行、
找产物全是真代码），一次就绿。

教训与 d-052 那条一脉相承：**反向验证和测试替身本身也会假跑**，
看到「一改就全红」时要先怀疑脚手架。

### 反向验证（四轮，每轮都是真红）

| 破坏方式 | 结果 |
|---|---|
| `classify_ytdlp` 恒返回 INTERNAL（翻译表失效） | **20 红** —— 12 条翻译、三路同码、DRM 共识全灭 |
| HLS 的 `bail` 只写 message 不写码（回到老写法） | **2 红** —— 恰好是那两条 HLS 断言 |
| 宿主不转发 `err` | **1 红** —— 只有那一条，说明断言指得准 |
| main 用「最后一条路的码」代替 `consensus` | **2 红** —— DRM 场景报成 403 |

### 顺带补上的第四个假成功

yt-dlp 退出码 0、没有 `FILE:` 行、目录里也没有真视频 —— 原代码在这里写
`done` + `file=""`，用户看到「完成」但什么都没有。改成先找产物、找不到就
`VERIFY_MISMATCH`。（前三个假成功分别在 d-037 的 `looks_like_playlist`、
`find_done_product`、`post_err` 里处理过。）

### 数字

Python **20/20**（新增 `host_paths_converge_test.py` 44 项）、JS **995 项**未变、
`node --check` 全过、版本 **1.3.49**、`extension/` 零改动（R2 结构证据）。

---

## d-054 · 2026-10-24 · 12 个错误码里没有 429：把「为什么失败」变成数据

### 起点：一个不成立的待办

`TODO.md` 的 T-B4 写的是「P2 自适应降级：429/403/超时 → **退单流**」。
但上一刀（d-053）刚量出多连接只有 1.06×，P0 已经不做 —— 本来就是单流，
**没有「退回单流」这回事**。待办表里这一行的前半句已经过期了。

剩下真正要做的是后半句：失败原因得有个码、得说人话、得按预算重试。

### 第一个发现：码表本身是缺的

打开 `PRODUCT-PLAN.md` 的 L2-c 数了数那 12 个码：

```
NET_DNS  NET_TIMEOUT  HTTP_403  HTTP_404
TOKEN_EXPIRED  SEGMENT_GAP  INIT_MISSING  CODEC_UNSUPPORTED
DRM_PROTECTED  AUTH_REQUIRED  DISK_FULL  VERIFY_MISMATCH
```

**没有 429。**

而 429 恰恰是唯一在自家机器上撞见过的失败：d-053 量吞吐时 `proof.ovh.net`
单连接两轮正常、4 连接那轮直接吃 429。当时把它当成「多连接是负收益」的证据，
没意识到它同时也是**码表的漏项**。

缺了它，「站点在限速」只能落进 `NET_TIMEOUT`，用户看到「连接超时」→ 立刻再点
→ 被限得更狠。**错误分类错了，用户的下一步动作就错了**，这比没分类更糟。

所以改的是文档不是代码：12 → 13，加 `HTTP_429`。数字改了，承诺没改。

### 第二个决定：预算写在表里，不写在 if 里

```python
CODES = {
    "HTTP_429": dict(phase="connect", retryable=True, attempts=2, backoff=3.0, ...),
    "HTTP_403": dict(phase="connect", retryable=False, attempts=1, backoff=0.0, ...),
}
```

`plan(code, headers, attempt)` 读表算「还试不试、隔多久」。好处不是少写几行，
而是**「第几次开始降级」变成表上的一个数字**——可以一眼看、可以测、可以吵。
散在 `if code == 429 and attempt < 3:` 里，就是一个只有作者记得住的约定。

同理 `retryable()` 对**表外**的 `HTTP_5xx` 也给 True：5xx 是瞬时抖动，
4xx 重试一百次还是同样结果。这条规则本身也是可测的（`HTTP_503` 重试、`HTTP_400` 不重试）。

### 第三个决定：重试必须让用户看见

```python
write_status(job_id, status="downloading", err=code,
             message=errcode.retry_note(code, attempt, delay))
# → "站点在限速，3 秒后重试（1/2）"
```

不写这一句，用户看到的是「进度条不动了 3 秒」。静默重试看起来更"智能"，
但它把「告诉你为什么」这句唯一的产品承诺还回去了 —— 那正是 gopeed 那种工具
一直没做的事，也是我们唯一能赢的地方。

### 一处被迫的让步：同一个码，两句不同的话

把「下到的是 #EXTM3U 清单」也归进 `VERIFY_MISMATCH`（它确实是验证层失败：
产物不是视频），改完 `host_product_test` 立刻红了一条：

```
FAIL [P3b] 报错里要说清是「播放列表」不是视频
  -> 文件不完整或内容不对（拿到的是 #EXTM3U 清单文本，不是视频文件）。再点一次会重试…
```

原文案是「只下到播放列表…**这条地址是 HLS 清单，得按分片下载；请用扩展列表里的
「下载」交给本地下载器**」。信息量被我压掉了，而且那句「再点一次会重试」是**错的建议**
——重试一百次还是清单。

这不是测试写错了，是我做过头了。解法不是给这个场景造第 14 个码（码会越来越细，
最后没人记得住），而是让 `describe(code, detail, act="")` 允许**覆盖建议**：

> 码只有一个（统计口径统一），建议按场景变。

「只收到一半」→「再点一次会续传」；「下到清单」→「用扩展的下载按钮」。
同一个码给两句不同的话，才是对的。

### 顺带补上的一个可见性缺口

`popup.js` 里失败记录的 `title` 挂着错误全文，可见内容只有 `✗ 文件名`。
**用户得把鼠标悬上去才知道为什么失败** —— 一个把「告诉你为什么」当卖点的产品，
把答案放在 tooltip 里。

改成 `.h-why` 独立一行（`.h-item.err { flex-wrap: wrap }` + `flex-basis: 100%`），
错误码进 `title`（诊断时能念出来，但不占可见行）。`background.js` 的 `history` /
`lastResult` 同步加 `code` 字段。

### 反向验证（三轮，每轮都是真红）

| 破坏方式 | 结果 |
|---|---|
| `retryable()` 恒返回 False（假装都不能重试） | **15 红** —— 包括「请求数正好 2」变成 1、「重试提示」消失 |
| `_sleep_watch` 睡满且不看取消 | **2 红** —— `没有第二次请求` 变成 2 次、`没等满 3 秒` 实测 3.09s |
| `describe()` 直接返回码字符串（不做人话翻译） | **8 红** —— 文案断言全灭 |

第一轮还顺手修了测试自己：反向验证时第一条断言就红（产物没生成），
`os.path.getsize` 抛 `FileNotFoundError`，**后面的断言一条都看不到** ——
一红就崩的测试等于只测了第一件事。加了 `size_of()` 容错。

### 一个数字上的自我修正

统计 JS 全套时发现之前记的 **952 是低估**：统计脚本的两个正则漏了
`全部通过：N 通过 / M 失败` 和 `结果: N 通过, M 失败` 两种汇总格式，
`ui_card`（39 项）和 `pattern_sync`（4 项）一直没被算进去。
真实数字是本轮的 **995**（含 `popup_wiring` 新增 4 项）。之前写进文档的 952 是错的。

### 数字

Python **19/19**（新增 `host_errcode_test.py` 71 项、`host_urllib_retry_test.py` 29 项）、
JS **995 项**、`node --check` 全过、版本 **1.3.48**。

---

## d-053 · 2026-10-24 · 先量后写：多连接实测 1.06×，400 行代码省下来了

`docs/TODO.md` 里 T-B3 的原话是「P0 多连接：**先量吞吐**（1 vs 4 连接），<2× 不做」。
这一步就是把那个「先量」做掉 —— 它不是功能代码，是一个判据。

### 怎么量才算数

- **同一个文件、同一时刻、同一个进程**：先单连接、再 4 连接，各 3 轮取中位数。
- **只量固定窗口**（前 32 MB），不量整份文件：两边下的是同样字节才可比，
  而且不受「文件多大」干扰、几十秒出结果。
- **热身一轮**把 DNS/TLS 握手挪出计时段（否则第一个样本永远偏低）。
- 数据只计数不落盘：避免磁盘 IO 混进网络数字。

源选 GitHub release 资产（S3 后端、支持 Range、不像测速站那样秒限速）——
顺手用刚评估过的 gopeed 的 android 包，70.7 MB。

### 结果

```
单连接：10.1 / 9.8 / 10.6 MB/s   中位数 10.1
4 连接：11.2 / 10.7 / 10.7 MB/s  中位数 10.7
倍数 1.06×   →  判据 ≥2× ，不达标
```

10 MB/s ≈ 80 Mbps，正好是本机出口带宽。**瓶颈在链路，不在「少开了几个连接」。**
所以 P0 不做 —— 省下的是 400 行并发分片 + 单流回退 + 边界重试的代码和维护成本。

### 副产物：4 连接那一轮吃了 429

试源过程中 `proof.ovh.net` 单连接两轮都正常（6.5 / 12.3 MB/s），第三轮切到
4 连接直接 `HTTP 429`。这不是巧合：不少 CDN/网盘对「同一 IP 多连接」就是限速或拒绝。
**多连接在会被限速的站上是负收益，而恰好是这些站才最需要它。**

于是判断改了：**P2（被限速时怎么退）比 P0（怎么更快）更值钱**，它从第四位升到下一步。
这也是「先量」的第二个好处 —— 量之前我以为该做的是提速，量完发现该做的是降级。

### 数字
新增 `tools/throughput_check.py`（判据工具，不是产品代码）；版本**不升**——
本刀 `extension/` 与 `native-host/` 零改动，装的人拿到的东西没变。
顺带在 `AGENTS.md` 记下这条规则，免得以后为了「过清单」给纯工具提交凑版本号。

## d-052 · 2026-10-24 · P1：续传前先验指纹，半截文件不再冒充「完成」

用户说「我的本意就是想让你吸收整合里面有价值的东西」+「待办项一定不要遗漏」。
所以先建了一份**唯一权威待办表** `docs/TODO.md`（把 B/S/P 三套编号合成一处，
每行带来源和判据），然后按我自己排的序开工：**P1 续传指纹 → P1-b 完整性**。

### 一、先承认两个真实缺口

`run_urllib` 是「yt-dlp 失败后的兜底」，也是最简单可控的一条路，但它有两条暗沟：

1. **续传只认 `.part` 的长度**。这期间服务端换了内容（重新转码、CDN 换切片、
   签名直链换批次），长度对得上就照续 → 拼出来是「前半段 A + 后半段 B」，
   而 **ffprobe 往往还能打开**，验证层于是放它过去。这是「错并且不自知」，
   所以它排在提速（P0）前面。
2. **提前 EOF 会被报成完成**。`read()` 返空就 `break`，紧接着 `os.replace` ——
   半截文件盖上正式名字、状态写 `done`。这正是 V2 一票否决项（产物打不开），
   而代码当时是**静默生产**它。

### 二、修法：`.part.meta` 存三元组，全程比一次

`.part` 旁边写 `<path>.part.meta`，存 `ETag` / `Last-Modified` / 总长。
续传时（收到 206）**在写 body 之前**比对，三种判据按强弱排：

```
长度 ≠ → 不能续（最硬）
ETag ≠ → 不能续（剥掉 W/ 再比，强弱标记差别不是内容变了）
Last-Modified ≠ → 不能续
三项都拿不到 → 允许续（见下）
```

不一致就删 `.part` + 删 meta + **从 0 重下**，并留一句话给用户：
「服务器上的文件变了（长度从 90000 变成 120000），之前的断点作废，正在从头重下」。
不给说法的话，进度条突然从 60% 掉回 0%，用户只会觉得下载器抽风。

**为什么「三项都没有」时允许续**：绝大多数 CDN 分片和签名直链根本不发校验头。
一刀切拒绝续传等于把它们变成「每次断了都从 0 开始」——那比冒险更糟。
代价写在这里，不藏：这类站换了内容我们照样会拼错。

另外两处顺手对齐：
- `_resp_total()` 用 `Content-Range` 的**总数**而不是 206 的 `Content-Length`
  （后者只是剩下的那截）。原来 `total += resumed` 的算法在「服务器多给了/少给了」
  时会算歪，进度条会跳。
- `.part.meta` 是孤儿风险：成功、清单误判、作废重下三条路径都显式删掉。

### 三、完整性：读到的字节必须等于总长

`if total and done < total:` → 判失败，**保留 `.part`**，文案
「连接提前断开：只收到 61.0 KB / 100.0 KB。已保留断点，再点一次会从断点继续。」

保留而不是删掉，是因为这一路本身就是「断点续传」的路径——删了等于罚用户重下 3 GB。

### 四、反向验证（这次是三层，不是一层）

| 改坏什么 | 期望 | 实测 |
|---|---|---|
| `if total and done < total` → `if False` | 断流那组全红 | **8 项红**，且状态字段直接暴露老 bug：`status: done, file: …\v.mp4`（62400 字节的半截文件被报成完成） |
| `why = fingerprint_mismatch(...)` → `why = ""` | 换内容那组红 | **3 项红**，含「产物 == 新内容 → 90000」（旧 30000 字节混进了新 60000 字节，文件长度还正好对得上） |
| 还原 | 全绿 | ALL PASS |

第二条正是这个改动存在的理由：**长度对得上、内容对不上**，除了指纹没有别的办法发现。

### 五、踩的坑：反向验证本身也会假跑

第一次做反向验证 A 时，我用 heredoc 里的 Python 字符串替换源码，`\n` 被吃成了
字面量 `/n`，`downloader.py` 直接 `SyntaxError` —— 测试连 import 都没过，
grep 输出一片空白，看起来像「改坏了但没红」。**空输出不等于通过**，
改成 `sed` 单行替换才真正跑起来。这条记在这里，因为「反向验证本身失败」是最容易
被当成「反向验证通过」的情况。

### 数字
Python **17/17**（新增 `host_resume_fingerprint_test.py`，37 项断言）、JS **952 项**未变、
`node --check` 全过；版本 1.3.47。本刀只动 `native-host/downloader.py` 与新增测试，
`extension/` 零改动（R2 结构证据：`git diff --stat` 里只有宿主与测试）。

## d-051 · 2026-10-24 · 「不能只出现一条可下载吗」：同片折叠；外加 Gopeed 与 P0~P3 的取舍

用户两条：
1. 截图里两行「HLS 流（视频）」，一条 `33:33 · 403 段`、一条 `33:33 · 337 段`，
   问「不能只出现一条可下载吗」。
2. 「下载记录估计是要完成下载后才会出现，先这样吧」—— 这条不再改（d-050 已证真机 0→1）。

同一轮用户还丢了 Gopeed 仓库 + 三张 P0~P3 方案截图，问「也许可以整合」。
两件事一起答，评估单独写进 `docs/ENGINE-EVAL.md`。

### 一、两行其实是同一个视频的两个片源

上一版（d-050）只做到「按路径第一段归族 + 显示时长」，所以两行都在、且各自独立：
`/videos5/<md5>/` 那棵树只有它自己，`/m3m/` 也是。但**两条时长精确相同（2013s = 33:33）**，
意味着覆盖的是同一段内容 —— 403 段 × 5s、337 段 × 6s，切片长度不同，片源不同，片子是同一部。

**判据只有「时长相同」这一条**，容差 2 秒（只吸收 `#EXTINF` 取整）、且要求 ≥60 秒
（30 秒的贴片广告撞时长太正常，合并等于吃掉一个真选项）。

为什么**不**用体积/段数/路径当判据：体积实测 HQ 比 FHD 小；段数表达的是切片长度不是内容；
路径在 d-050 已经栽过一次（拿它猜关系，把预载清单和正片标成「第 1/2 档」，用户点的正是错的那条）。
**弱证据只能标注，不能折叠。**

折叠后默认留哪条，四级排序，每级都能从条目字段直接读到：
`有 title`（只有页面自己声明的源才有，比网络里抓到的可信）→ `hits 多`（播放器在反复拉）→
`段数多`（单段失败要重下的量更小）→ 体积/URL 兜底（只为结果稳定）。

其余折叠的**不是删掉**：sub 行末尾有「切换」，点一下换下一个片源，可逆。
`moviePick` 只活在 popup 这一次打开期间 —— 存进 storage 就变成跨会话的隐性状态，
下次打开为什么少一条会说不清。

顺带把 chip 计数也过滤了折叠项，否则又是「视频 2、点进去 1 条」那种对不上。

### 二、`popup_wiring.test.js` 又出现「断言锁死实现」的同类问题

旧断言写死 `renderItem(items[i], i + 1, hlsFamily)`，我加了第四个参数 `groupOf` 直接变红。
这跟 d-050 那条「断言匹配的正是有 bug 的写法」是同一个病：**断言钉的是实现细节，不是行为**。
改成只钉「传了 hlsFamily」+ 单独一条钉「传了 movie.groupOf」。

### 三、Gopeed：不接，但把 P0~P3 按自己的顺序吸收了

`docs/ENGINE-EVAL.md` 写了完整推理，这里只记结论：

- **许可证不是障碍**。GPL-3.0 只在链接/派生时传染；旁挂二进制 + 本地 API 跟仓库里
  已经在用的 ffmpeg 是同一种模式（`bin/` 里躺着 323 MB 的 GPL 系 ffmpeg）。
  拿 GPL 当挡箭牌是不诚实的。
- **不接的真正理由**：它不解决用户的抱怨。最近三次原话是「该点哪个」「没记录」「名字该是标题」
  —— 全在 L0/L1/L2。接它之后用户依然面对两行一样的清单，只是下得更快。
- **它的真价值**：BT/magnet/ed2k（自己写永不划算）+ `resolve_task` 的「先解析再建任务」思路。
  记成 S6 之后的可选引擎，触发条件只有「磁力链成真需求」。
- **P0~P3 的顺序我改了**：`P1 续传指纹校验` 排第一（现在 `.part` 只认长度，服务端换了内容
  会拼出坏文件，而 ffprobe 还能打开 → 验证层会放它过去，是"错并且不自知"）；
  `P0 多连接` 第二（先量 1 连接 vs 4 连接的吞吐，倍数 <2× 就不写）；`P2 降级` 第三
  （必须落进已有 12 错误码，不许默默降级）；`P3` 方向改写 —— 不缺统一状态机，
  缺的是三条路径的**失败判定**收敛到同一张错误码表。
- 核对属实、别动的一条：表里说「HLS 已有线程池 + 顺序写盘」是对的（`run_hls_self`），
  P0 改造时要把它明确划出去。

### 数字
JS **952 项**（新增 `hls_same_movie` 32 项，`popup_wiring` +1）、Python **16/16**；版本 1.3.46。
反向验证：把 `DUR_TOL` 从 2 改成 0 → 31 通过 / 1 失败（「差 1 秒要折叠」那条红），还原后 32/0。

## d-050 · 2026-10-24 · 从「监听地址」跨到「读内容」：清单正文拿到时长，四条 HLS 终于能分出哪条是正片

用户同一页又截了一次图：四条「HLS 流（视频）」，5.1 / 5.0 / 4.2 / 4.2 KB，
全部标着「同一视频的第 1/4 … 4/4 个清单」，问「有什么区别、该点哪个」。
另外两件：关闭 popup 后没有下载记录；下载下来的文件名是 `449820be….mp4` 这种哈希，
用户原话「应该是标题（如果有的话）」。

### 一、那四条根本不是「同一视频的四档」——上一轮是我编的
用新写的 `tools/net_dump.mjs`（CDP `Network.getResponseBody`，不受 CORS 限制）抓真实正文：

```
/m3m/<长hex>.m3u8     29155 B  179 段 × 6s = 1074s = 17:54   ← 播放器真正在用的正片
/videos5/<md5>/<md5>.m3u8 5153 B  页面预载的小清单，播放器根本没用它
```

两条同域名、同后缀、mime 都是 `text/plain` —— **只有地址时无从区分**。
而上一版 `hls-family.js` 在没有 master 时，把所有 m3u8 一股脑标成「第 N/M 档」，
等于编造了一个不存在的清晰度关系；用户点的正是 5 KB 那条（落盘文件名就是那个 md5）。

修法两条：
1. **归族收紧**：没有唯一 master 时按**路径第一段**分组，只有同一棵树下的才算一族，
   并且记 `hasMaster:false`。UI 里「整段下载请点主清单」必须挂在 `hasMaster` 后面 ——
   那四条全是变体、页面上根本没有主清单，界面上却让用户去点一行不存在的条目。
   为什么按第一段分组而不是同父目录：`/hls/1080/` 和 `/hls/720/` 是同一视频的两档
   （共同祖先 `/hls/`，父目录不同也得归族），而 `/videos5/…` 和 `/m3m/…` 连第一段都不同。
2. **读清单正文**（S1 的 L1-a 提前落地）：新增 `extension/hls-meta.js`（纯函数解析
   `#EXTINF`/`#EXT-X-STREAM-INF`/`#EXT-X-KEY`），`inject-main.js` 在 fetch/XHR hook 里
   对 m3u8/mpd 读体（`resp.clone()`、≤256KB、全程 try/catch），把段数和总时长补到条目上。
   界面上直接显示 `10:35 · 64 段` —— 用户一眼就能看出哪条是正片。

### 二、排查过程中的四个坑（都是「看起来没数据，其实有」）
1. **`mergeHlsMeta` 只改内存不写 storage**：真机从 storage 读 dur 全是 0。元数据到达时
   条目若已存在，必须当场补 + 标 dirty 触发持久化，否则 popup 关掉重开时长就没了。
2. **取证工具两份字段白名单**：`dumpItems` 和 `renderCheck` 各有一份，加了 `dur/segs`
   只改了前者 → 「条目里有 634 秒，界面显示时长未知」。合并成唯一的 `plainItem()`。
3. **`plainItem` 被 evaluate 的页面上下文调用**：它是 Node 侧函数，进到页面里
   `plainItem is not defined`。改成源码字符串 `PLAIN_SRC` 注入。
4. **`downloadTest` 的 `extPage` 是 `{targetId, page}`**，我按 page 用，报
   `extPage.evaluate is not a function`，来回改了三次句柄。

### 三、文件名：一个被测试锁死的 bug
`startDownload` 写的是 `filename: it.f || (it.title ? shortTitle(it.title) : "")`，
而 `it.f = fileNameOf(it.u)` —— **纯从 URL 末段推的**，对 `/videos5/449820be…/499820be….m3u8`
就只能得到 32 位哈希，永远赢过标题。

更糟的是 `test/popup_wiring.test.js` 里那条断言匹配的**正是这个有 bug 的写法**，
等于把错误行为锁死。现在反过来断言：`filename: downloadName(it)` + 不许再出现 `it.f ||`。

规则搬到 `extension/naming.js`（纯函数，24 项测试）：标题优先 → 标题只是站点名
（短且含域名主体）时退回 URL 名（否则一页四条会撞名覆盖）→ 都没有交给宿主兜底。
页面浮层那条链（`pageSaveName`）一直是标题优先，现在两条链统一。

### 四、关 popup 后下载记录：**这一条已经好了，但用户看的是旧版**
上一轮修完 `notifySaved` 后我只是在「扩展页一直开着」的情况下验过，没验用户真实路径，
所以给 `live_check` 加了 `--close-popup`：发单后把扩展页面也关掉（= 用户关 popup），
等 40 秒（> MV3 的 30 秒 idle），再开一个新扩展页查记录。

真机结果：`0 → 1 条`，`lastResult：成功 · probe (2).mp4 · 240000 字节`。
**记录是写进去的**。用户看到没有，最可能是没重新加载扩展（改的是 SW，不 reload 不生效）。

顺手证伪：第一次判定打成 ❌，是因为宿主遇到重名会加 `(1)`，我拿全名去 indexOf 匹配 —— 是工具的错。

### 五、百度网盘实测（用户给的哈利波特分享链接）
- 未登录打开分享页：扩展抓到 **85 条，真实媒体 0 条**（唯一那条 `video` 是页面 URL 本身），
  m3u8/mpd 也是 0。
- 纯 HTTP 能走通的部分：`/share/verify` 提交提取码拿 `BDCLND`（errno=0）→ `/share/list`
  列出 11 个条目（errno=0）。**列目录不需要登录。**
- 拿播放/下载地址：`/share/streaming` 与 `/api/sharedownload` 都返回 `errno:2`
  （缺 `sign` 签名与登录态）。
- 结论：网盘的播放地址要 `sign` + `BDUSS`，下载还要过客户端/会员限制 —— 这不是扩展能力问题。

### 数字
JS **919 项**（新增 hls_meta 55 / naming 24 / hls_family +7 / popup_wiring +3）、
Python **16/16**；版本 1.3.45。

## d-049 · 2026-10-24 · 一次真机取证挖出三个 bug：清单被体积门槛吃掉、三条 HLS 无法区分、下载记录从不写入

用户提了三件事：①截图里三条「HLS 流（视频）」有什么区别；②下载时关标签页，下载记录消失；
③真机打开插件，把列表和网页实际内容对比一下。三件都需要真机数据，所以先做工具再查。

### 先解决「怎么取证」
写了 `tools/live_check.mjs`：CDP 起真浏览器 → `Extensions.loadUnpacked` 加载扩展 →
**开一个扩展页面（popup.html 当普通标签页）**，在扩展源下 `evaluate` 读 `chrome.storage.session`。
绕开两个老坑：MV3 的 SW target 里 `chrome.storage` 是 undefined；扫 `Target.getTargets` 找
`chrome-extension://` 会先撞上 Edge 自带扩展，打开它的 popup 得到的是没有扩展 API 的 404 页
（表现为「扩展页里 chrome.storage 不可用」，而 URL 检查还是通过的）。必须用 `loadUnpacked`
返回的 id，并且核对 `chrome.runtime.getManifest().name` 含「资源嗅探」。

### bug 1：网页在放 HLS，列表里一条 m3u8 都没有
本地搭 hls.js + mux 三档测试流复现。抓到的 23 条里全是分片和 MSE 录制条目，**清单一条没有**。
curl 量了真实尺寸：master playlist **752 字节**、media playlist **231 字节**。
两层叠加导致全丢：
1. `classify` 先看 MIME 再看扩展名。清单 MIME 五花八门——`audio/mpegurl`（mux 就是）、
   `application/xml`、`text/plain`（51cg1）、`application/vnd.apple.mpegurl`。看 MIME 必然
   判成 audio（门槛 10240）或 other。
2. `MIN_MEDIA_BYTES.video = 2048`。752 < 2048，**整条当成「1×1 像素级假资源」丢掉**。
修法：新增 `MANIFEST_EXT = {m3u8, mpd}`，`classify` 里让它压过 MIME；`record` 里用
`isManifestUrl()` 豁免体积门槛。清单是文本，几百字节才是常态，用视频门槛去量必然误杀。
**用户那三条 5.1/4.2/4.0 KB 能显示，纯属侥幸过了 2048 线。**

### bug 2：三条「HLS 流（视频）」到底是什么
真机数据（mux 实测）：`x36xhzz.m3u8` 752B + 三个变体 3606/3670/3606B。
**它们不是三个视频，是同一个视频的主清单和三档变体。** 用户点哪条都不确定，点错了下到另一档。
新增 `extension/hls-family.js`（纯函数）：按「目录祖先 + 体积」把同页多条 m3u8 归族——
主清单的目录是其它条目的目录前缀（`/x36xhzz/` 是 `/x36xhzz/url_6/` 的前缀，判定必须带尾斜杠，
否则 `/hls` 会吞掉 `/hls-a/`）；没有唯一祖先时全部按体积降序当「第 N 个清单」。
UI：主清单写「主清单 · 含 3 个清晰度清单」，变体写「同一视频的第 2/3 个清单 · 整段下载请点主清单」。
**刻意不写「第 N 档」**：实测 HQ(3606B) 比 FHD(3670B) 小，按体积排出来的序号不等于清晰度。
真档位要读清单内容，那是 S1 的活。

### bug 3：下载记录从来不写（用户说的「消失」）
`notifySaved`（写 `storage.session.history` + `lastResult` + 角标）**只挂在页面浮层保存那条链**
（`cmd:"saved"`）上。`native:download`（popup 的「下载」按钮）的完成回执
（宿主 `action:done/error/cancelled`）只被转发给 popup，**从不落地**。
真机复现：240000 字节的文件已经落盘，`history 0 → 0`、`lastResult` 为 null。
**跟关不关标签页没关系** —— 用户看到的现象是「记录消失」，实际是「这条链从来没记过」。
修法两处：`nativePort.onMessage` 收到 done/error/cancelled 时调 `notifySaved` 并把任务从
`downloads` 删掉；宿主 `sniffer_host.py` 的 done 消息带上 `size`（状态文件里没有这个字段，
干脆在本机 `os.path.getsize` 量一次）。
**修完真机复验**（仍然是在关掉标签页之后完成的）：`history 0 → 1`，
`lastResult 成功 · 240000 字节`。

### 顺手证伪一个猜测
「关标签页会不会清下载记录」——写一条探测记录后关闭目标标签页，`storage.session` 里
`history` 与 `tab:*` 都还在。**关标签页不清记录**，这条可以不用再查了。

### 数字与状态
- JS **829 项**（新增 `manifest_classify` 28 / `hls_family` 15 / `native_done_history` 16），
  Python **16/16**，`node --check` 全过，版本 1.3.43 → **1.3.44**
- 真机验证：清单分类修复后 mux 页面出现 4 条 m3u8（1 主 + 3 变体）；渲染文案已用真实条目
  跑 `renderItem` 复核；下载记录写入已复验
- 未做：51cg1 那三条**没有直接取证**（用 mux 三档流复现了同样的结构）。如果那站的三条
  结构不同（比如三档平级目录），`hls-family` 会退化成分「第 1/2/3 个清单」，不会瞎标主清单

---

## d-048 · 2026-10-24 · 产品化第一步：先立「会话」这个数据契约，行为一点不改

用户说「想把插件做成真正的产品」（方案见 `docs/PRODUCT-PLAN.md`）。方案里 L0 是数据契约，
这一步**不切流、不改任何现有行为**，只让新模型存在并与旧路径并行对照。

### 为什么先做这个，而不是先加功能
现在是一袋扁平条目（`rec.items`，一个标签页 400 条一视同仁），后面三件事**全都无处可挂**：
选清晰度没有 `variants` 这个概念；音视频双轨配齐没有 `tracks`；输出验证没有「这次该产出什么」
的预期，ffprobe 出来的轨道没得比。所以模型必须先立。

### 三条设计约束（不这样就白做）
1. **sid 必须幂等**：只用「主机 + 路径」，不吃查询串、不吃 hash、不吃条目内容。
   SPA 换一集视频 sid 不变是**故意的**——那是同一页面的不同会话，由 `state` 区分，不由 sid 区分。
   去重、历史库、断点续传全押在它上面，所以宁可保守。
2. **分片和图标永远不进 tracks**：`.m4s/.ts` 一个视频几百条，进来就把「一个视频」变成
   「几百条轨道」，UI 直接不可用。
3. **`confidence` 只能是离散等级**（strong / weak / conflict）：没有标注集就别造 0.92，
   那个数字一旦进代码，三个月后没人敢动阈值，因为它看起来像有依据。

`conflict` 的判据不是猜的：**同一角色同时有 MSE 录制和 http 直链**。小红书视频帖真机上
就出现过两条路径都给答案、而答案不同的情况（B7/B9 的现场）。

### 测试先红，红出一个真缺陷
`test/session_model.test.js` 69 项，先跑红（`extension/session.js` 不存在，直接 ENOENT）。
实现后第一轮就红了一条：条目袋里真的有 `null`（页面侧 post 过来的半成品），
`manifestOf` 里 `allItems.filter(it => String(it.k …))` 少一个 `it &&` 守卫就抛
`Cannot read properties of null`，整页 0 条。**这一条是测试抓的，不是想出来的。**

### 结果
- 新增 `extension/session.js`（纯函数，挂全局 `MSSession`，`background.js` 用 `importScripts` 加载）。
- `test/session_model.test.js` 69 项全绿；JS 全量 **805 项**（另有 `focus_scope` / `group_key`
  两套只在失败时输出，静默通过、不计入这个数）+ Python **16/16**；`node --check` 全过。
- 行为零改动：新旧两条路径并存，S1 才会开始消费它。
- 版本 1.3.42 → **1.3.43**。

### 教训
「纯函数层」也要写畸形输入测试。页面世界传来的数据比你想的脏：`null`、`u:123`、
`k:"weird"` 都在同一个数组里，一个守卫漏了就是整页无数据，而现场表现是「这站抓不到」。

## d-047 · 2026-10-23 · 变异测试一轮挖出三条边界缺陷：海量链接不是解法，海量输入才是

用户问「能不能喂海量链接做实验找潜在 bug」。我的判断是：**方向对，指标错**。

难点从来不是「链接不够多」，而是**没有 oracle**（标准答案）。链接喂进去，"下没下来"能自动判，
"下对没有"（是不是那条视频、有没有截断、音画同不同步）判不了。20 站审计第一轮就栽在这上面：
只读 raw state、没走 popup 过滤，于是把百度「23 张图全是噪声」当结论，实际过滤后只剩 4 张。
同一个坑，换成 1000 条链接只会放大。

还有四个硬伤：链接带 token 会过期（今天 100%、下周 70%，无法区分「我改坏了」和「站方过期了」）、
大量 case 要登录态、并发打站会被反爬、单条 5~30 秒导致 1000 条要几小时且大半失败是链接自身的问题。
**「假 bug 洪水」是最贵的成本**：500 条失败里 480 条不是你的 bug，人工复核的开销超过收益。

### 关键区分：两条链的测法完全不同

| | 下载链（native-host） | 嗅探链（extension） |
|---|---|---|
| 形态 | 纯函数 + `main()` 读 job json，**可完全脱离浏览器** | 必须真 Chrome + 真页面 |
| 适合的海量 | **输入形态**，万级、秒级、零网络 | **页面数量**，50~100 个 |

所以「海量链接」在嗅探链上是对的（20 站审计已经证明：4 个真缺陷全靠它），
在下载链上该换弹药：**变异 + 性质测试**。

### 做法：只断言不变量，不断言正确答案

新建 `tools/fuzz_host.py`，四区（sanitize / parse_hls_playlist / strip_masquerade / looks_like_hls_url）。
因为没有 oracle，所以不比对"应该输出什么"，只断言**永远不能违反的硬约束**：

- 文件名：非空、长度受控、首尾无脏字符、无非法字符、非保留名、**幂等**
- m3u8：不抛异常、`kind` 只有两个值、所有地址都是绝对地址、地址里不该出现 BOM/控制字符、media 不带 child
- 伪装分片：不抛异常、不变长、纯 TS 原样返回、剥壳后首字节必须是 `0x47`、幂等

**幂等性是性价比最高的一条不变量** —— 它不需要知道正确答案，却能逼出"常量定义不一致"这类 bug。

### 第一轮 2000 轮，出来两条

**① `sanitize("a." + "b"*300)` 返回 301 字符。**
`if len(name) > 100: root, ext = splitext(name); name = root[:100-len(ext)] + ext`。
`len(ext) = 301` 时 `100-301 = -201` 是**负切片**，直接失效、长度完全不受控。
301 > Windows 255 上限 → 真会建不出文件。现有 736 项单测一条都没覆盖，因为谁也没想过
"扩展名能有 301 个字符"。

**② `sanitize` 不幂等：`"\u3000.PRN.webm"` 洗一次得 `"\u3000.PRN.webm"`，洗两次才得 `"PRN.webm"`。**
根因是**两套不同的"空白"定义**：`str.strip()` 认全部 Unicode 空白（含 U+3000 全角空格），
而 `.strip(" .")` 只认 ascii 空格和点。前者去掉首尾空白，后者从左边剥点、撞到全角空格就停。
中文标题里"　第1集"这种前导全角空格很常见。
修法：抽 `_strip_edges()`，用 `isspace() or == "."` 统一判据，并**在截断之后再洗一次**。

### 补了一条不变量，又出来第三条

前两条修完，我把"地址必须绝对"放宽成"地址里不该有 BOM/零宽/控制字符"（H8），立刻报 258 次：

**③ 带 BOM 的 m3u8 会把首行 `#EXTM3U` 当成一个分片地址下载。**
BOM 让首行变成 `"\ufeff#EXTM3U"`，不以 `#` 开头 → 走分片分支 → 请求
`https://cdn/a/\ufeff#EXTM3U`，真机上就是拉回一个 404 或一段垃圾塞进文件头。

这条的教训比 bug 本身值钱：**只检查"格式是否合法"是漏得掉的，必须检查"里面有没有根本不该出现的字符"。**
修法是两层的：解码改 `utf-8-sig`（吃掉 BOM），`parse_hls_playlist` 入口再 `lstrip("\ufeff")` 兜一层，
行首再 `lstrip("\ufeff\u200b\u200e\u200f")`（零宽字符不是 `isspace()`，`strip()` 去不掉）。

### 顺手查出的第四条：`_safe_name` 是另一份实现，同样的病

`sniffer_host._safe_name` 和 `downloader.sanitize` 是两套独立实现（前者 150 上限、后者 100 且保扩展名）。
`safe_name` 的 `name[:150]` 在 `strip(". ")` **之后**，所以第 150 个字符正好是空格或点时，
留下 `"xxx "` / `"xxx."` —— 实测 `x*149 + " .mp4"` 就复现了。它更靠前（扩展传来的 name 先过它）。
修法：截断提前、`rstrip(". ")`、复查空值与保留名。
**两份实现本身就值得警惕**，这次先各自修好、在 `test/sanitize_test.py` 里对两边跑同一批边界用例，
防止再分叉。

### 结果

- 修完三个随机 seed × 8000 轮 ≈ **10 万次断言，硬失败清零**（只剩两条已确认有兜底的软警告：
  master 无子清单、`METHOD=NONE` 之外的 KEY 无 URI —— 前者 `run_hls_self` 有明确提示，后者 encrypted 一置位就交回 yt-dlp，不去取密钥）
- 新增 `test/sanitize_test.py`（66 项）把这次的坑钉住，`run_all.py` 自动纳入（Python 15 → 16 套）
- `tools/fuzz_host.py` 进 CI 当门禁（固定 seed 2000 轮，约 2 秒）
- 还顺带改了 `EXT-X-MAP` / `EXT-X-KEY` 的 URI 提取：原来只认双引号，
  而 `URI=key.bin`、`URI='key.bin'` 在真实打包器里都出现过。KEY 拿不到无所谓（交回 yt-dlp），
  但 **MAP 拿不到 init 段就是坏文件** —— fMP4 分片没有初始化段根本没法播，而这条路径是我们自己下的

### 一句话

「喂海量链接」想做的是**扩大样本量**，但真正缺的是**扩大输入形态**。
前者要处理网络、登录、过期、反爬，还得靠人眼判对错；后者几秒钟跑十万次，判据是机器能算的。
`tools/fuzz_host.py` 一共 400 行，第一条 bug 是在写完它之后的第 20 秒被打印出来的。

## d-046 · 2026-10-23 · 红果能下、腾讯是私有分片、西瓜没网页版；blob 条目按替代品取舍

三站补测（高德换成红果/腾讯/西瓜），结果和预期都不一样，值得分开记。

### 红果短剧：域名先搞错了一次

第一轮我按搜索结果的印象去开 `hongguo.com`，返回 `ERR_CONNECTION_CLOSED`，还以为是代理问题。
换 Clash 显式走、换 http/https 都一样。后来查实测帖才知道**官方域名是 `hongguoduanju.com`**，
`hongguo.com` 只剩跳转页。而搜索结果里排前面的 `novelquickapp.com` / `hongguoduanju.com?ref=xxx`
全是带推广参数的入口 —— 域名对不代表能当样本用，但域名错就一定测不出东西。

站本身是 A 类：`<video src>` 是完整 `https://v3-hgweb.qznovelvod.com/…mime_type=video_mp4`，
80 秒竖屏 10MB。curl Range 验证：`206` + `ftypisom` + `Content-Length: 10004275` + `Accept-Ranges: bytes`，
**去掉 Referer 也照样 206**。结论：现有下载链一行不改就能下。

### 腾讯视频：不是 DRM，是私有分片协议

预期是「DRM，确认边界就行」。实测分片 `ltscsy.qq.com/….ts?index=1&start=10880&end=21560&token=…`
取下来 652924 字节、`content-type: video/MP2T`、首字节 `0x47`、开头是标准 PAT(`47 40 00 10 00 00 b0 0d`)
—— **明文，没有加密**。所以「DRM 加密」这个标签对腾讯是错的。

真实障碍在于：`performance` 里 89 个资源只有 3 条媒体请求，**没有 m3u8**，清单来自私有 JSON 接口；
每片带独立 token、按毫秒区间切、约 10 秒一片。要拼完整正片 = 逆向播放信息接口 + 按序抓全 + 逐片处理 token。

用户实际能拿到的只有 `m1`~`m4`（appendBuffer 录到的已播部分）。这直接决定了下面的修法。

### 西瓜视频：站方自己撤了网页版

`www.ixigua.com` 的官方 title 就是「西瓜视频APP官方下载_安卓版_iOS版」，首页和 `/search/` 一律 302 到 `/app/`。
不是我们的网络问题 —— 手机 UA 能拿 `m.ixigua.com`，19 位数字 ID 的单视频 URL 也不跳，但桌面环境没有播放器可用。
`yt-dlp` 有 `Ixigua` extractor，所以这需求本质是「解析链接」，不该由浏览器扩展兜。

### 由此暴露的缺陷：blob 条目并排显示

红果 4 条「视频」里 3 条点了必失败（2 条 `blob:` + 1 条 0 字节占位），腾讯 6 条里 3 条 blob。

**原本是有意保守**：`hideRecorder()` 注释写着「只认 blob/mN 的站一旦也隐掉，用户什么都看不到」。
所以不能简单地把 blob 一律删掉 —— 那会把 Telegram 整站清空。

新判据是「看替代品」：同一页存在 `k=video/audio` 且 `http(s)` 且 `s>0` 的条目时，`blob:` 才有资格被删。
三点细节：

1. `s>0` 必须卡死。红果那条 0 字节的 `…/360p.mp4` 只是没拿到 content-length，
   拿它当替代品会把真能下的 10MB 直链一起挤掉。
2. **只删 `blob:`，不删 `m\d+`** —— 后者是 appendBuffer 录到的真数据，是腾讯正片唯一路径。
3. 按能力判，不按站名判（B22 的教训：按 `it.page` 分派导致带标题的 HLS 下不了）。

真机：红果 **42→40 条、视频 4→2、blob 0**；腾讯**完全不动**（本轮没抓到任何 http 视频直链，
`hasCompleteMedia` 为 false，按设计不该删）。第二行比第一行更能说明判据是对的。

### 方法论

- **「未登录能不能用」和「是不是 DRM」都必须实测。** 抖音那次我按 91rb 类推猜错，这次腾讯又差点贴上 DRM 标签。
- **搜索结果的第一个域名不一定是官方的**，尤其短剧/影视这类站点，仿冒站和推广入口排得比官网前。
- **验证「用户看到什么」不能读 `sniff:get` 的返回** —— 那是后台数据，popup 的 `shownItems()`
  还会再过滤一层。第一次验证时我读后台，得出「修了没效果」的错误结论，实际是测错了层。

## d-045 · 2026-10-23 · 20 站审计：图标过滤一直没看 URL

用户要求「测国内使用人数最多的 20 个网站」。这个任务如果按字面理解是无限的，所以先把**产出物**定清楚：不是「适配了 20 个站」，而是**「这 20 个站在真实用户手里表现如何」**。完整报告在 `docs/site-audit.md`。

### 方法

19 站（抖音已在 d-044 单独测），Chrome 156 + 游客态 + 独立 profile，逐站打开首页、等 13 秒，跑两轮：

- **第一轮**读后台 `state`（原始条目）
- **第二轮**开 `popup.html` 发 `sniff:get`（用户真正看到的、过掉 icon 之后的视图）

两轮必须分开：`state` 存的是原始条目，`sniff:get` 里才跑 `looksLikeIcon` 把图标标成 `icon` 再过滤掉。只读 state 会把「过滤得很好」误判成「噪声很大」——这个坑差点让我得出相反结论。

### 关键发现一：真正是缺陷的只有 4 个站

| 站 | 现象 | 性质 |
|---|---|---|
| 京东 | 316 张图（`m.360buyimg.com/babel/`） | **正确行为**：页面确实有这么多商品图/活动 banner |
| 淘宝/拼多多 | 大量商品图 | 同上 |
| 高德 | 7 张图**全是** `_next/static/media/` 图标 | 缺陷 |
| 芒果TV | 58 张，含 `apm.log.mgtv.com/s.gif` 埋点、`download_client.png` | 缺陷 |
| 百度 | `wenxinlogo`、`v.gif?logactid=` | 缺陷 |
| 支付宝/快手 | 极小图标、`web-app-logo.png` | 缺陷 |

**「图多」不等于「噪声」**。判据应该是「这张图是不是页面内容」，而不是「用户想不想要」——用户在京东页面，列表里有商品图是如实反映。

### 关键发现二：首页测不了下载能力

B站、小红书、腾讯视频首页 `video` **全是 0** —— 封面瀑布流，视频要点进去才创建播放器。所以这一轮只能量噪声，不能量下载。真要验下载必须进详情页（那是另一轮）。

### 根因：过滤只看 DOM，不看 URL

`looksLikeIcon()` 的判据几乎全建立在 DOM 上下文上（`hint` / `ic` / `w` / `h`），而 webRequest-only 的条目这三样**全空**。于是掉到最后的「裸条目」分支，那里只检查 `/assets/`、`.svg|.ico` 后缀和 24KB 体积线 —— **URL 里的 `icon` / `logo` / 埋点特征从来没被检查过**。

最刺眼的是高德：`satellite-icon.png` 21506 字节，名字里就写着 icon，却因为「不到 24KB 所以不够小、也不够大」而通过。

### 改法

新增 6 个 URL 判据，**全部排在 24KB 体积线之前**：

```js
UI_NAME_URL      // icon|logo|sprite|favicon|avatar|badge|placeholder|loading|btn…（词边界）
UI_NAME_GLUED    // 拼音拼接：wenxinlogo_
UI_DIR_PATH      // /controlbar/ /toolbar/ /navbar/ /skin/ /theme(s)/
TRACKER_URL      // 统计子域、/s.gif /v.gif、?logactid=、fourier 的 /ts
BUILD_ASSET_DIR  // /_next/static/media/ /static/media/
TINY_IMAGE       // 2KB 以下且无标题
```

**为什么必须排在体积线之前**：d-020 那次 47KB 的 `svg-next` 素材就是被 `s > 24KB → return false` 抢先放行的。同一个坑换了个站点还会再踩。

**为什么敢只按 URL 判**：真封面一个都不命中 —— B 站 `bfs/archive/<hash>.jpg@672w`、快手 `p*.yximgs.com/upic/…`、淘宝 `…_360x360`、小红书 `…/spectrum/1040g…!`。`TINY_IMAGE` 加了「有标题就不算」的保护。

### 真机验证（改后复测）

| 站 | 图（前→后） | 说明 |
|---|---|---|
| 高德 | **7 → 0** | 7 张全是构建产物图标，全清 |
| 百度 | 4 → 2 | logo + `v.gif` 清掉 |
| 快手 | 4 → 3 | `web-app-logo.png` 清掉，3 张视频封面保留 |
| 芒果TV | 58 → 41 | 埋点/按钮清掉；剩余见下 |
| 小红书 | 45 → 51 | **未误杀**（波动来自信息流不同） |
| B站 | 28 → 21 | 封面未误杀 |

`test/icon_filter.test.js` **20 项**（素材命名 7 / 埋点 3 / 构建产物 1 / 极小体积 3 / 误杀回归 5），先红 15 → 全绿；Node 12 套全绿。

### 有意不做的一件事

芒果剩下的 41 张是 `vipcdn.mgtv.com/upload4/mgtv_cashier/` 下的抽奖/支付弹窗背景（`LotteryDialog`、`red_pack_top`、`bg_light` 169KB）。再加一条 `dialog|popup|modal` 就能清光，**但那就是逐站适配的起点**——每加一条都在抬高误杀面，而芒果是 DRM 站、本来就不在支持范围。停在这里，写进报告的「已知局限」。

## d-044 · 2026-10-23 · 抖音探测：不是登录墙，但也没有一条完整地址

用户提「项目还剩两个任务：适配抖音、适配大部分网站」。为了不在猜的基础上排期，先花半小时只 dump 不改代码，判定抖音属于哪一类。结论与最初判断**一半相反**。

**最初的猜测（错的）**：91rb 是游客态不给内容，抖音大概也是登录墙。

**实测（Chrome 156，独立 profile，未登录）**：抖音 `modal_id` 页正常出画面，`<video> dur=602.9s、1290×720`，`currentSrc` 全是 `blob:`。所谓 `loginWall: true` 是我正则匹配到「打开 APP」引导的误判。

**接着撞上真正的墙**：

1. **页面变量里没有播放地址**。`<script id="RENDER_DATA">` 有 134KB 但无 `play_addr`；`_ROUTER_DATA` 是 undefined；`window.RENDER_DATA` 只有 `__reactFiber$` / `__reactProps$` 两个 DOM 引用键。
   → B 站那套「读 `__playinfo__` 拿 DASH 清单」在抖音**用不上**。
2. **yt-dlp 裸跑不行**：`ERROR: [Douyin] …: Fresh cookies (not necessarily logged in) are needed`。
   加 `--cookies-from-browser chrome` → `Could not copy Chrome cookie database`（Chrome 156 锁库/加密，yt-dlp issue 7271）。
3. **扩展侧 512 条里 8 条媒体全是碎片**：
   - `douyinvod.com/.../media-video-hvc1/` × 2（各 ~511KB，视频轨分片）
   - `douyinvod.com/.../media-audio-und-mp4a/` × 2（各 ~160KB，音频轨，**被归成 video**，因为服务端给 `video/mp4`）
   - `m2` 2.26MB（MSE 录到的视频）、`m1` 833KB / `m3` 1KB（MSE 录到的音频）

**判断 B 类站的关键，不是「有没有 blob」，而是「有没有一条能 Range 到头的地址」。**
抖音两样都有：`currentSrc` 是 blob，直链也是真的，但每条 `content-length` 只有 2475（206 分片）—— 603 秒的视频不可能只有 500KB，所以抓到的一切都是碎片。

**三个可选方案与代价**：

| 方案 | 代价 | 致命限制 |
|---|---|---|
| A 拼 DASH（init + N 片 + 音频轨 + ffmpeg） | 2~3 天 | 分片 URL 各带签名且有时效，脆弱 |
| B MSE 录制（复用已有 `appendBuffer` hook） | 1 天 | **只能存「播过的部分」**（和 Telegram A3 同病） |
| C cookie 链 + yt-dlp | 原估 2 天 → **实际低得多** | 见下 |

**C 的成本被一条既有实现砍掉了**：`background.js` 里 `buildCookieHeader()` 早就在用 `chrome.cookies.getAll({url})` 拼 Cookie 头，`downloader.py` 用 `yt-dlp --add-header "Cookie: …"` 递给它（不是 cookie 文件）。`useCookies` 默认 `true`。
**未验证**：yt-dlp 的 Douyin extractor 报错来自 `self._get_cookies()`（读 cookiejar）还是 HTTP 响应头。如果是前者，`--add-header` 无效、仍需写 Netscape 文件 —— 这是决定 C 是半天还是两天的分水岭，**下一期开工第一件事就是验它**。

**决定**：抖音**不进本轮收尾**，单开一期 v1.4。理由不是难，而是性质不同 —— 前面 22 条都是「已有链路的小缺陷」，这一条是**从没做过的新能力**，三个方案都不干净。收尾阶段做新功能 = 永远收不了尾。

**方法论**：「未登录能不能用」必须实测，不能从别的站类推。这次差一点因为 91rb 的经验，把抖音误判成不可用。

## d-043 · 2026-10-23 · 两条「HLS 流（视频）」分不清：给列表加行号

**用户**（贴 51cg1 详情页 popup 截图）：「这两个视频无法区分哪个是哪个，像这种就按出现顺序加上序号吧」。

截图里上面那条叫「HLS 流（视频）」，下面那条叫「抖音洗脑神曲 … 元素 001 · HLS 流（视频）」。
不是同一条重复出现（d-041 已经确认是两条不同的流），但两条的**类型名和副行一模一样**，
点错了下到的是另一路。

### 为什么现成的 ①②③ 帮不上

`background.js` 有一套圈码编号（`it.mark`），但它有两道门槛：

- `NUMBERED_KINDS` 只含 `image` / `video`，HLS 条目的 `k` 是 `video`，能进；
- 接着 `if (!xhsDetail && !it.mid && !(it.title||"").trim()) continue;` ——
  **51cg1 没有 mid**，第一名 HLS 又**没有标题**，直接被跳过；第二名有标题，
  于是自己一个人一组，编出「①」，列表里一片「①、①、①」正是 d-0xx 里修过的那类噪声。

也就是说，这套编号表达的是「**你在这一组里的第几个**」，而用户要的是
「**你在列表里是第几行**」—— 两件事，不能共用一套。

### 改法

`renderList()` 把显示下标传下去，`renderItem(it, no)` 在最左边建一个 `.no` 列：

```js
for (let i = 0; i < items.length; i++) box.append(renderItem(items[i], i + 1));
```

- 序号取**当前列表的显示顺序**（过完筛选 + `visibleItems()` 排序之后），
  所以它永远和屏幕上从上到下一致；切 chip 会重编，这是「出现顺序」的字面含义。
- 单独占一列，不进 `displayName()` —— 名字可能被 `shortTitle` 截断或 `-webkit-line-clamp`
  截行，塞进去会被吃掉。
- `.no { flex: 0 0 20px; text-align: right; font-variant-numeric: tabular-nums }`：
  定宽 + 等宽数字，否则 9→10、99→100 的时候名字列会左右跳。
- 位置在**勾选框右边**、类型徽标左边：批量模式下勾选框占最左是全局约定，
  两种模式下行号都贴着徽标，不跳。

### 验证

- `test/popup_wiring.test.js` 新增 `[8]` 6 条（先红 5 → 47/47）。JS 11 套全绿。
- 真机：Chrome 156 载入扩展，直接开 `chrome-extension://<id>/popup.html`，用 CDP 调
  `window.renderItem(it, n)` 塞 7 条假数据（含截图里那两条 HLS）截图。popup.js 是**经典脚本**
  （`<script src>` 不是 module），所以 `renderItem` / `el` 都挂在 window 上，**不用为了看样式
  另写一份 HTML 复刻**。
- 中途虚惊：按 400px 宽度截图时第 2 行标题看着溢出了卡片、右侧按钮也不见了。
  查几何发现 `html, body { width: 720px }` 是写死的，400px 的视口只是把 720 宽的 body 切掉了
  ——不是布局缺陷。按 720×580 重截，一切正常。

**教训**：`mark`（圈码）和「行号」是两个语义，前者表达归属、后者表达位置。
想用一个去顶另一个，就会出现「①、①、①」。

## d-042 · 2026-10-23 · 页面内进度卡：同一句话说两遍、0% 的死槽

用户贴了一张卡片截图问「这个怎么解决」。图里是页面右下角我们自己的「资源嗅探 · 保存」卡片：
**两行几乎一样的浅蓝/灰字**「正在下载视频流（完整流，与播放进度无关）…」，
下面一条**灰色的 0% 空槽**，再下面一个「取消」。

### 三处毛病，全是显示层的

1. **同一句说了两遍**。`uiStage()` 最后一句是 `UI.text.textContent = t`，
   它既写阶段行（蓝色小字）又写进度行（灰字）。两行并排，就成了截图那样。
2. **0% 死槽**。`uiStage(text, 0)` 把 `bar.style.width` 设成 `0%` 就撒手了。
   B 站那条整条流要跑几十秒到几分钟，用户看到的是一条永远不动的灰槽 ——
   这跟 d-040 在 popup 里刚修的是同一个病，页面浮层没跟上。
3. **文案是写给开发看的**。「（完整流，与播放进度无关）」在解释实现；
   而且这句解释在**点保存前**的确认浮层（站点 `saveHint`）里已经讲过一遍了。

### 改法

- **职责切开**：阶段行只说「在做什么」，进度行只说「数字/等了多久」。
  `uiStage` 不再碰 `UI.text`，`uiProgress` 不再拼阶段名（原来 `else` 分支会
  `parts.join() + " · " + name`，把标题又抄一遍）。
- **不确定进度用会走的光带**：`uiSetWaiting(on)` 用 Web Animations
  （`bar.animate`）跑一条 34% 宽的蓝绿带子来回扫，拿到真实百分比就 `cancel()`。
  没用「注入 `<style>` + `@keyframes`」是因为这是 MAIN world 的脚本，
  往用户页面 `<head>` 里塞全局样式容易和站点 CSS 打架，且撤销要靠改内联样式。
- **计时收归一处**：新增 `uiTick`（500ms），没有字节时报「已等 N 秒」，
  超过 `PROBE_HINT_AFTER`（8s）补「仍在连接，可点取消」；有字节但 1.2s 没新进展
  才补「等待数据…」。顺手删掉 `runRangeDownload` 里那个自己起的 `probeHintTimer`
  —— 它往**阶段行**写「已等 Ns」，和心跳抢同一块屏幕，卡片上会出现两处不同的计时。
- **文案**：「正在下载视频流（完整流，与播放进度无关）…」→「正在下载完整视频流」；
  `saveHint` 改成「保存的是整段视频（不是只存正在播的那一段）…」。
- **失败态**：红条铺满。原来失败后进度条停在半路的那一截，看着像「下了一半」。

### 真机验证抓到一个我自己刚写进去的 bug

自动化 33 项全绿之后，我在 Chrome 156 里加载扩展、开本地页、调 `__msUiApi` 截图 ——
**光带完全看不见**，卡片上还是一条灰槽。读计算样式：

```
bar: { width: "108.8px", backgroundImage: "none", marginLeft: "105.475px" }
```

`background: none`。原因是我在 `uiShow()` 里为了防止「上次失败的红条留到下次」写了
`UI.bar.style.background = ""` —— **把 `uiEnsure()` 里用 cssText 设的渐变一起清掉了**。
宽 34%、动画在跑、几何采样从 -98 扫到 319（`probe_bar.mjs` 那 10 个采样点），
一切"正确"，但屏幕上什么都没有。

修法：把填充色抽成常量 `UI_BAR_FILL`，`uiEnsure` 和 `uiShow` 都用它；
并补了两条测试（`C3` 必须有填充色、`J5` 失败后重开要复原成渐变）。

### 测试

新建 `test/ui_card.test.js`（**39 项**）：自建假 DOM（`style.cssText` 要能解析出
`width`、元素要能 `animate`）+ 假时钟（`Date.now` 可推进）+ 可控 `setInterval`，
覆盖「阶段行/进度行各写什么」「光带动画起没起、停没停」「已等 N 秒」「结束态」
「卡片重建」「红条复原」「文案里不许有术语」。

**回归**：JS **11 套**全绿（新增 1 套）、Python **15 套**全绿、`node --check` 通过。
真机：Chrome 156，未知总长 → `text="已等 4 秒"` / `bar=34%` / 光带扫动；
已知总长 → `bar=50%` 且动画 `cancel`；结束 → `100%` + 收起阶段行 + 出「打开所在文件夹」。

### 教训

1. **「状态对了」不等于「看得见」。** 几何、动画、计算样式（除了 fill）全部正确，
   用户看到的仍是一条灰槽。自动化能断言「有没有动画」，断不了「肉眼能不能看到」——
   涉及视觉的改动必须真机截一张图。
2. **清空一个属性，等于把它的来处一起抹掉。** `style.background = ""` 看着像"恢复默认"，
   实际是"删掉 uiEnsure 里设的那条渐变"。要复原就复原成**那个具体值**，别写空串。
3. **让同一块屏幕只有一个主人。** 这次三处毛病里有两处（重复文案、两处计时）
   根子都是「两个函数写同一个元素」：`uiStage` 和 `uiProgress` 都写 `UI.text`，
   `probeHintTimer` 和心跳都写阶段/计时文案。

**涉及文件**：`extension/inject-main.js`（`UI` 状态、`uiShow`/`uiProgress`/`uiStage`/`uiDone`、
新增 `uiSetWaiting`/`uiTick`/`uiStartTick`/`uiStopTick`、`UI_BAR_FILL`、
B 站 stage 文案、`saveHint`、删 `probeHintTimer`、`__msUiApi`/`__msUiCard` 调试出口）、
`test/ui_card.test.js`（新建，39 项）、`extension/manifest.json`（1.3.38）

---

## d-041 · 2026-10-23 · 带标题的那条 HLS 只能「保存」：按类型分派，不按来源分派

修 B22。用户原话：「上面那个是什么，我测试的时候发现它用不了，下面那个能用」。

**先纠正一个我写待办时的错误判断。** B22 当初记的是「同一条 HLS 出现两次，要去重」——
**不是**。B20 对照组 dump 出来的两条地址根本不同：

```
hls.weagdnz.cn/videos5/932dd69d…/932dd69d….m3u8?auth_key…    38.5 KB  ← dplayer 钩子（page=1，带标题）
hls.weagdnz.cn/m3m/d41c6e6e….m3u8                            4.2 KB   ← webRequest 抓的
```

路径不同、体积不同，是**两条不同的流**（一条是播放器配置里的主清单，一条是实际在放的子清单），
所以「去重」这个方案从根上就不成立。真正的毛病只有一个：**按钮按来源分派，而不是按类型分派。**

**根因**：`popup.renderItem` 先看 `it.page`：

```js
if (isPage) { 预览 / 保存 }            // 数据由页面自己取
else        { 复制 / 打开 / 预览 / 下载 } // 交给本地下载器
```

dplayer 钩子从 `.dplayer[data-config]` 读出来的地址是**页面侧上报**的，所以 `page=1`，
哪怕它明摆着是个 `.m3u8`。而「保存」那条链路是给 Telegram（blob 地址、页面上下文带 Range、
512KB 限制）和 B 站（`__playinfo__`）设计的 —— 点下去页面会去 Range 拉那个 m3u8，
拿到 **38.5KB 的清单文本**。用户的感觉就是「上面那条用不了」。

**更讽刺的是文案**：`isHlsItem()` 分支**无条件** push「点下载自动拼成完整视频」，
可上面那条根本没有「下载」按钮 —— 文案在教用户点一个不存在的按钮。

**修法**（`extension/popup.js`，四处）

1. `if (isPage)` → `if (isPage && !isHlsItem(it))`：HLS 条目落到通用分支，
   拿到「复制 / 打开 / 下载」，下载走本地下载器。
2. HLS 不挂「预览」：Chrome 的 `<video>` 不会放 HLS（扩展页更没有 hls.js），
   点开必然「预览加载失败」，比没有按钮更让人困惑。
3. HLS 不进批量选择（`selecting && isPage && !isHlsItem(it)`）：
   否则「保存所选」会批量下一堆清单文本。
4. `startDownload` 的文件名兜底：页面条目没有 `it.f`（那是 webRequest 侧按 URL 推的），
   但**有标题**。不给名字，落盘就是 `d41c6e6e…11260.mp4` 这种哈希 ——
   真机现场的文件名就是这样，用户下完认不出是哪一集。改成 `it.f || shortTitle(it.title)`。

**测试**：`test/popup_wiring.test.js` 加 `[7]` 五条静态检查（页面分支排除 HLS /
通用分支仍有「下载」/ HLS 不挂预览 / HLS 不进批量 / 有用标题当文件名兜底），
并把 `[2]` 里原来断言 `if (selecting && isPage)` 的那条同步更新（否则它会被这次改动打破）。

**回归**：JS **10 套**全绿（`popup_wiring` 36→**41** 项）、Python **15 套**全绿、
`node --check` 通过。版本 1.3.37。

**教训**

1. **待办要写「现象」不要写「方案」。** 我在 B22 里直接写了「同地址去重」，
   今天一 dump 才发现根本是两条不同的流 —— 如果照着那句待办开工，会去写一个
   永远不触发的去重逻辑，而真正的问题（按钮分派按来源而不是按类型）原封不动。
   现象可以猜错原因，方案写进待办就会被当成结论继承下去。
2. **分派键选错，后面每条规则都会歪。** 这里「数据从哪来」（page vs webRequest）
   被当成了「该怎么下」。而决定下法的只有一件事：**这条地址是不是分片清单**。

**涉及文件**：`extension/popup.js`（`renderItem` 分派与预览/批量条件、`startDownload` 文件名兜底）、
`test/popup_wiring.test.js`（+5 条，改 1 条）、`extension/manifest.json`（1.3.37）

---

## d-040 · 2026-10-23 · 准备期不再是死寂：阶段文案 + 会走的进度条

修 B21。用户原话：「为什么要等很久，才会开始下载，为什么不做成图二（Chrome 下载气泡）的样式」。

**先把「等」量出来**：真机 `dl-1792678232528-m20cx` —— 22:10:33 写 `percent=0`，
**22:12:21** 才第一次跳到 93.9%，**近 2 分钟界面一动不动**，之后 50 秒跑完。
不是卡死，是两段**纯等待**：

1. `run_hls_self` 自己试一遍：拉主清单 → 有子清单再拉一次 → 查 `EXT-X-KEY`/BYTERANGE
   → 第一片当探针，最多试 **4 档请求头组合**，每档一次真实 HTTP
2. 交回 `run_ytdlp`：它还要拉清单、把几百个分片的表建好，进度行要
   **真正开下第一片**才出现

**为什么不能改成像 Chrome 下载气泡那样**（这条也写进了 DEVELOPMENT.md B21）：
那是 **Chrome 自己的下载管理 UI**，只能表达「一个 URL → 一个文件」。
HLS 是几百个请求拼一个文件，`chrome.downloads.download({url: m3u8})` 只会把
**播放列表文本**存下来（d-031 那个 38.5KB「视频」就是浏览器版的原样复现）。
原生气泡还完全不可定制：显示不了「第 30/178 片」「地址过期已刷新重下」「转 mp4 失败：…」，
取消按钮也管不到我们的 Python 子进程（1.3.34 改完能在 5 秒内真停）。

**修法**

1. `native-host/downloader.py` 新增 `Phase`：写一句「在干什么」，每 2 秒补
   「（已等 N 秒）」。
   **关键设计是自限**：ticker 每次写之前先读状态，发现 `message` 已经被别人改掉
   （`write_progress` 清空 / 写了 done/error）就自己退出。所以调用方**不需要**在
   每条 `return` 前记得 stop —— 忘了停就是 d-034 的翻版：整场下载全程挂着
   「解析播放列表」。测试里 T2/T3 就是钉这件事的。
2. 三个落点：`run_hls_self` 的「解析播放列表」→「探测分片请求头（最多 4 档）」；
   `run_ytdlp` 开头加「交给 yt-dlp 解析清单（分片多时要等一会儿）」，第一条
   `MSPROG|` 进来就停。
3. `extension/popup.js` 的 `updateJob` **以前只拼百分比，宿主写的 message 根本
   看不见**（截图里那行永远是「… · 下载中」）。改成 message 优先显示。
4. `popup.css` 加 `.job.wait`：percent 还是 0 但有阶段文案时，进度条变成一条
   来回走的光带（`@keyframes jobwait`）。这不是假进度，是明确表达「在忙，但还估不出百分比」。
5. done / error 分支显式 `classList.remove("wait")`，否则光带会一直走下去。

**测试**：新建 `test/host_phase_test.py`，**先红 4 条**（Phase 不存在 / 解析期无文案）
→ **10/10 全绿**。覆盖：建立即写文案；计时器补「已等」；`write_progress` 之后文案必须停
且不把 percent 写回 0；写完 done 后不许被覆盖；`run_ytdlp` 解析期必须有文案、
跑完 message 为空、状态仍是 done。
`test/popup_wiring.test.js` 加 `[6]` 六条静态检查（渲染 message / 兜底「下载中」/
挂 wait 类 / 结束摘 wait 类 / CSS 有动画和关键帧）。

**回归**：Python **15 套**全绿（34.6s）、JS **10 套**全绿、`node --check` 通过。版本 1.3.36。

**教训**

1. **「没有进度」和「没有事情发生」是两回事，但用户只看得见前者。** 估不出百分比时
   该给的不是一个假百分比，而是**正在做什么 + 已经做了多久**。
2. **后台写了不等于用户看得见。** 宿主一直在推 `message`（`poll_job` 的 snapshot 里
   就有它、变了就推），但 `updateJob` 只拼 percent —— 整条链路是通的，只有最后
   三行渲染把它丢了。改 UI 前先确认「数据到底有没有到」，别把传不过去的东西算成没写。

**涉及文件**：`native-host/downloader.py`（`Phase` 新增、`run_ytdlp` / `run_hls_self` 接入）、
`extension/popup.js`（`updateJob`）、`extension/popup.css`（`.job.wait` / `@keyframes jobwait`）、
`test/host_phase_test.py`（新增）、`test/popup_wiring.test.js`（+6）、`extension/manifest.json`（1.3.36）

---

## d-039 · 2026-10-23 · `done` 的判据从「谁说自己成功」换成「目录里有没有真视频」

修 d-037 记下的 B19。**d-037 当时把根因猜偏了一半**——以为是「取产物取了错的那个」，
实际是**上游把成功误判成了失败**，然后兜底路径又「成功地」下了一份清单。完整链路是一组三段互锁：

**真机现场**（2026-10-22 23:13，`dl-1792678232528-m20cx`）：

```json
{"status": "done", "percent": 100,
 "file": "D:\\…\\d41c6e6e…11260",     // 29,251 B，内容是 #EXTM3U
 "message": "ERROR:"}                  // 光秃秃一个字面量
```

同目录里躺着 `<base>.mp4` **170,275,712 B / 首字节 `ftyp iso6`**——真视频。

**三段链路**

| # | 代码位置 | 发生了什么 |
|---|---|---|
| 1 | `run_ytdlp` 尾部扫描 | yt-dlp **下成了**（170MB mp4 落地），但 returncode=0 的情况下还打了一行**内容为空的 `ERROR:`**。`post_err` 取到它 → 整单被误判失败 |
| 2 | `main()` 的兜底 | 看到 `status=="error"` → 调 `run_urllib`，把 **m3u8 地址当普通文件下**，落盘成 `<base>`（29KB 清单） |
| 3 | `run_urllib` 成功分支 | `write_status(status="done", file=<base>)` **没传 message**，合并式写入把上一步的 `"ERROR:"` 原样留着 |

于是「真视频下好了、界面报 done、但指向清单、还挂着个 `ERROR:`」。

**为什么之前修不掉**：`done` 的判据一路都是**存在性**——「这一路说自己成功」
（退出码 0 / `final_file` 非空 / `looks_like_playlist` 为假）。从没任何一处问过
「目录里到底有没有一个**真视频**」。d-033 结尾写的「把 done 提成状态机级硬约束」
指的就是这件事，这次落实了。

**修法**（`native-host/downloader.py`）

1. `is_real_media(path)` —— 按**魔数**认视频：`ftyp`(mp4/mov)、EBML(mkv/webm)、
   `RIFF…AVI `、`FLV\x01`、`OggS`、`ID3`/MP3 帧同步、以及 MPEG-TS（`0x47` 起始 + 188 周期连续 5 点）。
   体积下限只用来挡残片，定在 **64KB**——判是不是视频靠魔数，不靠体积；
   线画太高（先写了 1MB）会把十几秒的真短片误判成失败。
2. `find_done_product(outdir, base)` —— 只在 `<base>.*` 里挑**最大的真视频**。
   裸 `<base>`（清单）和 `job2.mp4`（相近名字）都不会被选中。
3. `run_ytdlp` 的失败分支：`returncode == 0` 且 `find_done_product` 有货 → 直接 done，
   那行 ERROR 当噪声丢掉。
4. `run_urllib` **开头**先 `find_done_product`：目录里已有真视频就直接收工，
   不再去下清单（这就是第 2 段被掐断的地方）。
5. `run_urllib` 成功后再验一次内容：`looks_like_playlist` → 删掉刚下的文件、报
   error「只下到播放列表，请用扩展里的『下载』」，不再报 done。
6. `cleanup_ytdlp_junk` 增加第四类：**无后缀的 `<base>` 且内容是清单**（yt-dlp 猜不出
   扩展名时连后缀都不给，旧代码靠后缀认人必漏）。
7. 所有 `done` 分支显式 `message=""`，不让上一段的提示残留。

**测试**：新建 `test/host_product_test.py`，**先红 10 条**（红得很准：`status=done`、
`file=…\p4\job`、`message=ERROR:`，和真机一字不差）→ 修完 **19/19 全绿**。
覆盖：魔数判定（mp4/TS/清单/过小/不存在）、产物挑选（挑真视频、不串任务、只有清单返回空）、
「m3u8 当文件下完不许报 done」、「已有真视频时兜底必须收成 done 且 file 指向它」、
「rc=0 + 空 ERROR 行 + 真产物 = done」、「合并写入不许残留 message」、
「无后缀清单要清掉、真视频和相近名字不许删」。

**回归**：Python **14 套**全绿（50.2s）、JS **10 套**全绿、`node --check` 全部通过。版本 1.3.35。

**教训**

1. **「报错」和「失败」不是一回事。** `ERROR:` 这一行在 yt-dlp 的语境里可能只是
   「某一片重试了一下」，退出码才是硬信号。反过来，**退出码 0 也不是成功**（d-027）。
   两头都不可靠时，只能去看**产物本身**。
2. **兜底路径是缺陷的放大器。** 「A 失败就试 B」的结构里，B 从来不知道 A 到底失败在哪，
   于是会把 A 的**部分成果**覆盖成一个更糟的结果（这里：用 29KB 清单覆盖 170MB 成片）。
   设计兜底时第一步该是「先看看 A 是不是其实成功了」。
3. **判据要选在被观察对象的本质属性上。** 文件是不是视频，答案只能从**文件头**里读，
   扩展名（谁猜的）、体积（可能被截断）、上游的自我报告（可能是假的）都只是旁证。

**涉及文件**：`native-host/downloader.py`（`is_real_media` / `find_done_product` 新增，
`run_ytdlp` 失败分支、`run_urllib` 入口与成功分支、`cleanup_ytdlp_junk` 改动）、
`test/host_product_test.py`（新增）、`extension/manifest.json`（1.3.35）

---

## d-038 · 2026-10-23 · 91rb 测试：抓不到不是扩展的问题，是站方不给游客播放器

> 结论先说：**无法下载，原因在站方的登录墙**。这一条不是缺陷记录，是一次「确认我们没坏」的测试。

**测试对象**：`https://www.91rb.com/videos/321534/2-1149/`（用户 2026-10-22 提出「明天测试一下」）

**第一次启动就踩了环境的坑**：Chrome 打开页面后 `readyState=complete` 但 `url` 是
`chrome-error://chromewebdata/`、正文是「无法访问此网站…`ERR_CONNECTION_CLOSED`」，扩展抓到 **0 条**。

排查分层：

| 路径 | 结果 |
|---|---|
| curl 直连（`--noproxy '*'`） | 超时 15s，`http=000` |
| curl 走 agent 环境代理 `127.0.0.1:2937` | `CONNECT tunnel failed, response 502` |
| curl 走本机 Clash `127.0.0.1:7897` | `schannel: failed to receive handshake`（连 google 也一样，说明是 curl 显式 CONNECT 这条路不通） |
| **Chrome 走系统代理（WinINET = 127.0.0.1:7897）** | **页面正常打开**，标题「…不擦 (1) - 91热爆」 |

**根因**：agent 的 bash 里注入了 `http_proxy/https_proxy=127.0.0.1:2937`（沙箱代理），
从里面启动的 Chrome 会落到沙箱网络里；必须用「跳过沙箱」的方式启动 Chrome，
它才会读 Windows 系统代理设置（`HKCU\...\Internet Settings\ProxyServer = 127.0.0.1:7897`，Clash Verge 的 `verge-mihomo`）。
**以后测这类站，Chrome 一定要在沙箱外启动，否则必然 `ERR_CONNECTION_CLOSED`。**

**页面真身**（沙箱外重测，`htmlLen=126,561`）：

```html
<div class="player-holder">
  <div class="no-player" id="limitplayer">
    <img src=".../321000/321534/preview.jpg">
    <span class="message">游客试看已达上限<br>登入会员以解锁精彩内容！</span>
  </div>
</div>
<script>var pageContext = { videoId: '321534', loginUrl: 'https://www.91rb.com/login-required/' };</script>
```

- `<video>` **0 个**、`<iframe>` **0 个**、HTML 里 `.m3u8` / `.mp4` 命中 **0 次**、`video_idHits` 只匹配到变量名本身。
- 播放器**根本没被创建**（容器是 `no-player` + `#limitplayer`），所以浏览器一次视频请求都没发出去，webRequest 自然什么都看不见。

**扩展侧结果**：26 条 —— `other 11 / image 14 / font 1`，**`video` 0 条、HLS 0 条**。
唯一沾边的是 `preview.jpg`（封面图，`hint` 里带 `no-player`）。

**对照组（同一次会话、同一个调试 Chrome）**：换成 51cg1 的页面 → **158 条**，
`video 6 / seg 4 / image 84 / HLS 2 条`（其中一条带站点标题、`page=1`，正是 B22 里那个"只能保存"的条目）。
**→ 扩展、原生宿主、页面钩子全都正常，91rb 的 0 条是站方行为。**

**结论**：`免登录 → 不能下载`，这一档可以下「浏览器实测通过」的证据，但**不能**说「扩展不支持这个站」。
要验证登录态下能不能下，得有账号（用户手动登录，或提供 cookie 后由宿主带上）。

**教训**

1. **「抓不到」先分清是"抓不到"还是"没有可抓"。** 这次页面里连一个视频地址都不存在——
   webRequest 再强也只能看见网络层真的发生过的请求。判断依据要落到「页面有没有创建播放器 / 有没有 `<video>` / HTML 里有没有地址」，
   而不是「扩展条目数为 0」。
2. **对照组是最省时间的排查手段。** 同一台机器、同一份扩展、同一次会话里跑一个已知能抓的站（51cg1 158 条），
   一句话就能把「是不是我们坏了」排除掉，比反复读代码快得多。
3. **代理要看是哪一层。** 同一个 7897，curl 显式 CONNECT 不通、Chrome 走系统代理却通——
   说明「本机能不能访问某站」这个问题，用 curl 的结论不能直接套到浏览器上。

**涉及文件**：无（纯测试，未改代码）
**状态**：已完成（档位：浏览器实测通过；结论为「站方登录墙，未登录不可下载」）

---

## d-037 · 2026-10-22 · 产物是对的，状态是错的：`"ERROR:"` 与一个播放列表冒充视频

> 这条是**观测记录**，不是修复记录。用户 22:13 收工前把这三件事定成「明天做」（`DEVELOPMENT.md` B19），
> 这里先把真机证据钉住，免得明天重新复现一遍。

**发现过程**：用户在 51cg1 同一页面点了第三次下载（另一集）。收尾巡检时读状态文件：

```json
{"status": "done", "percent": 100,
 "file": "...\\d41c6e6e…11260",
 "message": "ERROR:"}
```

`done / 100` 看着没问题，但两个字段都很怪：`file` 没有扩展名，`message` 只有一个字面量 `ERROR:`。

**真机证据**（目录实况，两个文件并存）：

| 文件 | 大小 | 头部 | 判定 |
|---|---|---|---|
| `<base>` | 29,251 B | `#EXTM3U` / `#EXT-X-MAP:URI="https://mts.hhjd.mobi/yk218/m3u8-v5/83c/…"` | **播放列表正文**，不是视频 |
| `<base>.mp4` | 170,275,712 B | `ftyp iso6` | **真 MP4**，就是用户要的东西 |

也就是说：**下载本身是成功的**（这一集是 fMP4 切片，yt-dlp 原生 HLS 下载器直接拼出 mp4，
全程没调 ffmpeg，所以 d-032 那个 remux `Permission denied` 这次根本没触发），
坏的是**上报层**：`file` 指着播放列表、`message` 指着一个没说内容的错误。

**三个待修的点**（明天动手，先写红测试）：

1. **`message` 是空壳 `"ERROR:"`** —— `run_ytdlp` 扫尾部取含 `ERROR:` 的那一行，
   而这一行本身没带内容。等于「报了错但不说是什么」，用户只能猜。
   方向：往后多取几行拼出真原因，或者干脆判 `error` 而不是 `done`。
2. **`file` 指错产物** —— 取产物那一步选中了无扩展名的 `<base>`。
   方向：**用魔数校验而不是扩展名校验**（`ftyp` / `0x47` / 图片签名），
   顺便把 d-033 的教训捡起来：`done` 应该是状态机级硬约束，别散在各分支各判一次。
3. **垃圾没清** —— `cleanup_ytdlp_junk()` 靠后缀认人，只覆盖 `<base>.m3u8`，
   认不出 `<base>` 这种「内容是播放列表但没后缀」的形状。

**教训**

1. **「文件存在」和「文件是你要的东西」是两回事。** 前一版修的是「完成但目录里没文件」（B15），
   这一版是「完成、有文件、但指的那个文件是播放列表」。判据一路都是**存在性**，
   从没校验过**内容**——这类缺陷会一直换面貌冒出来，直到判据换成魔数。
2. **能下成功的路径和会失败的路径不是同一条。** 上一集走 `run_hls_self` + remux，撞 ffmpeg；
   这一集走 yt-dlp 原生 fMP4，碰巧绕开了。所以「上次修好了」不能推断这次也走了同一条路。

**涉及文件**：`native-host/downloader.py`（`run_ytdlp` 尾部扫描、取产物逻辑、`cleanup_ytdlp_junk`、`looks_like_playlist`）
**状态**：待做（B19，用户定为明天）

---

## d-036 · 2026-10-22 · 点「取消」没作用：换个下载器接着下

**发现过程**：修完 B17 做真机冒烟，取消任务后 3 秒界面显示 `cancelled`，
但输出目录里又冒出了文件、状态被覆盖回 `downloading / percent 0`。
一查进程：下载进程还活着，而且在跑 **yt-dlp**。

**根因**：`main()` 的三路分派只把 `done` 当停止条件：

```python
if run_hls_self(job, quiet=True):
    st_h = read_status(job_id)
    if st_h.get("status") == "done":   # ← cancelled 不在这里
        return
    hls_msg = ...
run_ytdlp(job, ytdlp, ffmpeg)          # ← 取消后照样执行
```

`run_hls_self` 在取消时 `return True`（「我处理了」），但 `main()` 只认 `done`，
于是取消被当成「这一路没搞成」→ 掉进 yt-dlp 兜底继续下 → 状态被覆盖成
`downloading`。**用户点取消等于没点，只是换了个下载器。**
`run_ytdlp` / `run_urllib` 自身也没有任何取消守卫，等于兜底路径完全不设防。

**另一个坑（更容易被误判）**：`sniffer_host.do_cancel()` 会**立刻**回
`{"action":"cancelled","status":"cancelled"}` 给扩展。也就是说界面上的
「已取消」只是宿主的**确认回执**，不代表进程真的停了。我第一轮就是被这条
假信号骗过，以为修好了——直到看见目录里又有文件。

**修法**：

- `main()`：`if st_h.get("status") in ("done", "cancelled"): return`。
- `run_ytdlp()` / `run_urllib()` 开头各加一道守卫：已有取消标记就直接写
  `cancelled / 用户取消` 返回，**不 spawn 外部进程**。
- `_fetch_segment(..., should_stop=...)`：每轮重试前问一次要不要停，命中就抛
  `_Cancelled`，由主循环既有的分支统一收尾（删 `.part` + 写 cancelled）。

**为什么要加 `should_stop`**：取消真正落地要等在途分片收尾。改动前真机量到
**70 秒**才停（在途分片正把 3 轮退避跑完，而每轮里还有 `_hls_get` 自己的 3 次
尝试 + 45 秒 socket 超时）。加了它之后分片在下一轮之前就放弃。

**验证**：

- 新建 `test/host_cancel_test.py`，**先跑红 5 条**：
  `main()` 取消后仍调 yt-dlp、`run_ytdlp` 无守卫时直接抛 `FileNotFoundError`、
  `run_urllib` 无守卫时真去连网（`Tunnel connection failed: 502`）。
  改完 **11/11 全绿**（含「取消能立刻打断分片重试」，断言只跑了 1 轮）。
- Python **13 套全绿**，JS 642 项不受影响。
- **真机复验**（4kvm，178 片）：取消后状态 `cancelled / 用户取消`、
  `.part` 已删、无遗留进程；**收尾用时 5.09 秒**（改动前 70 秒，14 倍）。

**教训**：

1. **「收到确认」不等于「事情做完了」。** 回执是异步的乐观信号，验证必须落到
   最终状态 + 副作用（进程、文件）上。
2. **兜底路径最容易漏掉前置条件。** 主路径写了 `if done: return`，兜底路径就
   顺手被执行了——凡是「失败后换个办法再试」的结构，都要先问一句「这真是失败吗」。
3. 取消、超时、重试这三类「异常出口」要做成**层层可打断**的，否则一个 45 秒的
   socket 读就能让用户对着按钮等一分钟。

**涉及文件**：`native-host/downloader.py`（`main()` 的 cancelled 分支 /
`run_ytdlp` 与 `run_urllib` 的取消守卫 / `_fetch_segment(should_stop=...)`）、
`test/host_cancel_test.py`（新）。

---

## d-035 · 2026-10-22 · 一个分片断流打死整单：给分片加外层退避重试

**问题**（用户自己的下载现场，属于 51cg1 复验期间顺手撞到的）：

```
下载分片失败（30/178 已下）：IncompleteRead(528064 bytes read, 1614008 ...
```

178 片下到第 31 片，服务端把连接掐了；异常一路抛到主循环 → 整单判失败、
`.part` 删掉 → **前 30 片全白下**。用户手动重试一次（同样的地址、同样的网络）
立刻成功 —— 说明是**瞬时抖动**，不该等于整单失败。

**为什么原来是这个行为**：`_hls_get` 本来就有 2 次重试，但两次是**紧接着**的
（间隔 0.6s / 1.2s）。服务端抽风几秒的话，3 次尝试会全部撞在同一个窗口里，
然后 `raise last` 抛出去；`fetch()` 在 worker 线程里抛，主线程只拿到一个
光秃秃的 `IncompleteRead`，既不知道是第几片，也没机会补。

**修法**：

- 新增 `_fetch_segment(url, headers, attempts=3, backoff=1.0)`：在 `_hls_get`
  之外再套一层，退避 **1s → 2s**，合计横跨约 3 秒的抖动窗口；**4xx 立刻返回**
  （地址过期/防盗链重试一百次还是同样结果，不浪费预算）。
- 返回 `(data, err)` 而不是抛异常：worker 里抛异常会丢掉「第几片」这层上下文。
  主线程拿 `None` 就 `raise _SegmentFailed(idx, err)`，由外层统一写提示。
- 提示从「下载分片失败（30/178 已下）：IncompleteRead(...)」改成
  「下载分片失败（30/178 已下）：**第 31 片重试 3 轮仍失败**：IncompleteRead(...)。
  网络抖一下不会这样，多半是这一片在服务端有问题，刷新页面换个地址重试」。
  **用户得能判断这是「网络抽风」还是「这片真没了」**，否则只会反复点重试。

**验证**（`test/host_segment_retry_test.py` 新建，**先跑红 5 条**）：

- 单片：连续断流 4 次 → 仍能取到，且请求次数 ≥5（证明外层重试真的生效，
  不是碰巧一次成功）。注意 4 次是**故意**选的：只断 2 次的话 `_hls_get`
  自己就能救回来，测不出新代码的价值。
- 单片：一直断 → 返回 `(None, err)` 不抛；`attempts=2` 约束请求轮数。
- 单片：404 → 快速失败，不重试。
- 端到端：某片连续断流 4 次 → 任务仍 `done`，**产物大小 = 6 片净长之和**
  （证明是补齐而不是跳过坏片凑数）。
- 端到端：某片一直下不来 → `error`，提示里带「第 5 片 / 重试 / 已下 N/M」，
  且不留 `.part` 残骸。
- 结果：**17/17 全绿**；Python **12 套**全绿（新套件 19.9s，是除大文件外最慢的
  一个，因为故意让重试跑满）；JS 642 项不受影响。

**教训**：

1. **「重试」要看间隔，不是看次数。** 3 次紧接着的重试和 3 次跨越 3 秒的重试，
   对「服务端抽风几秒」是两种完全不同的东西。
2. **异常要带上「哪一段」的上下文再往上抛。** 原始异常从 worker 线程冒到主线程，
   信息只剩「读了 528064 字节」，用户和排查的人都看不出严重程度。
3. 复验一个站的时候，**撞到的别人的报错也要捡起来**——这次 B17 就是 51cg1 复验时
   在 4kvm 的现场顺手抓到的，比原定的「文案问题」重要得多。

**涉及文件**：`native-host/downloader.py`（`SEG_ATTEMPTS` / `SEG_BACKOFF` /
`_fetch_segment` / `_SegmentFailed` / `fetch()` / 主循环 / 错误提示）、
`test/host_segment_retry_test.py`（新）。

---

## d-034 · 2026-10-22 · 51cg1 复验：能抓能下，但界面文案骗人 + 发现分片没有单次重试

**背景**：用户问「https://51cg1.com/archives/279033/ 这个网站的功能实现了吗」。
A5（1.3.27）当时修的是「抓不到」，这次要回答的是「现在能不能下」。

**真机结论（全新 profile + `Extensions.loadUnpacked`）**：

- **抓取 ✅**：109 条资源，HLS 条目带标题
  「推特约啪博主 FENDSON 付费新作 …人体艺术001」，`hint=hls`，`k=video`。
  标题末尾的 `001` **不是我们的 bug**——站点自己在
  `.dplayer[data-video_title]` 里就这么写的（钩子优先读该属性，退回 `<title>`）。
- **下载 ✅ 能下**，但走的是 **yt-dlp 兜底**而不是自实现 HLS。原因是**分片是
  AES-128 加密的**：取一个 `.part-Frag100` 看头部，前四字节 `b6 11 27 d2`，
  既不是 TS 的 `0x47` 也不是 fMP4 的 `ftyp`，是密文。这是 d-032 里
  `run_hls_self` 有意为之的 `bail(..., take_over=False)`——我们不解密，
  yt-dlp 能拉密钥，交给它才是对的。
- 实测进度：0.2% → 7% → 16% → 27% → 36.5% → **卡 35 秒** → 40% → 55% →
  61.8% → **87.7% 后停住近 3 分钟**，速度 6~8 MiB/s。

**修的问题：界面上的「解析播放列表」从头挂到尾。**

`write_status` 是合并式的（只更新传入字段）。自实现 HLS 开头写了
`message="解析播放列表"`，随后清单加密交回 yt-dlp，而 **yt-dlp 分支的进度更新
只写 percent/speed/eta，不碰 message**——于是从 0% 到 87.7%，界面上一直显示
「解析播放列表」。用户看到的信号是「卡在解析」，实际一直在下载。

修法：新增 `write_progress(job_id, percent, speed, eta)` 作为**统一进度入口**，
内部固定 `message=""`；yt-dlp 分支改走它。抽成函数而不是就地加一行 `message=""`，
是为了让它可被单测覆盖（`host_status_race_test.py` 3 条：percent 更新、
message 清空、status 仍是 downloading），也避免下次再加一条下载路径时又忘。

**顺手删了一处重复定义**：`downloader.py` 里 `read_status` 定义了两次，
第二个（无 docstring、在 `__main__` 前）**覆盖**了第一个带说明的版本。
改谁都生效不了的那一份最容易误导后来人，直接删掉后一份。

**新发现（待办，这次没修）**：复验期间用户自己在 4kvm 上点的下载报出——

```
下载分片失败（30/178 已下）：IncompleteRead(528064 bytes read, 1614008 ...
```

意思是**单个分片连接中断就整单失败**，前面 30 片全白下。`run_hls_self` 的分片
抓取没有「单片重试」，只有 `_hls_get` 里对 5xx/超时的小重试，`IncompleteRead`
这类半途断流不归它管。这是比文案重要得多的问题，已记成 B17。

**教训**：

1. **「有这个功能」和「用户看得懂现在在干什么」是两件事。** 合并式状态写盘 +
   多段下载路径 = 上一段的提示会粘在界面上。凡是切换阶段，就得显式清提示。
2. **加密清单交给 yt-dlp 是对的，不是缺陷。** 复验时要先看清楚「为什么走兜底」，
   别把设计当 bug 修。

**涉及文件**：`native-host/downloader.py`（`write_progress` / `run_ytdlp` 进度调用 /
删除重复 `read_status`）、`test/host_status_race_test.py`（3 条新用例）。

---

## d-033 · 2026-10-22 · 「完成」但目录里没有视频（第二次）——状态写盘撞车把真因吞了

**问题**：用户 21:20 点了另一集下载（`ch4q6cqou`），几分钟后目录里只有 31 个
`<hash>.mp4.part-FragN.part` 和一个 74 KB 的 `.m3u8`，**没有视频**；
而任务状态是 `status=done, percent=100`，`file` 指向那个 `.m3u8`，
`message` 是：

```
读取下载输出失败: [WinError 5] 拒绝访问。:
  '...\dl-1792675185945-orcp3.json.tmp' -> '...\dl-1792675185945-orcp3.json'
```

**根因 A（确证）：状态文件的「原子替换」和「0.4 秒轮询」抢同一个句柄。**

`write_status` 写 `<id>.json.tmp` 再 `os.replace` 成 `<id>.json`（这是为了防宿主
读到半个 JSON）；而宿主 `poll_job` 每 0.4 秒 `json.load(open(...))` 读同一个文件。
**Windows 下目标文件被别人持有句柄时，MoveFileEx 直接返回
`ERROR_ACCESS_DENIED`（WinError 5）**。窗口很短，但一个上千分片、跑 30 分钟的任务
要写几十上百次状态，撞上几乎是必然。

真正致命的不是「少更新一次进度」，而是**这个异常是从 `write_status` 里抛出去的**：
它恰好发生在 `except` 块「写失败原因」的那一行，于是——

1. 「为什么会失败」这条最重要的话没写进去；
2. 异常继续往外抛，进程带 traceback 退出；
3. 状态文件里留着**上一次成功写入的** `done / 100 / file=.m3u8`。

用户看到「完成」，目录里却没有视频。**这是「假成功」的第三种成因**：d-031 是判据
选错（扫退出码/尾部而不是产物），d-027 是退出码 0 不可信，这一次是**上报通道自己
把判据吞了**。

**根因 B：yt-dlp 失败后不收拾自己的碎片。** `<base>.mp4.part`、
`<base>.mp4.part-FragN.part`、`<base>.mp4.ytdl` 全留在输出目录。这次 31 个文件
共 9.2 MB，看着不多，但本机 safe-delete 一次删 >50 个文件会被拦，用户又不知道
能不能删 → 「以后再说」等于永远清不掉。

**修法**：

- `_replace_retry(tmp, path)`：`PermissionError` 退避重试 10 次（10ms 起，
  上限 80ms，总计约 0.5 秒），仍失败则**退化为直接覆写**——宁可宿主读到半个 JSON
  （它有容错，坏 JSON 当空 dict），也不能让状态彻底写不进去。非权限类的 `OSError`
  不重试（换卷、路径不存在之类重试没意义）。**`write_status` 从此不抛异常**。
- `cleanup_ytdlp_junk(outdir, base)`：只认三类——`<base>.*.part*`、`<base>.*.ytdl`、
  以及**内容确实是播放列表**的 `<base>.m3u8`（`looks_like_playlist` 判定，那是
  「只下到清单」的残骸，不是视频）。最终成片 `.mp4/.ts/.mkv` 和名字相近的别的任务
  一律不碰（`base-extra.mp4` 这类靠 `base + "."` 前缀挡掉）。接在 yt-dlp 的两个
  失败分支上。

**验证**：新增 `test/host_status_race_test.py`，**先跑红 10 条**（不重试、异常抛出、
碎片没清、函数不存在），改完 **18/18 全绿**；Python 11 套 / JS 642 项全绿。

**没查清的**：这一单**为什么没走自实现 HLS 而回退到 yt-dlp**——原因被根因 A 吞了。
已排除防盗链：该清单 1017 个分片、无 `EXT-X-KEY`、无 `BYTERANGE`，分片
`https://cs.wuxiais.com/movie/.../5db400000.ts` 带不带 Referer 都返回 200 / 1,402,104 字节。
修完 A 之后如果再失败，`message` 里就能看到真实的三路原因；同时该 m3u8 已 404
（一小时内失效，和 d-032 的一次性地址一致），无法原地复现。

**教训**：

1. **上报失败的代码本身不能成为失败源。** 日志/状态写盘这种人畜无害的收尾动作，
   一旦会抛，恰好会把「为什么失败」抹掉——排查时看到的现象会指向完全错误的方向。
2. **「原子替换」在 Windows 上不是无锁操作。** 有另一个进程在读，就得准备重试。
3. **假成功第三次以不同面貌出现**（退出码 → 判据 → 上报通道）。下一步该把
   「`done` 必须同时满足 `file` 存在且不是播放列表」做成状态机级别的硬约束，
   而不是散在各分支里各判一次。已记进待办。

**涉及文件**：`native-host/downloader.py`（`_replace_retry` / `cleanup_ytdlp_junk` /
`write_status` / `run_ytdlp` 两个失败分支）、`test/host_status_race_test.py`（新）。

---

## d-032 · 2026-10-22 · 4kvm 下载不下来：PNG 壳分片 + 一次性地址

**问题**：用户问「https://www.4kvm.net/ 这个网站的功能实现了吗」。抓取侧完全正常
（popup 只剩一行「无耻之徒(美版) 第二季 - 第1集 · HLS 流（视频）」），点下载必定失败。

**两条根因，缺一条都解释不了现象**：

1. **地址一次性/短时效**。同一条 m3u8，抓到后放 15 分钟再下就 `HTTP 404`；
   刷新页面会换成一个全新的 hash 文件名（`93334d…` → `c15a6c…`）。
   这不是防盗链（防盗链一般是 403），是**签发即作废的一次性签名**。
2. **分片是伪装的**。把分片下下来看头部：`89 50 4E 47 0D 0A 1A 0A` 是 PNG 签名，
   跟着 IHDR/pHYs/IDAT/IEND，`IEND` 结束在 **offset 112**，**紧接一个 `0x47`**——
   之后按 188 字节采样，50/50 命中同步字节。也就是说：**112 字节 PNG 壳 + 真 MPEG-TS**。

**排查中试过但不管用的**：

- `yt-dlp --retries 10 --fragment-retries 10`：514 个分片，每个都重试 10 次，
  进度卡在 0% 好几分钟——它把壳当数据下，拼出来的 TS 也不对。**分片数一多，
  重试就成了灾难**：失败一次不是多花几秒，是 ×10。
- 直接拼 TS（不剥壳）：ffmpeg 认不出流，报一堆 `Packet corrupt`。
- Referer 方向**和常见站点相反**：4kvm/xhscdn 的分片**带 Referer → 403，
  不带 → 200**。浏览器侧是 hls.js 用 `referrerPolicy: no-referrer` 发的，
  所以「把 Referer 补上」这种常规修复在这里是反向操作。

**修法一：自己下 HLS（`native-host/downloader.py`）**

- `strip_masquerade(data)`：在**前 4096 字节**里找「连续 5 个包都是 0x47」的偏移，
  从那里截断。不看固定 offset 112——站点随时可能改壳长度；也不信 `data[0]==0x47`
  就早退（真 TS 原样返回，不误伤）。
- `parse_hls_playlist(text, base_url)`：`urljoin` 补绝对地址；master 清单取
  **最大 BANDWIDTH** 的子清单；`EXT-X-KEY` 出加密标记、`EXT-X-MAP` 出 init 段、`EXT-X-BYTERANGE` 出分片区间。
- `run_hls_self(job)`：**先探一片**（4 档请求头依次试：原样 → 去 Referer →
  去 Referer+Origin → 只留 UA/Cookie），哪档通就整单沿用；然后滑动窗口并发
  （`Semaphore(workers*2)`）+ **主线按 index 顺序写盘**——不把 1.4 GB 读进内存，
  也不落成几百个临时文件（本机 safe-delete 一次删 >50 文件会被拦，临时文件根本清不掉）。
- `main()` 分派改成 **m3u8 先走自实现**，搞不定再 yt-dlp、再直连；
  失败时三条原因**都保留**（不然用户只看到 yt-dlp 的 404，看不出是自己 HLS 那层先挂的）。

**修法二：地址过期自动重取（`extension/background.js`）**

报错里带「时效/过期/404」且这单是 m3u8、且还没重试过 → 记一条
`pendingHlsRetry.set(tabId, {oldUrl, deadline})` → `chrome.tabs.reload(tabId)`；
页面重新上报条目时，若出现**新的** m3u8（必须排除 `oldUrl`，reload 后页面会先重放
缓存里的旧地址）就用它重下一次，并推一条「视频地址已过期，已刷新页面重新开始」。

两个细节是踩出来的：

- 等待窗口 **25 秒 → 120 秒**。第一次复验失败，SW 里是
  `pending: [{"left":-63}]` 而新地址其实已经进 state 了——页面 reload + 重新拉流
  实测要 10~20 秒，慢网络更久。
- **`record()` 那两处也必须接线**。4kvm 的 m3u8 **只由 webRequest 抓到**，
  不走 `ms:page` 的 found 分支；只接后者等于没接。

**验证**：

- 真机：`run_hls_self` 2.8% → 84.7%（约 18 MB/s），产物 1.3 GB `.ts`，
  首字节 `0x47`、无 PNG 签名、大小等于 6 个分片净长之和、末尾对齐 188。
- 端到端（全新 profile + `Extensions.loadUnpacked`）：拿一条**已过期**的
  `93334d….m3u8` 发起下载 →
  `t+6s` 报错「自实现 HLS: 拉取播放列表失败：HTTP 404」、`job.retried=true`、
  等待表登记成功 → `t+9s` 等待表被消费、**出现新任务**、地址换成 `49d94eb…m3u8`
  → 百分比 0.9 → 2.8 → 5.6 → … → 47.1%。**整条链路跑通**。
- 测试：新增 `test/host_masquerade_test.py`（29 项，含本地 mock 服务器，
  `/seg-*` 故意「带 Referer 一律 403」复刻真机方向）；`test/background.test.js`
  新增 `[HRTY]` 18 项；`test/host_download_job_test.py` 补「三路全失败时自实现
  HLS 的原因也保留」。JS 642 项 / Python 10 套全绿。

**已知限制**：

- **remux mp4 在本机一律 `Permission denied`**。试过 `.part` 后缀、`-f mp4` 显式容器、
  写系统 temp 再 `shutil.move`，全失败；`bin/ffmpeg.exe` 在 WorkBuddy shell 里本身
  也起不来（rc=3221226505），但**被 Chrome 拉起的宿主里能跑**。判定为本机安全软件
  限制未签名 exe 写入，不是代码问题。TS 本身可播，所以 done + message 里说明原因。
- 自动重取**只有一次机会**（`job.retried` 一次）。第二次还 404 就把错误如实抛给用户——
  再刷页面也拿不到更新的地址，只是消耗站方一次请求。

**教训**：

1. **「下载失败」要分两层看**：能不能下（地址还有效吗）、下的对不对（数据是不是真视频）。
   这次两条同时坏，只修一条都还是失败。
2. **重试次数在分片场景是会放大的**。514 片 × retries 10 不是「多等一会」，
   是把一次失败变成十分钟卡死——先判断分派顺序，别急着调大重试。
3. **别信「加 Referer 更安全」**。防盗链方向可以是反的，用 4 档请求头探针实测，
   比照抄经验可靠。

**涉及文件**：`native-host/downloader.py`（`strip_masquerade` / `parse_hls_playlist` /
`_hls_get` / `_header_variants` / `run_hls_self` / `main` 分派）、
`extension/background.js`（`pendingHlsRetry` / `shouldRetryHls` / `retriedHlsUrl` /
`maybeStartHlsRetry` / `maybeUseRetriedHls` / `record` 接线）、
`extension/popup.js`（`native:download` 补 `tabId`）、`test/host_masquerade_test.py`（新）、
`test/background.test.js`、`test/host_download_job_test.py`、`test/review.test.js`。

---

## d-031 · 2026-10-22 · HLS 只下到播放列表却报「完成」

**问题**：真机复验 A5 时，51cg1 那条 m3u8 点下载，进度条 0% → 100%、界面显示
「完成」，落盘却是一个 **38,299 字节的 `.m3u8` 文本**，不是视频。

**根因**：yt-dlp 对这条地址走了 **generic 分支**——没认出是 HLS，于是把清单本身
当普通文件下载。这种情况退出码是 **0**、尾部也没有 `ERROR:`，而 d-027 那次
（4kvm ffmpeg 重封装失败）修的正是「退出码 0 不可信，要扫 tail 里的 ERROR」，
这条恰好两种判据都躲过去了。

**修法**：加 `looks_like_playlist(path)`，判据落在**文件头**而不是扩展名——
扩展名是 yt-dlp 按响应 content-type 猜的，同一份清单可能存成 `.m3u8` / `.m3u` / `.txt`。
体积先兜一刀（>256KB 直接当视频，不读头），因为清单只有几 KB。
done 分支改成先校验产物：命中就报 `error`，文案说清「只下到播放列表，不是视频，
多半是该站需要 Referer/Cookie 或清单加密」。

**测试**：`test/host_hls_test.py` 新增 8 条（先红 3 条：函数不存在、done 分支没调用、
文案缺失），覆盖 `#EXTM3U` 文本 / mp4 魔数 / 文件不存在 / 空路径 / 超阈值大文件。
Python 9 套全通过，JS 625 项不受影响。

**没做的**：`final_file` 为空（yt-dlp 没打 `FILE:`）时仍然直接判 done。
那种情况拿不到产物路径，只能靠输出目录扫描，代价大于收益，先记着。

**教训**：**「成功」要有产物证据。** 退出码、无 ERROR、进度到 100% 三样齐了
仍然可能是假成功——用户要的是视频文件，判据就该落在文件本身。

**涉及文件**：`native-host/downloader.py`（`looks_like_playlist` + done 分支）、
`test/host_hls_test.py`。

---

## d-030 · 2026-10-22 · Telegram 序号与焦点全失效——Web K 换了消息号属性

**问题**：登录态下真机复验 1.3.18 / 1.3.26，发现 Telegram 上**一条序号都编不出来**、
打开相册查看器列表也不收窄。同一套编号代码在小红书详情页正常（24 条 `①…㉔` 连续）。

**真机 dump（Chrome 156 + 当前 Web K，已登录）**：

| 断言 | 实测 |
|---|---|
| `[data-message-id]` 元素 | **0** |
| `[data-mid]` 元素 | **37**（`.bubble` 14 / `.album-item` 3 / `.grid-item.media-container` 20） |
| `.text-content` / `.message-text` | **0 / 0** |
| 抓到的 image/video 条目 | 17 条，`mid` 有值 **0 条**、`mark` 有值 **0 条** |
| 打开相册后 `__msActiveSite().focus()` | `""` |

**根因**：K 版把消息号从 `data-message-id` 换成了 `data-mid`，而 `mediaContext()`
只读前者 → `mid` 恒空 → `numberShown` 认为「既没 mid 也没标题」整批 `continue`。
焦点那两条路径（`tgFocus` / `tgFocusByMedia`）也依赖同一个属性，一起失效。

**层级陷阱**：`data-mid` **每一层都有**，而且值不一样——同一条消息实测
`.bubble` 是 `4294972868`，里面三个 `.album-item` 是 `…868 / …869 / …870`。
按「最近的祖先」取会把一条消息拆成三条、每条只剩一张图；必须取**最外层**
命中的那个。

**一个必须纠正的误判**：我先以为分组键是 `kind + mid + ref`、所以补 `mid` 也
会图文分池。读代码后确认 `gk` 是**标题优先**（`t:标题` → 才退回 `kind|mid|ref`），
d-029 真机 `①→⑲` 连续正是因为那 19 条都有标题。所以「图文分池」只发生在
**抓不到标题**的时候——而 Web K 改了正文类名后标题大面积抓不到（17 条里 14 条
无标题），补 `mid` 后会重新踩进这个坑。**两件事必须一起改。**

**修法（1.3.28，页面侧 + 后台侧 + 弹窗侧三处）**：

1. `inject-main.js` 新增站点钩子 `msgBox(el)` / `msgId(box)`：Telegram 实现里
   逐层往上读 `data-mid || data-message-id`，**最后一次命中的**才是消息容器。
   通用层仍然只认 `data-message-id`，`data-mid` 一个字都没进通用逻辑
   （避免误伤其他也用这个属性的站点）。
2. `mediaContext` / `orderMediaInMessage` / `ordOfMedia` 三处统一走 `msgBoxOf()`。
3. `background.js` 分组键顺序改为 **mid → 标题 → kind|ref**；
   `popup.js` 的 `sameGroup` 同步（不然编号对了、排序会按体积乱掉）。

**产品语义变更（有意，需记账）**：同上标题的多条消息**不再跨消息连号**，
每条消息各自从 ① 起。理由：①一条消息就是一个内容单元；②焦点收窄是**按消息**
过滤的，编号若按标题、焦点按消息，一收窄就错位。代价是用户会看到多组 ①②③。

**测试**：先写红再改绿。`[TGK]` 新增 7 条（main-hook）+ 4 条（background），
并按新语义改写 `group_key` 的 6 条旧断言（原断言写的是「跨消息连号」）。
改前红 10 条，改后 **JS 625 项全绿 / Python 9 套全通过**。

**真机**：调试实例里重载扩展（1.3.28）后，在真实页面构造 `.bubble[data-mid]`
+ 内层 `.album-item[data-mid]` 的结构，`__msActiveSite().msgBox/msgId` 返回
`999001`（不是内层的 `999002`）、`__msOrderInMessage` 返回有效 ord。
会话消息本身因网络拉不下来，**完整真机（真实消息的 ①②③ 与焦点收窄）待补**。

**教训**：
1. **「属性名换了」比「逻辑错了」更常见。** 两次「修过还不对」都是盯着算法，
   实际是数据源换了（d-029 是 ord 语义、这条是属性名）。先 dump 页面结构，
   再怀疑代码。
2. **层级注解要取最外层。** 内层相册项带自己的 mid 是「这一格」的号，不是
   「这条消息」的号。取最近一层会让所有计数从 0 重开——症状和 d-029 一模一样，
   但根因完全不同。
3. **改分组键必须三处同步**（background 两处 + popup 一处）。漏了 popup 就是
   B6 的旧症状「⑪ 在最上面、下面才是 ①②③」。

**涉及文件**：`extension/inject-main.js`（`msgBoxOf`/`msgIdOf`/`mediaContext`/
`orderMediaInMessage`/`ordOfMedia`/telegram 站点对象）、`extension/background.js`
（`renumberImages`/`numberShown` 的 `gk`）、`extension/popup.js`（`sameGroup`）、
`test/main-hook.test.js`（`[TGK]`）、`test/background.test.js`（`[TGK]`）、
`test/group_key.test.js`（G1/G1b/G4 改期望）。

---

## d-029 · 2026-10-21 · Telegram 序号「对不上」（第三次修）——两套计数流

**问题**：用户 m15907 附截图：「总数差不多，但是序号完全对不上，这个问题已经修过两次了」。
截图里消息 8848 的 13 条按「①图 ②视频 ③图 ④视频」交替编号。

**我最初的误判**：以为 8848 / 8847 是两条消息被同一标题合并了。
用户 m15935 纠正：「它们其实来自两条不同的消息，并不是，是一个消息」。
→ **教训：用户描述的「对不上」先要落到具体一条消息上看，别拿附近的数字猜。**

**真机事实**：消息 8848 一条消息里有 7 个 `<video>` + 若干 `<img>`。

**根因（两套各自从 0 起的计数流）**：
- 视频走 `ordOfMedia(el)`（`extension/inject-main.js:288`）：
  `const tag = el.tagName === "AUDIO" ? "audio" : "video";` 然后 `[...box.querySelectorAll(tag)]`
  —— **只跟同族 video 比**，所以 7 个视频拿到 ord 0..6。
- 图片走 `scanImages()` 的 `byMsg` 列表下标 —— **只跟图片比**，拿到 ord 0..3。
- background 的 `compareWithinGroup`（`extension/background.js:1042`）先按 mid 升序、
  同 mid 再比 ord。两边 ord 撞车（视频 ord=1 和图片 ord=1 同时存在）时只能退回抓取时间 `t`，
  而 `t` 是异步到达时刻 → **随机**，于是显示成 ①图②视频③图④视频 循环错号。

**修法**：`ordOfMedia` 开头加一句，让视频也走「整条消息统一序」：

```js
const unified = orderMediaInMessage(el);
if (unified >= 0) return unified;
```

`orderMediaInMessage` 是 d-019 给图片写的：上溯找带 `data-message-id` 的祖先，
对 `video,audio,img` 统一按「同一行按 left、否则按 top、再退 DOM 序」排，返回下标。

**真机复验**：消息 8848 视频 ord 变成 `0,2,4,10,12,14,16`、图片 `6,8,9,18`，
不再从 0 重复计数；页面侧 `__msOrderInMessage` 对 19 个媒体返回 0..18 连续。

**教训**：
1. **两套计数器迟早会撞。** 同一实体（一条消息）下的不同类型的条目，必须有**一个**统一序号源；
   各算各的，只要有展示层把它们并排显示，就一定会出现「交错错号」。
2. 排序里一旦有「时间」这种异步量当兜底，错号就是**随机的**，每次都长得不一样——
   这恰恰是「修过两次还不对」的原因：每次都在修别的分支。

**涉及文件**：`extension/inject-main.js`（`ordOfMedia`）、`test/background.test.js`（`[TGORD]`）。

---

## d-028 · 2026-10-21 · 51cg1 / 4kvm「插件不起作用」——HLS 播放列表不是视频

**问题**：用户 m16052：「检查插件为什么对 https://51cg1.com/archives/279033/ 和
https://www.4kvm.net/ 这两个网站不起作用，为之后的通过大部分网站做铺垫」。

**51cg1 排查**：
- state 里该 tab **只有 2 条 other，`diag` 是 null** → `diagBump` 从未被调用，
  说明 **webRequest 一次都没触发**。
- 页面实测：`videos:0, iframes:0`，HTML 里 **0 个 `.mp4` / `.m3u8`**。
- 但找到 `<div class="dplayer" data-config="{...}">`，属性里挂着完整配置：
  `{"video":{"url":"https://hls.weagdnz.cn/videos5/….m3u8?auth_key=…","type":"hls"}}`。
- 容器内部只有 `<div class="dplayer-loading">播放器加载中...</div>` ——
  **DPlayer + hls.js 根本没初始化成功**，浏览器从没请求过那个 m3u8，
  所以 webRequest 什么都看不到。地址明明摆在 DOM 上，却没人去读。
- 顺手 curl 那个 m3u8：200、39399 字节、`#EXT-X-KEY:METHOD=AES-128,URI="…/crypt.key"`（加密 HLS）。

**4kvm 排查**：
- 首页 66 条（image 56 / other 10），图片来自 `gimg0.baidu.com` 图床。
  **首页本来就没视频**，不算 bug。
- 详情页 `/play/ch4l5b3mn` 抓到 2 条 m3u8（`oss.douyinbit.com` 和备用域 `myoss.douyinbit.top`），
  两条都 `page:0`、**无标题**、`s:29007`（=播放列表文本大小）。
- **结论：扩展确实抓到了，但用户点「下载」拿到的是 29KB 文本，不是视频** ——
  主观上就是「不起作用」。

**HLS 链路验证（native-host 早就支持）**：
- `native-host/downloader.py` 的 `use_ytdlp` 判据里 `".m3u8" in low` → 真机跑 `downloader.py`
  下那个 m3u8，产物 **971 MB / h264 1920×1080 + aac / 53 分钟**。**链路是通的。**
- 但状态里 `status:"done"` 却又写着 `ERROR: Postprocessing: Error opening output files: Permission denied`
  —— yt-dlp 退出码 0，ffmpeg 重封装 mp4 失败却被报成 done。**假成功比失败更坑**。

**修法（四层）**：
1. `background.js` 新增 `isHlsUrl(u)`：只看 `new URL(u).pathname` 是不是 `.m3u8`，
   **不看 query**（站方 `?url=xxx.m3u8` 那种跳转链接抓到的是跳转前地址，判成 HLS 反而误导）。
2. `sniff:get` 里给这些条目打 `hint="hls"` —— **只打标记不改 `k`**，
   下载分派仍靠 `k=video` 走 yt-dlp。
3. `popup.js`：名字显示成「标题 · HLS 流（视频）」，副行写明
   「HLS 流 · 分片清单」「点下载自动拼成完整视频」——用户才知道那 29KB 不是坏文件。
4. `inject-main.js` 新增 dplayer 站点：读 `.dplayer[data-config]` 里的 `video.url`
   （退回 `video_h265.url`），用 `data-video_title` 当标题直接上报，绕开没起来的播放器。

**真机（51cg1）**：state 从「2 条 other」变成 **193 条**，视频第一条带标题
「推特约啪博主 FENDSON 付费新作 短发伪白虎美女体育生」、`hint:"dplayer"`。

**真机（4kvm）又踩一坑**：m3u8 条目抓到但没有标题，用户在列表里看到一条光秃秃的
「HLS 流（视频）」，不知道是哪一集。补 artplayer 站点：页面侧读 `og:title`
报一条 `hint:"hls"` 的「页面标题条目」，background 用 `applyHlsPageTitle()`
把标题**借**给同 tab 真正的 m3u8 条目、再把页面条目删掉（它的 URL 是网页，下下来是 HTML）。

**第二个坑：标题被砍过头。** `sitePageTitle` 第一版写「任何 1~10 字的尾巴都当站点名砍掉」，
`挑情丑闻 - 第1集 -4k影视` 被砍成 `挑情丑闻`。改成「尾巴带 `第N集/第N话/EPn/SnEn` 就不砍」。

**真机最终（4kvm）**：3 条 video → 2 条，标题都是「挑情丑闻 - 第1集」。

**教训**：
1. **「抓到了」和「能下」是两件事。** m3u8 是文本清单，抓到它不等于抓到视频；
   展示层必须说清楚「这是清单，点下载会拼成完整视频」，否则用户永远觉得坏了。
2. **webRequest 看不到的东西，DOM 里可能明明白白摆着。** 播放器起不来 = 零请求，
   但 `data-config` / `og:title` 照样在。两条发现通路要都试。
3. **退出码 0 不代表成功。** yt-dlp 把 ffmpeg 的失败吞进 stderr 还返回 0，
   必须自己扫 `ERROR:` 才算数。

**涉及文件**：`extension/background.js`（`isHlsUrl` / `applyHlsPageTitle`）、
`extension/popup.js`（`isHlsItem` / `displayName` / `hideRecorder`）、
`extension/inject-main.js`（dplayer / artplayer 站点）、
`native-host/downloader.py`（去掉 `--merge-output-format mp4`、扫 stderr 判失败）。

---

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
| [d-074](#d-074) | 2026-10-24 | 真机白屏：B27 UI 只落了一半 | 渲染块引用未声明的 timeRangePick，video 条目必抛 → 列表纯空白；补声明 + renderList 兜底（错误一句话代替白屏）+ 回放 harness 入库（popup 渲染路径从此有运行时回归）；教训：测试全绿的覆盖范围要说得出；1.3.63 |
| [d-073](#d-073) | 2026-10-24 | B27 ③层：自实现 HLS 按分片截取 | EXTINF 选片（不齐整段下）+ 只下覆盖分片（请求计数实测 seg1-3）+ remux 偏移精切；夹具自查出 TS+MAP 混拼错误；timerange_test 35 项；干净副本 27/0 |
| [d-072](#d-072) | 2026-10-24 | 真机首验四项全过 | 保存直下（无浮层+真实落盘 73821B）、诊断（1.3.62 回包）、整页解析（任务达宿主）、时间段（产品链边界确认 + yt-dlp 链 sections 实测 2.000s）；三条探针教训：profile 必须清空 / match pattern 不支持端口 / SW sendMessage 不回环；产品代码零改动 |
| [d-071](#d-071) | 2026-10-24 | B27 UI + 诊断包 + 空态粘贴链接 | 时间段输入行接通宿主；「诊断」一键复制（版本/记录/错误码/脱敏日志）；空态「粘贴链接」借 B28 有了实体；host_timerange_test 24 项补齐；JS 1153 项；1.3.62 |
| [d-070](#d-070) | 2026-10-24 | 保存直下：删确认浮层 | 浮层的手势理由已随 blob 改走 Native Host 消失，删整段（-160 行）换模块级队列 + dispatchSaveItem；顺带修批量路径 MSE 不分派；页面内进度卡即时反馈；反向验证 2 组全红；JS 1146 项；版本 1.3.61 |
| [d-069](#d-069) | 2026-10-24 | B28 落地：整页解析 | popup 按钮 + 右键第四项 → native:download-page → Netscape 临时文件 → --cookies（jar 形态），同发抑制 legacy 头，finally 保证每条退出路径删登录态文件；测试折出「cmd 批处理转发 % 会炸」；反向验证 3 组全红；Python 干净副本 26/0、JS 1145 项；版本 1.3.60 |
| [d-068](#d-068) | 2026-10-24 | B28 可行性一小时：GO | Netscape 转换器写通、B 站页面 URL 零适配提出 1080p、cookie 形态判别（jar 才是 extractor 可读形态，header 只到传输层）；抖音 headless 有验证码墙（探测局限，产品路径不受限）；落地约半天，排期待拍板 |
| [d-067](#d-067) | 2026-10-24 | B29 右键菜单：指哪打哪 | 三类菜单+页面解析器（capture 记录，currentSrc/srcset/picture/懒加载/背景图）；blob 降级问页面、问不到不静默；测试抓到 picture `<source>` 优先级写反（右键常拿到降级格式），已修；JS 1133 项；版本 1.3.59 |
| [d-066](#d-066) | 2026-10-24 | T-C10：主清单地址不再混进 variants | 判据复用 1.3.45 的 listKind，共享函数给构建/比较两端；新计数 masterSkipped（不是 missing 也不是 dropped）；反向验证三组全红；JS 1098 项全过、真机两页 shadow 仍绿；版本 1.3.58 |
| [d-064](#d-064) | 2026-10-24 | 真机验证自动化：headless Chrome + CDP 打穿 E 组大半 | `Extensions.loadUnpacked` 加载 1.3.57，SW 内 MSSession 存活、回放真跑、B 站两页双跑 `ok:true`、选 720 档 ffprobe 实测 1280x720；ffmpeg 拦截形态从「启动崩」变为「写盘拦」，按 exe 所在目录标签定案；工具收编 `tools/verify_headless.py` |
| [d-063](#d-063) | 2026-10-24 | 规则库落地：模板 + CI 门禁 + 六条真实案例 | 每条已启用案例必须解析出指向 `test/` 真实文件的引用（空库绿、坏引用红，门禁自身 25 项反向验证）；顺带把「本机全量 5 假红」钉死在 WorkBuddy 沙箱的根目录 `Low Mandatory Level` 标签——干净 worktree 全绿，本机验真绿到 CI/干净副本 |
| [d-036](#d-036) | 2026-10-22 | 点「取消」没作用：换个下载器接着下 | `main()` 只认 `done`，`cancelled` 照样掉进 yt-dlp；宿主的 `cancelled` 回执是乐观信号，不代表进程停了；顺带把取消延迟 70s→5s |
| [d-035](#d-035) | 2026-10-22 | 一个分片断流打死整单 | `_hls_get` 的 3 次重试是紧接着的，救不了「抽风几秒」；加外层退避 1s→2s + 错误带上「第几片/重试几轮」 |
| [d-034](#d-034) | 2026-10-22 | 51cg1 复验：能抓能下，界面文案骗人 | 抓取 109 条带标题、下载走 yt-dlp（分片 AES-128 加密，交回是对的）；「解析播放列表」粘在界面上源于合并式状态写盘 |
| [d-033](#d-033) | 2026-10-22 | 「完成」但目录里没有视频（第二次） | 状态写盘 `os.replace` 与宿主 0.4s 轮询抢句柄 → WinError 5 从「写错误原因」那行抛出，真因丢失、状态停在旧的 done/100 |
| [d-032](#d-032) | 2026-10-22 | 4kvm 下载不下来：PNG 壳分片 + 一次性地址 | 地址会过期（reload 重取）+ 分片是「112 字节 PNG 壳 + 真 TS」（按 0x47 周期剥壳）；防盗链方向是反的 |
| [d-031](#d-031) | 2026-10-22 | HLS 只下到播放列表却报「完成」 | 判据落在产物文件头（`#EXTM3U`）而不是退出码：退出码 0 + 无 ERROR 仍可能是假的 |
| [d-030](#d-030) | 2026-10-22 | Telegram 序号与焦点全失效 | Web K 把消息号换成 `data-mid` 且每层都有：取**最外层**，分组键改 mid 优先 |
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
