---
id: 005-focus-report-lost
状态: 已启用
测试引用: test/focus_scope.test.js
适用版本: 1.3.18
---

## 现象

Telegram 的「只看当前打开的这一条」从来没生效过——popup 永远显示整个频道的
全部条目；而且这个功能时灵时不灵：查看器刚打开的那一下如果插件还没就绪，
之后**永远**不灵。

## 复现

Telegram Web 打开一条消息的媒体查看器，看 popup 是否只显示该消息的条目；
刷新页面后先点开查看器再开 popup（抢在 Service Worker 就绪前），对比行为。

## 根因

两条独立的通路缺陷：

1. 反查链全空：查看器容器 `.MediaViewerSlide--active` 往上 22 层
   （slides → dialog → transition → body）**没有一层带 `data-message-id`**，
   `.message.highlighted/.selected` 也永远是空 —— Telegram 跳转用滚动定位、
   不加高亮类。按「DOM 上溯取消息号」的实现必然返回空，等于没实现；
2. 上报只在变化时发：`reportFocus()` 比较 `lastFocus` 才发消息。查看器刚打开
   那次若 SW 没就绪，这条上报丢了，但 `lastFocus` 已经置位 —— 之后每次都判定
   「没变化」，一次丢包等于永久失效。

## 修复

- 方案 B 反查：取 `--active` 那一页的 `currentSrc/src`，在
  `[data-message-id] img, [data-message-id] video` 里找同地址元素，再从那里
  上溯取消息号——地址是唯一稳定存在的关联；
- `FOCUS_RESEND_MS = 5000` 周期性补发当前焦点，丢一次包最多脏 5 秒。

通用教训：**「只在变化时上报」的状态量，第一次上报的丢失必须是可恢复的**，
否则一个偶发就退化成永久错误，而且表现是「功能时灵时不灵」，最难排查。
