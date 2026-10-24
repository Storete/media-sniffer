#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T-F5 评测对接：corpus_eval --brain 的 LLM 大脑实现。

与宿主 popup 的 AI 分析走同一条通路（native-host/brain.py）——prompt、
解析、词表全部同一份真源。

配置（环境变量）：
    MS_AI_ENDPOINT  OpenAI 兼容端点（如 https://api.xxx.com/v1）
    MS_AI_KEY       API key
    MS_AI_MODEL     模型名（缺省 gpt-4o-mini）

用法：
    MS_AI_ENDPOINT=... MS_AI_KEY=... python tools/corpus_eval.py \\
        --brain tools/llm_brain.py --verbose
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "native-host"))

import brain  # noqa: E402


def diagnose(case):
    endpoint = os.environ.get("MS_AI_ENDPOINT") or ""
    key = os.environ.get("MS_AI_KEY") or ""
    model = os.environ.get("MS_AI_MODEL") or ""
    r = brain.analyze(case, endpoint, key, model)
    if not r.get("ok"):
        # 评测场景下分析失败要**显性暴露**（方案不对≠考卷错）
        return {"diagnosis": "(分析失败) " + r.get("error", ""),
                "strategy": "page-parse"}   # 兜底策略：最不危险的那个
    return {"diagnosis": r.get("diagnosis", ""), "strategy": r.get("strategy", "")}
