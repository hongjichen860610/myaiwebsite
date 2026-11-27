#!/usr/bin/env python3
"""L0 数据结构化：给每条知识补 id / category / aliases。

为什么要有这一步：
- id      → chips 快捷问题可精确指向某条，不靠文本猜测；调试日志能说出"命中了哪条"
- category→ 后续按意图加权（求职类问题优先给 career 的条目）
- aliases → 给同义词留的坑位，本轮先复制 keywords，等 W7 再逐步扩

双源同步：data.json 是线上权威，js/profile.js 是首屏兜底。
两份必须同时改，否则会出现"有时看得到、有时看不到"。

安全规则（2026-11-26 加）：
- 已有 id / category 就沿用，不靠 META 重新猜 → 新增条目不会被打回 unknown
- 已有 aliases 就保留，只在缺失时用 keywords 兜底 → 手写的同义词不会被冲掉
- 其它自定义字段原样保留 → 以后加权重、更新时间不会被抹掉
所以本脚本可以反复跑，结果一致。

用法：
    python3 scripts/migrate_l0.py --dry     # 只看分类，不写文件
    python3 scripts/migrate_l0.py --apply   # 写入两个文件
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data.json"
PROFILE = ROOT / "js" / "profile.js"

# (id, category, anchor) —— anchor 是该条 knowledge 里独一无二的关键词，仅用于"还没有 id"的老条目
META = [
    ("greeting", "greeting", "你好"),
    ("about-ai", "meta", "你是ai"),
    ("trust-source", "meta", "会不会编"),
    ("intro", "intro", "你是谁"),
    ("basic-info", "profile", "年龄"),
    ("employment-status", "profile", "在职"),
    ("job-intent", "career", "求职意向"),
    ("years-exp", "career", "几年经验"),
    ("tech-stack", "skill", "技术栈"),
    ("projects", "project", "做过什么"),
    ("union-project", "project", "互联网+工会"),
    ("party-building", "project", "智慧党建"),
    ("venue-system", "project", "智慧场馆"),
    ("police-analysis", "project", "顺德"),
    ("h5-brand", "project", "h5"),
    ("ecommerce-frontend", "project", "宏浩"),
    ("engineering-mgmt", "experience", "石油化工"),
    ("team-management", "experience", "团队"),
    ("telecom-industry", "experience", "电信"),
    ("current-company", "experience", "哪家公司"),
    ("work-history", "experience", "工作经历"),
    ("education", "education", "学历"),
    ("why-fit", "career", "为什么适合"),
    ("salary", "career", "期望薪资"),
    ("city", "career", "城市"),
    ("contact", "contact", "联系方式"),
    ("onboard-time", "career", "到岗"),
    ("leave-reason", "career", "离职原因"),
    ("resume-file", "career", "简历"),
    ("interview", "career", "面试"),
    ("capabilities", "meta", "能问什么"),
    ("thanks", "greeting", "谢谢"),
    ("running", "persona", "马拉松"),
]


def norm(text):
    return re.sub(r'[\s,，。？！?!、；;：:（）()\[\]【】"\'“”‘’·.\-—…~～]', "", str(text).lower())


def anchor_of(keywords):
    """按 META 顺序找到第一个能当锚的关键词，返回索引。"""
    kws = {norm(k) for k in keywords}
    for i, (_, _, anchor) in enumerate(META):
        if norm(anchor) in kws:
            return i
    return None


def resolve_meta(entry):
    """优先沿用已有 id/category，缺失时才靠锚点推断。返回 (id, category)。"""
    kid, cat = entry.get("id"), entry.get("category")
    if kid and cat:
        return kid, cat
    idx = anchor_of(entry["keywords"])
    if idx is None:
        raise SystemExit(
            "有条目既没有 id，也用锚点匹配不出来：" + str(entry["keywords"][:4])
        )
    mid, mcat, _ = META[idx]
    return kid or mid, cat or mcat


def classify(knowledge):
    """返回 [(entry, id, category)]，并检查 id 唯一。"""
    out = [(entry, *resolve_meta(entry)) for entry in knowledge]
    ids = [x[1] for x in out]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise SystemExit("id 重复：" + str(dup))
    return out


def migrate_data(rows):
    """在原条目上补字段，不重建对象，避免丢字段、丢 aliases。"""
    out = []
    for entry, kid, cat in rows:
        item = dict(entry)
        item["id"] = kid
        item["category"] = cat
        item["keywords"] = list(entry["keywords"])
        if not item.get("aliases"):
            item["aliases"] = list(entry["keywords"])
        item["answer"] = entry["answer"]
        out.append(item)
    return out


def js_string(text):
    return json.dumps(text, ensure_ascii=False)


def js_array(items):
    return "[" + ", ".join(js_string(x) for x in items) + "]"


def build_js_array(entries):
    """entries: 形如 {id?, category?, keywords, aliases?, answer} 的 dict 列表。"""
    blocks = []
    for e in entries:
        lines = []
        if e.get("id"):
            lines.append(f"      id: {js_string(e['id'])}, ")
        if e.get("category"):
            lines.append(f"      category: {js_string(e['category'])}, ")
        lines.append(f"      keywords: {js_array(e['keywords'])}, ")
        if e.get("aliases"):
            lines.append(f"      aliases: {js_array(e['aliases'])}, ")
        lines.append(f"      answer: {js_string(e['answer'])}")
        body = "\n".join(line.rstrip() for line in lines)
        blocks.append("    {\n" + body + "\n    }")
    return "knowledge: [\n" + ",\n".join(blocks) + "\n  ]"


def parse_profile(src):
    """抠出 knowledge 数组里的每个对象；用括号配对，避免砍到 answer 里的方括号。"""
    start = src.index("knowledge: [")
    i = src.index("[", start)
    depth = 0
    end = -1
    for pos in range(i, len(src)):
        ch = src[pos]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = pos
                break
    if end < 0:
        raise SystemExit("profile.js 里 knowledge 数组没闭合")

    body = src[i + 1:end]
    objs = []
    depth = 0
    buf = []
    for ch in body:
        if ch == "{" and depth == 0:
            depth = 1
            buf = ["{"]
            continue
        if depth:
            buf.append(ch)
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    objs.append("".join(buf))

    def grab(pattern, obj):
        m = re.search(pattern, obj)
        return json.loads('"' + m.group(1) + '"') if m else None

    entries = []
    for obj in objs:
        kw_raw = re.search(r"keywords:\s*\[([^\]]*)\]", obj)
        if not kw_raw:
            continue
        aliases_raw = re.search(r"aliases:\s*\[([^\]]*)\]", obj)
        entries.append(
            {
                "id": grab(r'\bid:\s*"((?:[^"\\]|\\.)*)"', obj),
                "category": grab(r'\bcategory:\s*"((?:[^"\\]|\\.)*)"', obj),
                "keywords": re.findall(r'"((?:[^"\\]|\\.)*)"', kw_raw.group(1)),
                "aliases": (
                    re.findall(r'"((?:[^"\\]|\\.)*)"', aliases_raw.group(1))
                    if aliases_raw
                    else None
                ),
                "answer": grab(r'answer:\s*"((?:[^"\\]|\\.)*)"', obj),
            }
        )
    # prefix 保留 "knowledge:" 之前的全部内容，suffix 保留数组之后的代码
    return src[:start], entries, src[end + 1:]


def main():
    apply = "--apply" in sys.argv
    knowledge = json.loads(DATA.read_text(encoding="utf-8"))["knowledge"]
    rows = classify(knowledge)

    src = PROFILE.read_text(encoding="utf-8")
    head, profile_entries, tail = parse_profile(src)

    print(f"data.json {len(rows)} 条 | profile.js {len(profile_entries)} 条\n")
    print(f"{'#':>3} {'id':<20}{'category':<12}{'keys':>5}  首关键词")
    for i, (entry, kid, cat) in enumerate(rows, 1):
        print(f"{i:>3} {kid:<20}{cat:<12}{len(entry['keywords']):>5}  {entry['keywords'][0]}")

    ids = {kid for _, kid, _ in rows}
    missing = [e["keywords"][0] for e, kid, _ in rows if kid not in {
        (p.get("id") or "") for p in profile_entries
    }]
    print(f"\nprofile.js 覆盖 {len(profile_entries)} 条，data.json 独有：{len(missing)} 条")
    if missing:
        print("  " + "、".join(missing))
    stray = [p["id"] for p in profile_entries if p.get("id") and p["id"] not in ids]
    if stray:
        print("profile.js 里有 data.json 没有的 id：" + "、".join(stray))

    if not apply:
        print("\n[dry-run] 没写文件。加 --apply 才落盘。")
        return

    new_data = migrate_data(rows)
    DATA.write_text(
        json.dumps({"knowledge": new_data}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    filled = []
    for p in profile_entries:
        kid, cat = resolve_meta(p)
        item = dict(p)
        item["id"], item["category"] = kid, cat
        if not item.get("aliases"):
            item["aliases"] = list(item["keywords"])
        filled.append(item)
    PROFILE.write_text(head + build_js_array(filled) + tail, encoding="utf-8")
    print("\n已写入 data.json 与 js/profile.js")


if __name__ == "__main__":
    main()
