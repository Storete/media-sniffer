---
id: 003-tg-group-by-title
状态: 已启用
测试引用: test/group_key.test.js
适用版本: 1.3.16
---

## 现象

Telegram 里同一组媒体（同一标题的相册）在列表里各自成组，序号一片
「①①①」；图片点「预览」没反应（预览按钮灰着）。

## 复现

打开 Telegram Web 频道，找一条带多图的消息和相邻的同标题消息，开 popup 看分组与序号。

## 根因

分组键原来是 `kind + mid + ref`：Telegram 的相册会给 `album`/`viewer` 两种 ref，
同标题的媒体散在不同消息里就各拿各的 key，永远并不到一组。Telegram 只是拆得
最碎、最先暴露——这个键是全站点共用的，不是站点专属逻辑。
预览按钮的门槛是 `/^https?:/`，而 Telegram 页面里 `<img>`/`<video>` 的 src 就是
`blob:https://…`，全被挡在门外。

## 修复

- 分组键改成「有标题就用 `t:标题`，跨消息、跨 ref、跨 kind 并成一组；
  无标题才退回 `kind + mid + ref`」；
- 列表排序判据同步：都有标题且相同 → 按 idx 排，不再只认 mid 相同；
- 抽出 `canPreviewSrc(it)`：只排除 MSE 合成条目与非媒体类型，
  `http/https/blob/data` 一律放行，画不出来时预览框自己显示「预览加载失败」。
