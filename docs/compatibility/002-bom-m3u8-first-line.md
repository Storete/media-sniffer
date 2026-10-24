---
id: 002-bom-m3u8-first-line
状态: 已启用
测试引用: test/sanitize_test.py
适用版本: 1.3.42
---

## 现象

下载 HLS 时开头多了一个坏分片：第一条「分片」实际是 404 或一段垃圾字节，
被拼进成品的文件头，正片开头播不了。

## 复现

喂一个带 UTF-8 BOM 的 m3u8 清单（某些 CDN/打包器会加），
观察 `parse_hls_playlist` 返回的第一个分片地址。

## 根因

BOM（U+FEFF）粘在首行行首，`"\ufeff#EXTM3U"` 不以 `#` 开头，于是走「分片地址」
分支，把 `#EXTM3U` 这行标签当成一个 TS 地址去下载。教训：只检查「每行格式是否
合法」是漏得掉的，必须检查「里面有没有根本不该出现的字符」。

## 修复

三层：

1. 清单解码改 `utf-8-sig`（吃掉 BOM）；
2. `parse_hls_playlist` 入口再 `lstrip("\ufeff")` 兜一层；
3. 每行行首再 `lstrip("\ufeff\u200b\u200e\u200f")` —— 零宽字符不是
   `isspace()`，`strip()` 去不掉。

变异测试的「地址里不该有 BOM/零宽/控制字符」不变量（H8）一轮报了 258 次
才暴露；对应不变量已进 `test/sanitize_test.py` [7] 段与 `tools/fuzz_host.py`
CI 门禁，防止退回去。
