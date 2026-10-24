---
id: 006-cover-miscollected
状态: 已启用
测试引用: test/background.test.js
适用版本: 1.3.24
---

## 现象

图片栏里混进视频封面、站点横幅、装饰图，用户把它们当正文图下载——
**错抓比漏抓严重**：漏抓只是少一个选项，错抓是「下错了且不自知」。
这是判定规则里代价不对称的典型。

## 复现

- B 站视频页：图片栏 33 条全是 webRequest 撞进来的横幅/封面；
- Telegram 视频消息：26 条「图片」里 16 条是视频封面（URL、尺寸与真照片一致）；
- 其它站点视频帖：视频封面默认被当图片收。

## 根因

封面类素材**无法靠 URL 或尺寸判**：B 站横幅来自 webRequest 直接命中；
Telegram 封面的 URL/尺寸与真照片完全一致；只能靠三层结构信息分别认：

1. 是不是「视频封面」这个类别（`hint` 要能区分——原来小红书封面和正文图
   共用一个 hint，想滤都没法滤）；
2. 当前页面是不是视频页（原来看 `__playinfo__`，首屏异步为空、番剧页永远为空）；
3. DOM 结构（`.media-inner` 里 video+thumbnail 同容器、`.media-preview` 配播放图标）。

## 修复

三层各落一道闸，**误杀回归全钉在测试里**：

- `VIDEO_COVER_SITES` 白名单表 + `coverAllowed(host)`：只有白名单站的封面
  才当图片收（收 `bilibili.com` / `xiaohongshu.com`），数组清空 = 全网不收；
  子域自动跟随，`bilibili.com.evil.net` 不误命中；
- `biliIsVideoPage()` 改看 URL；视频页拿不到封面时一张都不报，
  `preferBiliCover` 只留 `hint==="bili-cover"`（首页 49 张真图不误筛）；
- `isDecorImg` 钩子管新扫描 + `pruneStaleImages` 按当前规则重算清理
  （封面是 `blob:` URL、每轮换地址，旧地址条目必须按新规则重判）。
