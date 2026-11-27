#!/usr/bin/env python3
"""新增一条 knowledge，同时写进 data.json 和 js/profile.js。

为什么单独写一个脚本：
- 双源同步靠手改，早晚漏一边（profile.js 曾经就少了一条）
- id 忘写、写重、category 拼错，检索层不会报错，只会悄悄变差
- 手写 JSON 容易漏逗号、转义错，页面直接白屏

用法：
    python3 scripts/add_knowledge.py \
        --id rag-project --category project \
        --keywords "RAG,检索增强,向量检索" \
        --answer "我在 W4 做过一个语义检索实验……" \
        --aliases "RAG,检索增强生成"     # aliases 可省略，默认等于 keywords

    --dry   只看结果不写文件
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from migrate_l0 import (  # noqa: E402
    DATA,
    PROFILE,
    build_js_array,
    parse_profile,
)

CATEGORIES = {
    "greeting", "meta", "intro", "profile", "career",
    "skill", "project", "experience", "education", "contact", "persona",
}


def split_list(raw):
    if not raw:
        return []
    return [x.strip() for x in re.split(r"[,，、]", raw) if x.strip()]


def add_entry(
    kid,
    category,
    keywords,
    answer,
    aliases=None,
    data_path=DATA,
    profile_path=PROFILE,
    apply=True,
):
    kid = (kid or "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", kid):
        raise SystemExit(f"id 不合法：{kid!r}（小写字母/数字/连字符，2-31 位）")
    if category not in CATEGORIES:
        raise SystemExit(f"category 不在白名单：{category}，可选：{'、'.join(sorted(CATEGORIES))}")
    if not keywords:
        raise SystemExit("keywords 不能为空（检索全靠它）")
    if not (answer or "").strip():
        raise SystemExit("answer 不能为空")

    data = json.loads(data_path.read_text(encoding="utf-8"))
    existing = data["knowledge"]
    if any(e.get("id") == kid for e in existing):
        raise SystemExit(f"id 已存在：{kid}（要改内容请直接编辑条目，别新增）")

    entry = {
        "id": kid,
        "category": category,
        "keywords": keywords,
        "aliases": aliases or list(keywords),
        "answer": answer.strip(),
    }
    data["knowledge"] = existing + [entry]

    src = profile_path.read_text(encoding="utf-8")
    head, profile_entries, tail = parse_profile(src)
    if any(p.get("id") == kid for p in profile_entries):
        raise SystemExit(f"profile.js 里已有 id：{kid}，两份数据不一致，请先人工核对")
    profile_entries = profile_entries + [dict(entry)]

    print(f"新增 #{kid} [{category}] keywords={len(keywords)} aliases={len(entry['aliases'])}")
    print(f"  answer: {entry['answer'][:60]}…")
    print(f"data.json 条数 {len(existing)} -> {len(data['knowledge'])}")

    if not apply:
        print("\n[dry-run] 没写文件。去掉 --dry 才落盘。")
        return entry

    data_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    profile_path.write_text(head + build_js_array(profile_entries) + tail, encoding="utf-8")
    print("\n已写入 data.json 与 js/profile.js")
    return entry


def main():
    ap = argparse.ArgumentParser(description="新增一条 knowledge 到两个数据源")
    ap.add_argument("--id", required=True)
    ap.add_argument("--category", required=True)
    ap.add_argument("--keywords", required=True)
    ap.add_argument("--answer", required=True)
    ap.add_argument("--aliases", default="")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    add_entry(
        a.id,
        a.category,
        split_list(a.keywords),
        a.answer,
        split_list(a.aliases) or None,
        apply=not a.dry,
    )


if __name__ == "__main__":
    main()
