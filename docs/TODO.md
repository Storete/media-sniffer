# 待办总表（唯一权威清单）

> **为什么要有这份文件**：待办散在 `DEVELOPMENT.md` 的 B 系列、`PRODUCT-PLAN.md` 的 S 系列、
> `ACCEPTANCE.md` 的验收单、`ENGINE-EVAL.md` 的 P 系列里，任何一处单独看都会漏。
> 这份表把它们合成一处，**每一行都必须能追到一个来源和一条判据**。
>
> 规则：① 一次只动一行，动完改状态并写「证据」；② 新的待办只许加进本表，不许只写在 DEVLOG 里；
> ③ 「未测试」比「应该没问题」有价值，状态栏只有 `⬜ 未开始 / 🔄 进行中 / ✅ 完成（档位）/ 🅿️ 挂起`。

## A. 等真机确认（不算新工作）

| # | 事项 | 判据 | 状态 |
|---|---|---|---|
| T-A1 | 1.3.46 同片折叠在本机生效 | `chrome://extensions` 重新加载 + 刷新页面后，原来两行变**一行**，行尾有蓝色「切换」，chip 显示「视频 1」 | 🔄 等你 reload |

## B. 下载内核（ENGINE-EVAL 的 P 系列，**本轮从这里开工**）

| # | 事项 | 来源 | 判据 | 状态 |
|---|---|---|---|---|
| **T-B1** | **P1 续传指纹校验**：`.part` 记 `ETag` + `Last-Modified` + 总长度；任一变化就作废重下 | ENGINE-EVAL §4-P1 | 服务端换内容后**不会**拼出坏文件；无指纹的站仍能续传 | ✅ 1.3.47（自动化通过，未真机）<br>证据：d-052，反向验证 3 红 |
| T-B2 | P1-b 完整性浮点：读完的字节数 ≠ 总长必须判失败、保留 `.part` | 同上 | 提前 EOF 不再报 `done` | ✅ 1.3.47（同刀）<br>反向验证 8 红，老 bug 现场复现 |
| T-B3 | P0 多连接 Range：**先量吞吐**（1 vs 4 连接），<2× 不做 | ENGINE-EVAL §4-P0 | 实测倍数记进 DEVLOG | ✅ 已量：**1.06×（10.1 → 10.7 MB/s）→ 不做**<br>重新评估条件见 ENGINE-EVAL §4-P0 |
| **T-B4** | **P2 错误码表 + 重试**：429/403/超时/5xx 各有码、各有预算、文案说人话 | §4-P2 | 每步都有错误码，无「默默降级」 | ✅ 1.3.48（自动化通过，未真机）<br>证据：d-054；反向验证 15 红 / 2 红 / 8 红<br>**原案 12 码缺 429，已补成 13** |
| **T-B5** | **P3' 三路径收敛**：把 HLS / yt-dlp 两条路径接进同一张码表（HTTP 已接完） | §4-P3' | 同一原因三路径同码同文案 | ✅ 1.3.49（自动化通过，未真机）<br>证据：d-055；`host_paths_converge` 44 项<br>反向验证 20 红 / 2 红 / 1 红 / 2 红 |
| **T-B6** | **第四、五条路径接码表**：`run_merge`（B 站双流合并）+ 宿主 6 小时超时 | d-055 复盘 | 同一原因所有入口同码 | ✅ 1.3.50（自动化通过，未真机）<br>证据：d-056；`host_job_timeout` 27 项<br>反向验证 7 红 / 2 红 / 2 红<br>**码表 13 → 15**（补 `MISSING_DEP` / `JOB_TIMEOUT`） |
| T-B7 | **`find_tool` 可执行性探测**：存在但启动即崩（0xC0000409）的 exe 必须判「没有」 | d-056 现场 | 报 `MISSING_DEP` 而不是神秘退出码 | ✅ 1.3.50（同刀）<br>宿主与 worker 各一份，各自探测 |
| **T-B9** | **阶段 ticker 的竞态**：`done` 写完之后，陈旧的「探测请求头 1/4（已等 0 秒）」还能盖回 `message` | d-057 收尾（`host_phase_test` 连跑偶尔红 T3/T4） | `status=done` 时 `message` 必为空；比较与写在同一把锁里 | ✅ 1.3.51<br>证据：`write_message_if()` CAS + `_STATUS_LOCK`；`host_phase` 新增 T5/T6/T7 共 8 项<br>反向验证：CAS 退回无锁 → **T7a 红**；`write_status` 不进锁 → **T7b 红**<br>连跑 15 次 0 红（修前约 4/25）<br>**未覆盖**：这把锁只在本进程内。宿主 `mark_timeout` 与 worker 收尾是**两个进程**，仍可能互相覆盖（宿主写 error 后，worker 的迟到 `write_progress` 会盖回 downloading）。出现再单独立项 |
| T-B8 | Gopeed 旁挂引擎 | §5 | **S6 之后**，唯一触发：BT/magnet 成真需求 | 🅿️ 挂起 |

## C. 产品路线（PRODUCT-PLAN 的 S 系列）

| # | 事项 | 判据（硬指标） | 状态 |
|---|---|---|---|
| T-C1 | **S1 剩余的「选清晰度」**：popup 消费 `variants`，用户能选档 | **S1-2：选非默认档下载，`ffprobe` 实测宽高 == 所选档** | ✅ 1.3.51（自动化通过，产物宽高待真机）<br>证据：d-057；`host_variant_pick_test` 28 项<br>判据换轨：本机无 ffmpeg，改验「**实际请求了哪个档目录的分片**」（验行为，比验产物更靠前）<br>反向验证 9 红 / 1 红 / 2 红 |
| T-C2 | S1-3/4/5/6 真机六条（页面不被读体搞坏 / 开关可回归 / 大清单不卡 / 失败静默） | 见 `ACCEPTANCE.md` §6 | ⬜ |
| T-C3 | S0 Step2：`msBuildSession` 接进 `background.js` 与旧 `items` **双跑比对** | 三页字段级 diff 只有新增字段 | 🔄 1.3.52 接线完成，真机取证待做（T-E2/T-E3）<br>证据：d-058；`session_shadow` 49 项 + `background` 新增 15 项<br>判据落地：`ok = missing/changed/extra 全空`，`added` 由数据算<br>反向验证：去 images **3 红**、`ok` 恒真 **3 红**、mime 按数字比 **7 红**<br>取证入口：`{type:"ms:shadow", tabId}` 或省略 tabId 取全部<br>**顺带挖出两个洞**：会话原来没有 `images`（图集页面在会话里是空的）；测试沙箱缺 `URL` 导致 sid 静默空串还假绿 |
| T-C10 | **会话 `variants` 里混进主清单地址**（`x36xhzz.m3u8` 被当成一条没有分辨率的变体） | S1 眼里是个假档位、S3 规划里会被当成可直下地址 | ✅ 1.3.58（d-066）<br>判据用现成能力：hls-meta.js 解析正文打 `listKind`（1.3.45 已有），`isMasterListEntry()` 共享给构建与比较两端——**无元数据不猜**（webRequest 先到、正文没读时它可能是普通媒体）<br>`msBuildSession` 排除（假档位不进选档数据）；`msDiffSession` 同判据豁免 + 新计数 `masterSkipped`（不是 missing——popup 列表条目原样保留，点它宿主仍选默认档可下）<br>反向验证三组全红：A 构建端不排除 4 红（假档位回归/kind 误判 video）、B 比较端不豁免 2 红（双跑假红）、C 判据漂移 4 红——判据必须同一个函数，漂移立刻暴露<br>无头真机复验：B 站两页 shadow 仍 ok:true；无元数据边界钉住（不留死角的保守面） |
| T-C4 | S2 验证四层 + 12 错误码 | 删掉一个分片 → 界面说「分片缺失，已重试 3 次」 | ✅ 1.3.53（验证四层落地，第 4 层真机待验）<br>证据：d-059；`host_verify_test` 36 项<br>四层收成一个纯函数 `verify_product(path, expect, ffprobe)` → `(ok, code, detail, extra)`；四条下载链（直链/yt-dlp/HLS/合并）收尾统一走 `finish_verified`，**done 必经验证**<br>反向验证：废清单检查 6 红、废 ffprobe returncode 2 红、废缺轨道 2 红、废时长 2 红<br>**判据后半句「删分片→界面报错」要真机复验**（本机无 ffmpeg，第 4 层用假 subprocess 验逻辑）；「12 错误码」已在前几刀升到 15 码并全接线 |
| T-C5 | S3 规划表外置 + 表驱动测试 | 「这条为什么走 yt-dlp」能答 | ✅ 1.3.54<br>证据：d-060；`host_plan_test` 32 项表驱动<br>分派抠成纯函数 `plan_download(job, tools) -> {chain, reason, args, expect}`；`reason` 是人话「为什么」，进 `main()` 失败时的 `trail` 第一项<br>反向验证：废 hls 判定 2 红、废 use_ytdlp 7 红、废 merge 优先级 4 红<br>**后续**：S4 时 popup 复用 `plan_download`，reject 地址不显示「下载到本地」按钮 |
| T-C6 | S4 工作站（队列 / 续传 / 历史，关浏览器照跑） | 关浏览器后任务继续 | 🔄 **2026-10-24 与用户对齐：不再作为整体切片，拆块分别决策**（PRODUCT-PLAN §5/§4-L3 已同步补边界）<br>① **续传** ✅ 1.3.47（`.part` + ETag/Last-Modified 指纹）<br>② **历史** ✅ 已有（`chrome.storage.local` 本就跨浏览器会话；popup 记录 + 重试入口，`native_done_history` 19 项）<br>③ **队列（会话内）** ⬜ 可选：宿主已有 `poll_job`/6h 超时，浏览器活跃期间依次排队即可，半天~一天，**不碰安装形态**——想用再做，前后都可排<br>④ **关浏览器照跑（引擎常驻）** 🅿️ 独立立项挂起 v1.4，**触发条件量化：一周内真撞 ≥3 次「想关浏览器但下载没完」，撞到一次记一条 DEVLOG 留证**；凑不够就体面地不做（T-B3 样板）<br>**为何降级**：原「队列/续传/历史三合一、1 周」的表述有误导性——两项已完成、队列很便宜，1 周实际是「搬一次家」；发版闸门是 S6 不是 S4；未签名+常驻+监听端口是杀软高危组合（d-064 实证本机连 `bin/ffmpeg.exe` 写盘都拦），40–80MB 常驻内存成本前置、收益频率未量<br>**v1.4 立项时的现成素材**：方案 = `jobs.jsonl` + 常驻引擎（跨进程状态机 + 本地端口 token 鉴权 + 系统整合 + 真机验证）；引擎本体约 40–80 MB（不随任务数增长），吃内存的是临时拉起的 ffmpeg/yt-dlp 子进程（下完即退）；验收 = 提交 5 任务 → 关浏览器 → 重开全部完成且验证通过；大文件始终流式写磁盘（`.part`），「关浏览器就断」的根是任务状态活在会被随时杀的 SW 里、宿主生命周期绑定浏览器；**不做独立的下载历史页**，历史只作失败/完成记录载体（可重试 + 喂知识库分母） |
| T-C7 | S5 知识库双通道 + CI | 同站失败 3 次自动出建议 | ✅ 1.3.57（自动化通过，案例真实度待真机）<br>证据：d-061（解释库纯函数+宿主记账）+ d-062（popup 展示）+ **d-063（规则库：模板 + CI 门禁 + 回填 6 案例）**<br>1.3.55 解释库自动通道：`knowledge.py` 纯函数（site_key 归一化 / fail_signature / record_failure / explain），阈值 ≥3 才开口；宿主 `poll_job` 失败收尾记账+出建议<br>反向验证：阈值改 1 五红、site 不归一化 6 红、签名不看码 3 红、废建议 2 红、废记账 2 红<br>**抓到一个真死锁**：Lock 非可重入，记账持锁后再 load 死锁，改 RLock<br>1.3.56 popup 展示：建议改独立字段 `advice`/`adviceTitle` 透传，popup 失败记录里琥珀色 `.h-advice` 与红色 `.h-why` 分两行；反向验证：丢 title 1 红、退回拼 message 3 红、并进 h-why 2 红<br>**1.3.57 规则库（人工通道）**：`docs/compatibility/`（README 准入三件套 + 000-template）+ CI 门禁 `tools/check_compat_rules.py`（每条已启用案例必须解析出指向 `test/` 下**真实存在**文件的引用；空库绿、坏引用红）；门禁自身 `compat_gate_test` 25 项反向验证（无引用/坏引用/缺字段/缺小节/无 frontmatter/目录不存在全钉红，带 BOM 好案例钉绿）；回填 6 条真实案例（001 文件名边界 / 002 BOM 首行 / 003 TG 分组 / 004 编号时机 / 005 焦点丢失 / 006 封面误收，来源 d-047 + B6~B11，引用逐一验真）<br>**后续**：规则库新案例按「用户报告+根因+可复现测试」三件套随真机失败逐条进，硬塞 = 造假规则库 |
| T-C8 | S6 产品件七项（隐私政策 / 首次空态 / 诊断包 / opt-in 统计 / 发版通道 / 法律声明 / i18n） | 见 `PRODUCT-PLAN.md` §6 | 🔄 **两件就绪（1.3.62，d-071）**<br>✅ **诊断包**：popup「诊断」按钮一键复制——扩展版本 + 页面（脱敏）+ 条目统计 + 抓取诊断 + 最近 5 条下载记录（含 15 错误码）+ 内部错误日志（URL 域名化、去查询串）+ 引擎状态<br>✅ **首次空态**：「重新扫描」+ **「粘贴链接」**（B28 落地后有了实体：任意 URL 连本站 cookie 交本地解析器）+ 诊断行；「打开示例」暂缓（需长期稳定的示例页）<br>**发版三件（隐私政策/法律声明/发版通道）**：1.3.57 曾落地，随「暂不发行」决定被移除（d-065 同批）；恢复即重新实现，等发版决定再做<br>剩余三件：发版三件（待发版决定）+ opt-in 统计（需后端）+ i18n（大工程）<br>**真机首验（d-072）**：ms:diag 回包带 version 1.3.62 + 内部错误数组——诊断数据链路通 |
| T-C9 | L1-b 读**播放器 API JSON**（独立开关） | 排 S6 之后，唯一改变隐私边界的动作 | 🅿️ 挂起 |

## D. 待排期功能（DEVELOPMENT 的 B 系列）

| # | 事项 | 判据 | 状态 |
|---|---|---|---|
| T-D1 | B27 按时间段截取下载 | 三层递进方案已定（见 DEVELOPMENT B27） | 🔄 **②推荐层 + ③自实现链全落地（1.3.62，d-073）**<br>`parse_time_range()` 纯函数（H:M:S / M:S / 纯秒三形态归一，**非法一律 None——宁可整段下，不让 yt-dlp 因半个参数整单报失败**；start≥end 不合法）→ `_run_ytdlp` 加 `--download-sections "*s-e" --force-keyframes-at-cuts`（HLS/DASH 只拉覆盖区间的分片）<br>**UI 已接（d-071）**：video/audio 非直播条目行内「时间段」输入框（placeholder 给格式），native:download 透传 `timeRange`；合法性宿主把关<br>**⚠ 真机故障与修复（d-074）**：UI 首刀只落了一半——渲染块引用了未声明的 `timeRangePick`，渲染任何 video 条目即 ReferenceError → **列表纯空白**（用户 51cg1 截图）。修复：补声明；**renderList 加兜底**（渲染出错在列表区显示一句话，不再白屏）；回放 harness 收编 `test/replay_51cg1.js`（真实条目 + chrome 桩跑 popup 的 load 全链——popup 渲染路径从此有运行时回归手段）<br>测试：`host_timerange_test` 24 → **35 项**（+③层：EXTINF 解析/选片边界 7 + 本地服务器请求计数集成 3 + 收尾）；反向：非法区间零参数钉住、**选片失效 → 请求全部 5 片**红<br>③层实现：`_parse_extinf_durs`（EXTINF 时长，与 segments 对齐才选，不齐整段下）+ `select_segment_window`（覆盖式选片，end 超总长钳到末片，start 超总长 None）→ run_hls_self 只下选中分片 → remux 段按剩余偏移 `-ss/-t` 精切（分片对齐后再精切）<br>边界（原方案已写明，实测确认）：HLS 默认走自实现链——现在 timeRange 在自实现链直接生效，yt-dlp 链吃 `--download-sections`（真机 2.000s 实测）；无扩展名裸直链 generic extractor 的 sections 是 yt-dlp 上游边界（罕见）<br>**真机首验（d-072）**：①产品链 HLS+timeRange → done（自实现链整段下——**③层边界如实确认**）；②yt-dlp 链 sections 能力实测：本地 HLS 切 1-3s → **ffprobe 实测产物 2.000s 精确**；③踩出一个上游边界：无扩展名裸直链 + generic extractor 时 yt-dlp 的 sections 输出 `file:xxx.unknown_video.part`，ffmpeg 推断不出格式报错——真实场景（HLS/DASH/带扩展名）不踩<br>③ 自实现 HLS 链（按 EXTINF 挑分片，1 天）与 ① 手动 ffmpeg 切（本就可用）维持原计划 |
| T-D2 | B28 页面 URL 交给 yt-dlp（把浏览器当登录态代理） | 先 1 小时可行性验证 | ✅ **已落地 1.3.60（d-068 可行性 + d-069 实现；用户拍板「你自己决定，彻底解决」）**<br>链路：popup「整页解析」按钮 + 右键菜单第四项「用本地解析器下载此页」→ background `native:download-page`（页面 URL + `chrome.cookies.getAll({url})` 全量结构化导出）→ 宿主 `write_cookie_netscape()` 写临时文件 → `--cookies`（jar 形态），**同发抑制 legacy Cookie 头**（重复头会让部分 CDN 4xx），try/finally 保证每条退出路径删文件<br>裸验三步全过（Netscape 转换/B 站零适配 1080p/形态判别）；探测边界：抖音 headless 有验证码墙，产品路径用真浏览器 cookie 不受限<br>测试：`host_cookie_jar_test` 24 项（Netscape 七列/hostOnly/会话 cookie/坏行/--cookies 接线/header 抑制/清理/异常穿透）+ context_menu 扩到 26 项 + popup_wiring 76 项；干净副本 Python **26 通过/0 失败**；JS **1145 项**<br>反向验证 3 组全红：不抑制 header 红、finally 去掉红 2、page 项不导出 cookie 红 2<br>**B25（抖音）前置条件就绪**：下一步做抖音时预计半天<br>裸验三步全做（不经扩展、纯命令行 + headless Chrome）：①Netscape 转换器写通（CDP `Storage.getCookies` 导出 16 个 B 站 cookie → 七列 tab 分隔，yt-dlp 照单全收）②B 站视频页 URL 直接喂 yt-dlp → **零站点适配提出 title + 1080p**（「传递层」设想成立）③本地回显服务器判别 cookie 形态：`--add-header Cookie:` 与 `--cookies` **都到达传输层**（新版 yt-dlp 未封 header）；但 `_get_cookies()` 读的 jar 只有 `--cookies` 填充——**B28 原判断成立：产品应切换/叠加 `--cookies`**（现状 `downloader.py:704` 注释自认「没有 Netscape 文件只能走 header」，该限制已不存在）<br>**探测边界**：抖音对 headless Chrome 弹验证码墙，匿名裸验做不了——但产品路径用的是用户真浏览器的 cookie（可能已登录），不受此限；B25 的半天估计维持<br>**落地工作量**：扩展 `chrome.cookies.getAll({url})` → Netscape 写临时文件 → job 传 `cookiesFile` → downloader 传 `--cookies` 用完删；约半天 |
| T-D3 | B29 右键菜单「下载这个视频 / 图片」 | 与「喂链接」合并，约半天 | ✅ 1.3.59（d-067）<br>三类菜单按 contexts 分流：video/audio「下载这个视频/音频」、image「下载这张图片」、link「下载此链接的媒体」；**不做**「解析此页」（B28 未排期，不注册空转菜单项）<br>处理链：srcUrl 可用直接下（复用 startNativeDownload，记录/错误码/续传全在）；blob/空才回页面问（inject-main 在 contextmenu **capture** 阶段记录被点元素，解析 currentSrc→src→picture `<source>`→srcset 最大候选→懒加载属性→背景图）；问不到**不静默**——失败原因写进下载记录<br>命名优先元素上下文（alt→邻近标题→文档标题），不落 video.mp4<br>**测试挖出一个真缺陷**：picture 的 `<source>`（通常是更大的 webp/avif 变体）被排在 img src 之后，注释说「优先」实现却相反——右键拿到的常是降级格式，已修<br>测试：context_menu 19 项 + ctx_pick 16 项；反向验证 4 组全红（懒加载兜底丢失→对应断言崩、srcset 不取最大 1 红、去掉问页面降级 1 红、blob 静默 2 红）；JS 1098 → **1133 项 / 20 文件**；CI 接入 |
| T-D7 | **保存直下**：popup 点「保存/下载」直接开始，不再弹页面内确认浮层（用户 2026-10-24，附截图） | 点保存 → 页面内直接出现进度卡，无确认步骤 | ✅ 1.3.61（d-070）<br>**真机首验通过（d-072）**：headless Chrome 真实链路——ms:save 一条真实 mp4 → 页面无 `__ms_sniffer_overlay` + 文件 73821 字节真实落「文件存放处」 |<br>浮层的历史理由（「让用户手势落在页面按钮上」）已失效：blob 保存自 1.3.x 起全部改走页面 fetch → Native Host（消息驱动，无需手势），浮层只剩确认仪式<br>实现：删 overlayShow/overlayOpen/闭包队列整段（约 170 行），提出模块级 `saveQueue`/`runSaveQueue`（串行语义保留）+ `dispatchSaveItem`（原 runSave 正文去浮层收尾；顺带修正原批量路径对 m\d+ MSE 条目不分派的问题）；MSE 条目仍走 downloadBlob 的 `<a download>`（同源单个程序化点击 Chrome 不拦，真机如有反馈再处理）<br>保存中反馈：页面内进度卡（d-040 的 UI，自带取消按钮）+ popup 任务区/下载记录不变<br>测试：main-hook 194 → 196（两处「弹浮层」断言改为「不弹 + progress 已发出」）、site_registry 103（DL_GENERIC/分派定位/siteSaveHint 断言同步）；反向验证 2 组全红（恢复弹浮层 2 红、blob 退回 `<a download>` 2 红）；JS **1146 项**<br>测试折出的教训：保存已开始的**可观察证据**是产品自己发的 `progress` 事件，不是 host-send（fake fetch 没配 Range 流） |
| T-D4 | B5 点条目跳到页面里该媒体的位置 | 用户**待讨论**，先谈再动 | 🅿️ |
| T-D5 | B4 B 站「上个视频的封面残留」 | 用户明确「放到最后优化」 | 🅿️ |
| T-D6 | B25 抖音（B 类 MSE + DASH 分片） | 用户定「单开 v1.4」 | 🅿️ |

## E. 真机未验（自动化绿了但没上真机的）

> 2026-10-24（d-064）：headless Chrome + CDP `Extensions.loadUnpacked`（Chrome 137+ 移除
> `--load-extension` 后的官方通道）把 E 组里**不依赖登录态与 popup 交互**的部分自动化了，
> 工具收在 `tools/verify_headless.py`（`--sw` 验 T-E1/T-E3，`--pages` 验 T-E4/T-E2）。

| # | 事项 | 状态 |
|---|---|---|
| T-E1 | S0-5 SW 内存活 `typeof MSSession === "object"` | ✅ d-064<br>headless Chrome 加载 1.3.57，SW（background.js）内 `MSSession` 为 object，`msBuildSession`/`msDiffSession`/`msSessionSid` 全 function |
| T-E2 | S0-6 三页字段级等价（需基线 json） | 🔄 两页已过（d-064）<br>B 站首页 + 视频页（从首页 DOM 取的真实 BV，非固定 URL）双跑 `ms:shadow` 均 `ok:true`、missing/changed/extra 全 0；首页 kind 判 `image-set`、视频页判 `video`（DASH 双流 3 video+1 audio+4 seg）<br>**剩**：小红书/Telegram 需登录态，headless 无登录态做不了——待用户日常使用时观察 shadow 是否恒绿 |
| T-E3 | S0-7 真机 items 回放喂 `msBuildSession` | ✅ d-064（自动化等价）<br>SW 内喂真形态 items：sid 非空（`xiaohongshu.com/explore/abc123`，d-058 的「静默空串」在真 SW 环境不存在）、xhs-cover 正确分离进 cover、正文图收进 images、m3u8 进 tracks=1 |
| T-E4 | 1.3.43~1.3.46 累计四刀的真机复验（HLS 时长 / 文件名 / 记录 / 折叠） | 🔄 大头已过（d-064）：真页面抓取、同片折叠、列表、记录链路在 headless 真页面全活（视频页 161 条含 seg 折叠）；popup 交互与日常使用的细节随用户使用复验 |
| **T-E5** | **真机确认 `bin/ffmpeg.exe` 能跑**（合并 / HLS 转 mp4 全靠它） | 🔄 **实质达成，剩一次日常点击复验**（d-064）<br>已验：bin/ffmpeg 与 TEMP 副本**同一文件**全功能可用（-version、libx264/aac 编码、`run_merge` 同款命令合并出音视频双轨、真实 170MB HLS TS→mp4 转封装、ffprobe 探测）<br>**沙箱拦截形态变了**：d-056 时代 bin/ 内 exe「启动即崩 0xC0000409」，今天**能启动**（tool_runs 探测通过）但**写盘被拦**（`Error opening output files: Permission denied`）——产品 remux 因此降级为「TS 完整可播 + 失败原因可见」，降级设计正确工作；TEMP 副本同命令成功，证明拦截按 **exe 所在目录的完整性标签**，与启动方式/cwd/CREATE_NO_WINDOW 无关（全部控制变量排除过）<br>**根目录标签未变**（`Low Mandatory Level:(OI)(CI)(NW)`）：本机在工作区目录内跑会起子进程/写盘的全量回归会假红（实测 5 套；同 HEAD 干净 worktree 全绿 25/25）→ 本机验「真绿」到 CI 或干净副本<br>剩：用户日常 `chrome://extensions` reload → 点一次合并（预期直接成功） |
| T-E6 | 选非默认档下完后用 `ffprobe` 验宽高（T-C1 的产物侧复核） | ✅ d-064<br>真实多档流 x36xhzz（5 档）job 传 `variant:"720"`（popup 只传高度的真实路径）→ 产品整链下载 → **ffprobe 实测产物 `h264,1280,720`**（不是默认的最高档 1080）、时长 634.6s 完整、aac 音轨在；状态文件 `quality:"1280x720"` 与产物一致<br>popup 的选档 UI 交互本身随用户日常使用复验 |

---

## F. 第二阶段：智能化（大脑计划，2026-10-24 定案）

> 完整大纲见 `PRODUCT-PLAN.md` §10。目标形态：未覆盖的失败 → 大脑分析 → 受限尝试
> （产物过验证四层）→ 经验沉淀（候选规则过回放）→ 码表与规则库生长。
> 四条原则：智能骑在确定性内核上 / 经验入库必过回放 / 语料≠bug 报告且纯度>数量 / 不重写。

| # | 事项 | 判据 | 状态 |
|---|---|---|---|
| T-F1 | **语料采集器**（M1）：`tools/corpus_harvest.py`，纯宿主档（B28 传递层直灌），限速 1~2s/去重/纯度闸门（页面确认有媒体才入库）/JSONL 落盘/分布报告 | 第一跑（书签 + sites.txt 种子）产出语料 + **错误码分布报告（INTERNAL 占比 = 大脑第一份教学大纲）** | ✅ d-076（1.3.63）<br>第一跑 25 条种子：done 0 / error 14（全 VERIFY_MISMATCH、全 ytdlp 链）/ 纯度跳过 9 / 抓不到 2，**0 INTERNAL**（错误码表接住已知失败）；三条教学：种子需分层（缺正样本）/ 语料 schema 补 trail / 纯度闸门真实世界正常。测试 corpus_harvest_test 11 项 |
| T-F2 | **语料上量**（M1）：yt-dlp 测试 URL 集（滤 YouTube、按域去重、Unlicense 随便用）+ 详情页展开（列表页抓视频链接，每站封顶） | 千级有效样本；CN/全球两个视角的分布报告 | 🔄 部分就绪（d-077）<br>分层种子已建 `tools/corpus_seeds/`（positive/hard）；**done 形状已采到**（MDN/w3schools 测试流 ×2，Google 系源本机不可达已剔除）；harvest 加 `--job-timeout`（大 HLS 流 120s 不够）；**上量（详情页展开/千级）待做** | ⬜→🔄 依赖 T-F1，0.5~1 天 |
| T-F3 | **评测集**（M1）：从语料人工标注 30~50 条「正确诊断 + 正确策略」 | 评测集文件 + 标注口径文档；选稳定性高的站标（语料会腐烂，评测集定期校准） | 🔄 **考卷与考场提前落地（d-077）**<br>考卷 `docs/corpus/eval-cases.jsonl`：24 案（已确认 9 / **待复核 15**——等用户批改即完成标注），来源=第一跑语料 + 20 站审计 + DEVLOG 实锤（d-032/044/046）；expected.strategy 用**受控词表 10 个**（direct-download/specific-video-url/page-parse/page-save/record-live/login-required/self-hls/anti-bot/not-applicable/unsupported-drm）<br>考场 `tools/corpus_eval.py`：可插拔大脑接口（--brain 模块暴露 diagnose(case)）+ 规则基线（只用 errcode/chain/trail/markers，不背答案）；**基线跑分 8/24（33%）= 玩偶智商**：done/DRM/纯图文全对，VERIFY_MISMATCH 泛化桶（首页 vs 直播 vs 音乐 vs 门户）几乎全错——逐题标了期望诊断，这就是 LLM 要填的空白<br>**✅ 考卷定稿（d-080/d-081）：24/24 已确认**；**✅ 真实 LLM 跑分（d-081，用户配 deepseek）**：第一跑 17%（429 限速全兜底）→ 修 llm_brain 限速退避 + prompt 加判别指引 → **58%（14/24），基线 33% 的近两倍**；错题 ~6 条是考卷自身缺陷（示例 URL 无材料、page-parse/not-applicable 两义标注）——**训练闭环实证：跑考→看错题→改 prompt→提分** |
| T-F4 | **yt-dlp 器官化**（M2）：宿主 `import yt_dlp`（钉版本），CLI 保留兜底；结构化错误（ExtractorError 等）上浮替代文本正则主路径 | ytdlp 链走 API 路径；API/CLI 错误分类对照测试通过；find_tool 兜底仍在 | ✅ d-078（1.3.63）<br>`native-host/ytdlp_api.py`：available() 探测（缓存）+ build_opts（与 CLI 参数语义对齐）+ run_download（progress_hooks 直写状态，取消抛 DownloadCancelled）+ **classify_api_error**（结构化信号优先 exc_info 异常链，文本兜底复用 classify_ytdlp 同一张码表）<br>downloader.run_ytdlp 分派：API 优先 / CLI 兜底（`_run_ytdlp` 原样保留，find_tool 那套不动）；install.bat 钉版 pip 安装 `yt-dlp==2026.8.19`<br>测试 `host_ytdlp_api_test` 19 项：分类对照 7（同一文本 API/CLI 同码）+ 结构化异常链 + API 链真实下载 done + 分派开关；**两条夹具教训**：postprocessor_hooks 的 d[postprocessor] 是**字符串**不是 dict；假 mp4 字节（无 moov）被验证四层正确拒收 |

| T-F5 | **失败 AI 分析**（M3，接大脑）：诊断包 → LLM（用户本机 key）→ 根因假设 + 建议动作 | **评测集考试出准确率报告**；失败 popup 有 AI 分析入口 | ✅ 管道全通（d-079）<br>`native-host/brain.py`（唯一真源）：build_prompt / parse_analysis（JSON 提取+**受控词表校验**，词表外策略显性暴露）/ analyze（OpenAI 兼容端点，urllib 纯标准库，任何失败返回 {ok:False} 不抛）+ **propose_actions**（F6 白名单映射）<br>宿主 handler ai-analyze → background ai:analyze（30s 兜底）→ popup「AI」按钮（对最近一条失败分析，结果进 hint）；history 条目补 jobId/url（AI 定位键）<br>评测对接 `tools/llm_brain.py`（corpus_eval --brain 可直接考 LLM）；测试 host_brain_test **19 项**（fake endpoint 零外网）<br>**待真实 key**：评测集真实准确率报告（MS_AI_ENDPOINT/KEY/MODEL 三环境变量）+ popup 设置 UI（打磨期 storage.local.aiConfig 手动配） |
| T-F6 | **受限尝试循环**（M4）：白名单动作集（换头重扫/换链/yt-dlp 参数/候选地址），LLM 提议→扩展执行→验证四层→结果回喂，N 轮上限 | 评测集「自动救回率」报告；无一步绕过验证 | 🔄 核心就绪（d-079）<br>brain.py：**ACTIONS 白名单 5 动作**（retry-with-headers/switch-chain/page-parse/page-save/give-up，每个的执行器在宿主/扩展里已存在）+ propose_actions（受控映射——LLM 不能发明动作；分析不 ok → 空动作）；测试 4 项<br>**待接**：循环执行器（LLM 实测提议后驱动）+「自动救回率」评测 |
| T-F7 | **自写 extractor 插件**（M5，自进化之门）：LLM 针对新站生成 yt-dlp extractor 插件 → 回放验证 → 本地注册生效 | 对一个 yt-dlp 不支持的站自动产出可用插件并下载成功 | 🔄 **机制验证通过（d-079）**<br>实测：`yt_dlp_plugins/extractor/` + PYTHONPATH → 手写最小 extractor（自定义 URL scheme + 直出 formats）→ yt-dlp 自动加载并提取成功。**注册/加载/生效全链可行**，且插件文件用 `from yt_dlp.extractor.common import`（绝对导入，相对导入不可用）<br>**待做**：LLM 生成环节（依赖 F5 评测调通）+ 回放验证闸 |
| T-F8 | **经验包分发**（M6）：策略包经 GitHub 渠道共享 | opt-in；**发行后才做** | 🅿️ 挂起（依赖发版决定） |

---

## 排序理由（为什么不是按编号顺序做）

1. **B 组排在 C 组前面**：S1~S6 全部建立在「下载能成、产物是对的」之上。
   下载内核出坏文件时，上面所有智能都是假象 —— 而 T-B1 正好是「产生坏文件」的那类缺口，
   且改动面小（`run_urllib` 一个函数）、可离线测、不依赖真机。
2. **T-B2 紧接 T-B1**：同一个函数、同一类判据（长度对不对），一起做比分开做省一半验证成本。
3. **T-C1 排在 B 组之后**：它需要真机取一个多档站，成本高于 B1、B2，且不阻塞别人。
4. **T-B3 已经量完，结论是不做**（1.06×）。这条现在是「用 20 行换来省下 400 行」的样板：
   先量后写，比写对了再回头量便宜一个数量级。
5. **T-B4 因此从第四位升到下一步**：实测里 4 连接那一轮直接吃 429，而单连接正常 ——
   「被限速时怎么退」比「怎么更快」更接近真实失败场景。
6. **T-B5 紧接 T-B4**：码表建好只接了 1/3 条路，另外两条还在说英文。这一步不加新功能，
   只把「同一件事」的说法统一 —— 做完之后 popup 上任何一条失败原因都能对上码表某一行，
   统计（T-C7「同站失败 3 次出建议」）才有分母。
7. **T-C1 排在 T-B6 前面**：`run_merge` 那条路只在 B 站双流站点触发，样本极少；
   而「选清晰度」是 S1 的硬指标，用户天天在用。→ **1.3.51 已完成**（d-057）。
8. **接下来先做 T-C3（S0 Step2 双跑比对）**：它是 S 系列唯一「不新加功能、只把新模型接上并证明等价」
   的一步，做完全后面几步（S2/S4/S5）才有共同的数据底座；而 T-C2 六条全要真机，
   卡在你手上，不该占着「下一步」的位置。
9. **2026-10-24 修订：S4 拆块、S6 提前（与用户对齐）**。核实结论：「顺序不可换」的数据
   依赖论证只覆盖 S0~S3，S4→S6 之间没有数据依赖，属排期惯性；S4 三能力中续传（1.3.47）
   与历史（chrome.storage）早已落地，队列会话内可选，唯一贵的「引擎常驻」挂起 v1.4、
   触发条件量化（≥3 次/周，DEVLOG 留证）；发版闸门是 S6——发版后 S5 知识库才有
   真实用户失败可学（当前暂不上架，发版材料随上架决策再做）。
   详见 T-C6 / T-C8 行与 PRODUCT-PLAN §5 边界注记。
10. **第二阶段（F 组）排期（2026-10-24 定案）**：用户愿景「智能狗狗」定案为在确定性
   内核上装大脑（PRODUCT-PLAN §10），D 组与 F 组的关系：F1（采集器）先行——它不依赖
   任何未做项且产出决定 F3/F5 的质量；F4（yt-dlp 器官化）可与 F1 并行；B25（抖音）
   让位于 F 组——大脑 + yt-dlp 插件路线对抖音的覆盖预期优于手工适配一刀。
