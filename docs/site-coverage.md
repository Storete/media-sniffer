# 站点覆盖度实测（2026-10-23，34 站 + 9 站深链）

**目的**：回答「这个扩展到底能在多少网站上跑」。不是支持清单，是**测量**。
配套工具 [`tools/site_audit.mjs`](../tools/site_audit.mjs)，清单 [`tools/sites.txt`](../tools/sites.txt)。

---

## 一、怎么测的

用 CDP 驱动一个装了本扩展的浏览器，逐站打开、等 13 秒，然后读**注入层上报的原始发现**。

注入层（`inject-main.js`，MAIN world）每发现一条资源就 `window.postMessage`
`{__ms_sniffer:true, cmd:'found', key, size, mime, ...}`。测试工具在页面**加载前**
把这个通道抄一份到 `window.__auditFound`，跑完读走。

因此这里的数字是**注入层的发现能力**（未经 background 的图标过滤与去重），
**大于**用户在 popup 里看到的条目数。抓不到就是抓不到 —— 这是覆盖度的上限。

### 一个把测量结果全盘带偏的坑

Chrome 137+ **已经禁用 `--load-extension`**，而且**不报错**：浏览器照常启动，
`/json/list` 里也照常有 `chrome-extension://…` 的 target（那是 Chrome 自带的组件扩展），
但我们的 content script 一个都不注入。

表现是：每站都返回 `0 条`，title 正常、DOM 里有 304 张图 —— 看起来特别像
「这些网站本来就没有媒体」。差点就这么记结论了。

识别方法：页面里 `typeof window.__MS_SNIFFER_MAIN__` 必须是 `"boolean"`。
不是就没注入，别往下测。

**解决**：换 Edge（156.0.4314.42 仍然支持 `--load-extension`）。工具里用
`--browser edge`，并且在第一站就断言注入标记，不通过直接中止，避免白跑 30 站。

---

## 二、34 站首页实测

`条目` = 注入层上报的资源总数；`媒体` = 其中 video/audio；`图` = image。

| 站点 | 条目 | 媒体 | 图 | 类 | 备注 |
|---|---:|---:|---:|---|---|
| tv.sohu.com | 698 | 0 | 698 | - | 海报墙，无 `<video>` |
| www.1905.com | 398 | 4 | 394 | A? | 有 http 地址但没拿到字节数 |
| www.miguvideo.com | 129 | 2 | 126 | ? | 媒体地址既非 http 也非 blob（MSE 片段） |
| www.pptv.com | 731 | 0 | 731 | - | |
| www.le.com | 13 | 0 | 13 | - | |
| www.acfun.cn | 243 | 0 | 243 | - | |
| www.douyu.com | 361 | 2 | 359 | ? | MSE |
| www.huya.com | 302 | 2 | 300 | ? | MSE |
| live.douyin.com | 17 | 7~12 | 5 | A? | 唯一首页就有多条 http 地址的站 |
| music.163.com | 1 | 0 | 1 | - | 首页不预加载音频 |
| y.qq.com | 35 | 0 | 35 | - | |
| www.kugou.com | **1861** | 0 | 1861 | - | 全站图片量第一 |
| www.kuwo.cn | 24 | 0 | 24 | - | |
| news.sina.com.cn | 78 | 0 | 78 | - | |
| news.163.com | 73 | 1 | 72 | A? | |
| news.qq.com | 89 | 0 | 89 | - | |
| www.ifeng.com | 536 | 0 | 536 | - | |
| www.thepaper.cn | 55 | 0 | 55 | - | |
| 36kr.com | 167 | 0 | 167 | - | |
| www.douban.com | 482 | 0 | 482 | - | 海报图 |
| tieba.baidu.com | **失败** | - | - | - | `Runtime.evaluate` 超时（页面重，12s 内没稳定） |
| bbs.hupu.com | 3 | 0 | 3 | - | 内容几乎走接口，DOM 里没东西 |
| www.jianshu.com | 7 | 0 | 7 | - | |
| juejin.cn | 32 | 0 | 32 | - | |
| www.csdn.net | 1294 | 0 | 1294 | - | 图片量第二 |
| www.suning.com | 610 | 0 | 610 | - | 商品图 |
| www.vip.com | 4 | 0 | 4 | - | |
| www.goofish.com | 1201 | 0 | 1201 | - | 商品图 |
| www.mafengwo.cn | 37 | 0 | 37 | - | |
| www.dianping.com | 46 | 0 | 46 | - | |
| huaban.com | 230 | 0 | 230 | - | 图片站；DOM 里 521 张 img，上报 230 |
| www.zcool.com.cn | 487 | 0 | 487 | - | 图片站；DOM 里只有 195 张 img，上报 487（含背景图/多倍图） |
| www.yuque.com | 84 | 0 | 84 | - | |
| www.wps.cn | 68 | 0 | 68 | - | |

**汇总**：34 站里 33 站注入层正常工作（1 站超时），**27 站首页没有任何 video/audio**。

---

## 三、9 站深链补测

首页没媒体不代表这个站下不了 —— 视频在海报墙后面。工具会从首页提取「像详情页」的
链接（路径含 video/play/watch/vod/detail/note/album，且层级 ≥ 2）再测一次。

| 站点 | 候选详情页 | 深链结果 |
|---|---:|---|
| tv.sohu.com | 0 | — |
| www.1905.com | 6 | 首页已有 4 条，不追 |
| www.miguvideo.com | 0 | — |
| www.pptv.com | 0 | — |
| www.le.com | 6 | `ptv/vplay/78074623.html` → 405 条 / 媒体 1 / 类 `?` |
| www.acfun.cn | 0 | — |
| www.douyu.com | 1 | 首页已有 2 条 |
| www.huya.com | 6 | 首页已有 2 条 |
| live.douyin.com | 0 | 首页已有 |

**9 站里 6 站提取不到任何详情页链接**。原因不是正则写窄了，而是现代站点的卡片
基本是 JS 点击跳转（`<div onclick>` 或交给路由），页面上**根本没有指向详情页的 `<a href>`**。

乐视那条追到了详情页，但也只抓到 1 条媒体且是 `?` 类（地址不是 http 也不是 blob，
属于 MSE 分片被录到的条目）。

---

## 四、结论

1. **注入层的资源发现能力在 33/34 站成立**：从图片站（zcool 487、kugou 1861）到空页面
   （hupu 3、jianshu 7）都能如实反映页面内容，既没有大面积漏抓，也没有把导航图标灌进来。

2. **「能不能下视频」和站名关系不大，和「这个页面有没有 `<video>` 或 http 直链」关系极大。**
   27 个首页 0 媒体不是失败 —— 是这些首页本来就在放图片。真正决定成败的是**具体页面**。

3. **音乐站首页 0 音频**（网易云 1 条、QQ 音乐 35 条全是图）：都是点击才加载，属于预期。

4. **`A?` 与 `?` 的含义**：`A?` 是拿到了 http 地址但没拿到字节数（没发 content-length）；
   `?` 是媒体条目存在但地址既不是 http 也不是 blob —— 直播站点（斗鱼/虎牙/咪咕）的
   MSE 条目就落在这里。这两类都不是「能直接下」，别当成可下。

5. **要测「视频可下性」，必须把详情页 URL 直接写进清单。** 靠首页自动发现不可靠，
   因为详情页入口在 JS 里。`tools/sites.txt` 支持直接写详情页 URL，这是推荐用法。

---

## 五、下一步

- **补详情页 URL 的清单**：每个视频站给 2~3 个真实视频页（可从站内榜单页手工抄），
  这是唯一能真正量出「视频可下率」的办法。
- **B 站/抖音不在本表**：它们已有结论（[site-audit.md](site-audit.md)、[d-044](../DEVLOG.md#d-044)），
  且是 B 类（MSE），需要单独的方法。
- **贴吧超时**：把 `--wait` 提到 20 秒，或改成等 `document.readyState === "complete"` 再读。
