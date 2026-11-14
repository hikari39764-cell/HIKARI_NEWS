"""HIKARI NEWS 的工具脚本。分成「研究端」和「发布端」两部分。

研究端（Claude 定时任务，没有任何密钥，可以自由上网）:
  新闻（RESEARCH.md，每天 3 次）
    python3 radar.py context               这一批的任务、技术关键词的领域、已推送过的内容
    python3 radar.py feeds                 优质网站 RSS 的最新文章（研究的第一手候选）
    python3 radar.py community             社区热门候选（研究线索）
    python3 radar.py check  out/results.json
    python3 radar.py submit out/results.json [--preview]
  学习内容（LEARN.md，每天 1 次）
    python3 radar.py learn-context         题库现状、最近的关键词、被回报的题目
    python3 radar.py learn-check  out/learn.json
    python3 radar.py learn-submit out/learn.json [--preview]

发布端（GitHub Actions，持有密钥，不读任何网页）:
    python3 radar.py publish-pending [--dry-run]
        读取 claude/inbox-* 和 claude/learn-* 分支（只当作数据读取，不执行其中的代码）
        → 检查 → Discord 论坛帖子（只有新闻批次）→ Firebase → 更新 state/published.json → 删除分支

管理员本地：
    python radar.py preview <分支或 JSON>        新闻批次的预览 HTML
    python radar.py preview-learn <分支或 JSON>  学习内容的预览 HTML

发布端需要的环境变量（GitHub Secrets）:
    DISCORD_FORUM_WEBHOOK / DISCORD_LOG_WEBHOOK（可选）/ FIREBASE_SERVICE_ACCOUNT_B64
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
STATE_PATH = ROOT / "state" / "published.json"
JST = timezone(timedelta(hours=CONFIG["timezone_offset_hours"]))
LEVELS = ("入門", "中級", "上級")
KW_LEVELS = ("基礎", "発展", "応用")
JA_CHARS = re.compile(r"[぀-ヿ一-鿿]")
WEEKDAYS_JA = "月火水木金土日"
INBOX_PREFIX = "claude/inbox-"
LEARN_PREFIX = "claude/learn-"
PREVIEW_PREFIX = "claude/preview-"
TASKS = {t["id"]: t for t in CONFIG["tasks"]}
SECTIONS = {t["id"] for t in CONFIG["tasks"] if t.get("section")}
KW_TRACKS = CONFIG.get("keyword_tracks", {})
KW_AREAS = {v["area"]: v for v in KW_TRACKS.values()}
LEARN = CONFIG.get("learn", {})
QUIZ_TOPICS = {track: [t["id"] for t in topics] for track, topics in LEARN.get("quiz_topics", {}).items()}
TOPIC_NAMES = {t["id"]: t["name"] for topics in LEARN.get("quiz_topics", {}).values() for t in topics}
IDEA_POOLS = LEARN.get("idea_pools", [])

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


# ======================================================================
# 共用
# ======================================================================

def now_jst() -> datetime:
    return datetime.now(JST)


def slot_for(now: datetime) -> str:
    """按日本时间判断现在属于哪一批：13 点前 → 10，19 点前 → 17，之后 → 22。"""
    if now.hour < 13:
        return "10"
    if now.hour < 19:
        return "17"
    return "22"


def tasks_for(day: date, slot: str) -> list[dict]:
    return [t for t in CONFIG["tasks"] if day.weekday() in t["when"].get(slot, [])]


def normalize_url(url: str) -> str:
    p = urlsplit(url.strip())
    query = "&".join(q for q in p.query.split("&") if q and not q.startswith("utm_"))
    return urlunsplit((p.scheme, p.netloc.lower(), p.path.rstrip("/"), query, ""))


def item_id(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode()).hexdigest()[:16]


def norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(s)).lower()).strip()


def quiz_id(q: str, answer: str) -> str:
    return hashlib.sha1(f"{norm_text(q)}|{norm_text(answer)}".encode()).hexdigest()[:12]


def match_keywords(item: dict) -> list[str]:
    text = " ".join([item["title"], item["summary"], item["note"], *item["tags"]]).lower()
    return [k for k in CONFIG.get("keywords", []) if k.lower() in text]


STATE_DEFAULT = {"items": [], "batches": [], "last_weekly": None, "warned": [],
                 "keywords": [], "quiz": [], "themes": [], "reports": [], "idea_counts": {}}


def load_state() -> dict:
    state = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.exists() else {}
    for k, v in STATE_DEFAULT.items():
        state.setdefault(k, json.loads(json.dumps(v)))
    return state


def save_state(state: dict) -> None:
    state["items"] = state["items"][-800:]
    state["batches"] = state["batches"][-150:]
    state["warned"] = state["warned"][-80:]
    state["keywords"] = state["keywords"][-2000:]
    state["quiz"] = state["quiz"][-6000:]
    state["themes"] = state["themes"][-400:]
    STATE_PATH.parent.mkdir(exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def git(*args: str, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{r.stderr.strip()}")
    return r.stdout


def is_url(u) -> bool:
    return isinstance(u, str) and bool(re.match(r"^https?://[^\s<>\"']+$", u.strip()))


# ======================================================================
# 结果检查（研究端和发布端共用）
# ======================================================================

class ResultError(Exception):
    pass


def clean_writeup(it: dict, where: str, errors: list, strict: bool) -> dict:
    """网站用的详细整理：要点（points）、分段的详细解说（detail）、术语解析（terms）。
    strict=True（研究端交稿时）必须写；strict=False（发布端）只做整理，不因为缺少而拒绝。"""
    errs = errors if strict else []
    pts = it.get("points")
    if pts is None:
        pts = []
    if not isinstance(pts, list) or not all(isinstance(p, str) and p.strip() for p in pts):
        errs.append(f"{where}：points 必须是字符串数组（3〜5 条要点）")
        pts = [p for p in pts if isinstance(p, str) and p.strip()] if isinstance(pts, list) else []
    pts = [p.strip() for p in pts]
    if not 3 <= len(pts) <= 5:
        errs.append(f"{where}：points（要点）要写 3〜5 条，现在是 {len(pts)} 条")
    if any(len(p) > 90 for p in pts):
        errs.append(f"{where}：每条要点最多 90 字，写成一句话")

    detail = str(it.get("detail") or "").replace("\r\n", "\n").strip()
    paras = [re.sub(r"[ \t]+\n", "\n", p).strip() for p in re.split(r"\n[ \t]*\n", detail) if p.strip()]
    if not detail:
        errs.append(f"{where}：detail（详细解说）不能为空")
    else:
        if not 200 <= len(detail) <= 1400:
            errs.append(f"{where}：detail 要 200〜1400 字，现在是 {len(detail)} 字")
        if not 2 <= len(paras) <= 6:
            errs.append(f"{where}：detail 要分成 2〜6 段，段与段之间空一行（JSON 里写 \\n\\n）")
        if any(len(p) > 340 for p in paras):
            errs.append(f"{where}：detail 每段最多 340 字，太长的段落请拆开")
        if not JA_CHARS.search(detail):
            errs.append(f"{where}：detail 必须用日文写")

    terms = it.get("terms") or []
    if not isinstance(terms, list):
        errs.append(f"{where}：terms 必须是数组")
        terms = []
    if len(terms) > 3:
        errs.append(f"{where}：terms 最多 3 个")
    clean_terms = []
    for k, t in enumerate(terms[:3], 1):
        term = str(t.get("term") or "").strip() if isinstance(t, dict) else ""
        explain = str(t.get("explain") or "").strip() if isinstance(t, dict) else ""
        if not term or not explain:
            errs.append(f"{where}：terms 第 {k} 个需要 term 和 explain")
            continue
        if len(term) > 40 or len(explain) > 160:
            errs.append(f"{where}：terms 第 {k} 个：term 最多 40 字、explain 最多 160 字")
        clean_terms.append({"term": term[:40], "explain": explain[:160]})
    return {"points": [p[:120] for p in pts[:5]], "detail": "\n\n".join(paras)[:2000] or None, "terms": clean_terms}


def clean_item(it, where: str, errors: list, force_category: str | None = None, strict: bool = True) -> dict | None:
    if not isinstance(it, dict):
        errors.append(f"{where}：不是对象")
        return None
    cat = force_category or it.get("category")
    url = str(it.get("url") or "").strip()
    title = str(it.get("title") or "").strip()
    summary = str(it.get("summary") or "").strip()
    if cat not in TASKS:
        errors.append(f"{where}：category 必须是 {list(TASKS)} 之一")
    if not is_url(url):
        errors.append(f"{where}：url 必须是 http(s) 链接，且不能有空格")
    if not title or not summary:
        errors.append(f"{where}：title 和 summary 不能为空")
    if title and not JA_CHARS.search(title + summary):
        errors.append(f"{where}：title / summary 必须用日文写（英文内容请翻译）")
    deadline = it.get("deadline")
    if deadline:
        try:
            date.fromisoformat(str(deadline))
        except ValueError:
            errors.append(f"{where}：deadline 必须是 YYYY-MM-DD 或 null")
    try:
        importance = int(it.get("importance", 3))
        if not 1 <= importance <= 5:
            raise ValueError
    except (TypeError, ValueError):
        errors.append(f"{where}：importance 必须是 1〜5 的整数")
        importance = 3
    tags = it.get("tags") or []
    if not isinstance(tags, list):
        errors.append(f"{where}：tags 必须是数组")
        tags = []
    minutes = it.get("read_minutes")
    return {
        "category": cat,
        "title": title[:150],
        "summary": summary[:500],
        "url": url,
        "source": str(it.get("source") or urlsplit(url).netloc)[:60],
        "tags": [str(t)[:30] for t in tags][:5],
        "note": str(it.get("note") or "").strip()[:200],
        "importance": importance,
        "level": it.get("level") if it.get("level") in LEVELS else None,
        "deadline": str(deadline) if deadline else None,
        "lang": it.get("lang") if it.get("lang") in ("ja", "en", "other") else None,
        "read_minutes": minutes if isinstance(minutes, int) and 0 < minutes < 300 else None,
        **clean_writeup(it, where, errors, strict),
    }


def validate(data, strict: bool = True) -> list[dict]:
    """检查新闻条目。有问题就抛出 ResultError，并说明要怎么改。"""
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise ResultError('最外层必须是 {"items": [...]}')
    errors, clean = [], []
    for n, it in enumerate(items, 1):
        c = clean_item(it, f"第 {n} 条", errors, strict=strict)
        if c:
            if c["category"] in SECTIONS:
                errors.append(f"第 {n} 条：{c['category']} 是网站分区专用的分类，只能在 learn.json 里提交")
            clean.append(c)
    for cat, task in TASKS.items():
        count = sum(1 for c in clean if c["category"] == cat)
        if count > task["max_items"]:
            errors.append(f"category {cat} 最多 {task['max_items']} 条，现在有 {count} 条")
    if errors:
        raise ResultError("\n".join(errors))
    return clean


def clean_keyword(k, where: str, errors: list, expect_level: str | None) -> dict | None:
    if not isinstance(k, dict):
        errors.append(f"{where}：不是对象")
        return None
    level = k.get("level")
    if expect_level and level != expect_level:
        errors.append(f"{where}：level 必须是「{expect_level}」（顺序：基礎 → 発展 → 応用）")
    if level not in KW_LEVELS:
        errors.append(f"{where}：level 必须是 基礎 / 発展 / 応用 之一")
    term = str(k.get("term") or "").strip()
    explain = str(k.get("explain") or "").strip()
    use = str(k.get("use") or "").strip()
    if not term or not explain or not use:
        errors.append(f"{where}：term、explain、use 都不能为空")
    if explain and not JA_CHARS.search(explain + use):
        errors.append(f"{where}：explain / use 必须用日文写")
    if len(explain) > 260 or len(use) > 180:
        errors.append(f"{where}：explain 最多 260 字、use 最多 180 字（Discord 里要简洁）")
    link = k.get("link")
    if link and not is_url(link):
        errors.append(f"{where}：link 必须是 http(s) 链接或 null")
    example = str(k.get("example") or "").replace("```", "'''")
    if len(example) > 600:
        errors.append(f"{where}：example 最多 600 字（大约 12 行以内）")
    lang = k.get("example_lang") if k.get("example_lang") in ("cpp", "hlsl", "text") else ("cpp" if example else None)
    return {"level": level, "term": term[:60], "en": str(k.get("en") or "").strip()[:60] or None,
            "explain": explain, "use": use, "example": example or None, "example_lang": lang,
            "link": link.strip() if link else None}


def validate_keywords(data, required: bool) -> dict | None:
    """检查技术关键词（每批 3 个：基礎 → 発展 → 応用）。"""
    kws = data.get("keywords") if isinstance(data, dict) else None
    if not kws:
        if required:
            raise ResultError('缺少技术关键词：需要 "keyword_theme" 和 3 个 "keywords"（基礎 → 発展 → 応用）')
        return None
    errors = []
    theme = str(data.get("keyword_theme") or "").strip()
    if not theme:
        errors.append("keyword_theme（这 3 个关键词的共同主题）不能为空")
    if not isinstance(kws, list) or len(kws) != 3:
        raise ResultError("keywords 必须正好 3 个（基礎 → 発展 → 応用）")
    clean = [clean_keyword(k, f"第 {n} 个关键词", errors, lv) for n, (k, lv) in enumerate(zip(kws, KW_LEVELS), 1)]
    if len({norm_text(c["term"]) for c in clean if c}) < 3:
        errors.append("3 个关键词不能重复")
    if errors:
        raise ResultError("\n".join(errors))
    return {"theme": theme[:60], "items": clean}


def read_json(path: str) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ResultError(f"无法读取 JSON：{e}")


# ======================================================================
# 研究端：新闻
# ======================================================================

def used_keywords(state: dict, area: str | None = None) -> list[dict]:
    return [k for k in state["keywords"] if area is None or k.get("area") == area]


def cmd_context(args) -> int:
    now = now_jst()
    slot = args.slot or slot_for(now)
    tasks = tasks_for(now.date(), slot)
    state = load_state()
    recent = [f"- {it.get('title', '')}\n  {it['url']}" for it in state["items"][-200:]
              if it.get("category") not in SECTIONS]

    print(f"# 本次运行：{now:%Y-%m-%d %H:%M} JST ／ {CONFIG['slots'][slot]['label']} 这一批（slot={slot}）\n")
    print(f"读者：{CONFIG['reader']}\n")
    print(f"关注关键词（找到相关内容时优先）：{'、'.join(CONFIG.get('keywords', [])) or '无'}\n")
    print("## 这一批要做的任务")
    if not tasks:
        print("（这个时段没有新闻任务。）")
    for t in tasks:
        print(f"\n### category = \"{t['id']}\"  {t['emoji']} {t['name']}（最多 {t['max_items']} 条）")
        print(t["brief"])
    ids = {t["id"] for t in tasks}
    pages = [p for p in CONFIG.get("check_pages", []) if ids & set(p["for"])]
    if pages:
        print("\n## 没有 RSS、需要直接用 WebFetch 打开看最新内容的官方页面")
        for p in pages:
            print(f"- {p['name']}：{p['url']}（{'、'.join(p['for'])}）")
    if "classic" in ids:
        classics = [it for it in state["items"] if it.get("category") == "classic"]
        print("\n## 「定番の一本」以前介绍过的（不要重复）")
        print("\n".join(f"- {it['title']}" for it in classics) or "（无）")

    track = KW_TRACKS.get(slot)
    if track:
        used = used_keywords(state, track["area"])
        print(f"\n## 技术关键词（这一批必须附上 3 个）：领域 = {track['name']}")
        print(f"范围：{track['focus']}")
        print("已经讲过的关键词（不要重复，主题也尽量换一个方向）：")
        print("、".join(f"{k['term']}（{k['level']}）" for k in used[-150:]) or "（无）")
        themes = list(dict.fromkeys(k.get("theme") for k in used if k.get("theme")))
        if themes:
            print("讲过的主题：" + " / ".join(themes[-40:]))

    print("\n## 已经推送过的内容（不要再选，同一件事的其他文章也不要选）")
    print("\n".join(recent) if recent else "（无）")
    return 0


def cmd_feeds(args) -> int:
    """读取这一批相关的优质网站 RSS，列出最近的新文章，作为研究的第一手候选。"""
    from collectors import collect_feeds

    now = now_jst()
    slot = args.slot or slot_for(now)
    ids = {t["id"] for t in tasks_for(now.date(), slot)} | ({"programmer", "planner"} if args.learn else set())
    feeds = [f for f in CONFIG.get("feeds", []) if ids & set(f["for"])] if not args.learn else \
        [f for f in CONFIG.get("feeds", []) if {"tech", "industry", "community"} & set(f["for"])]
    known = {item_id(it["url"]) for it in load_state()["items"]}
    result = collect_feeds(feeds)
    total = 0
    print(f"# 优质网站的最新文章（{'学习内容用' if args.learn else 'slot=' + slot}，已推送过的不显示）")
    for feed in feeds:
        entries = [e for e in result.get(feed["name"], []) if item_id(e["url"]) not in known]
        if not entries:
            continue
        print(f"\n## {feed['name']}")
        for e in entries:
            total += 1
            when = e["published"].astimezone(JST).strftime("%m/%d %H:%M")
            print(f"- [{when}] {e['title']}\n  {e['url']}")
            if e["text"]:
                print(f"  {e['text'][:180]}")
    print(f"\n（共 {total} 条候选）")
    return 0


def cmd_community(args) -> int:
    from collectors import collect_candidates

    cands = collect_candidates(CONFIG["community"])
    print(f"\n# 社区候选 {len(cands)} 条（score = 点赞/分数）\n")
    for c in cands:
        print(f"- [{c['source']}] {c['title']}  (score {c['score']})")
        print(f"  {c['url']}")
        if c.get("text"):
            print(f"  {c['text'][:200]}")
    return 0


def check_batch_file(path: str, slot: str) -> tuple[list, dict | None]:
    data = read_json(path)
    items = validate(data)
    kw = validate_keywords(data, required=slot in KW_TRACKS)
    return items, kw


def cmd_check(args) -> int:
    slot = args.slot or slot_for(now_jst())
    try:
        items, kw = check_batch_file(args.file, slot)
    except ResultError as e:
        print("❌ 格式有问题，请修改后再检查：\n" + str(e))
        return 1
    print(f"✅ 格式正确：新闻 {len(items)} 条" + (f"，技术关键词 3 个（{kw['theme']}）" if kw else ""))
    return 0


def push_branch(prefix: str, slot_tag: str, filename: str, payload: dict, message: str) -> str:
    now = now_jst()
    branch = f"{prefix}{now:%Y%m%d}-{slot_tag}-{now:%H%M%S}"
    target = ROOT / "inbox" / filename
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    ident = ["-c", "user.name=HIKARI NEWS researcher", "-c", "user.email=researcher@hikari-news.invalid"]
    git("checkout", "-B", branch)
    git("add", "-f", f"inbox/{filename}")
    git(*ident, "commit", "-m", message)
    git("push", "origin", f"HEAD:refs/heads/{branch}")
    return branch


def cmd_submit(args) -> int:
    """检查结果，然后推送到 GitHub。正式：claude/inbox-…（会发到 Discord）。预览：claude/preview-…（不会发布）。"""
    slot = args.slot or slot_for(now_jst())
    try:
        items, kw = check_batch_file(args.file, slot)
    except ResultError as e:
        print("❌ 格式有问题，没有提交。请修改后再执行 submit：\n" + str(e))
        return 1
    raw = read_json(args.file)
    now = now_jst()
    batch = {"slot": slot, "date": now.strftime("%Y-%m-%d"), "created_at": now.isoformat(timespec="seconds"),
             "items": items, "keyword_theme": kw["theme"] if kw else None, "keywords": kw["items"] if kw else None,
             "report": str(raw.get("report") or "")[:3000]}
    prefix = PREVIEW_PREFIX if args.preview else INBOX_PREFIX
    branch = push_branch(prefix, slot, "batch.json", batch, f"inbox: {batch['date']} {slot} ({len(items)} items)")
    where = "预览分支（不会发到 Discord）" if args.preview else "分支（GitHub Actions 会自动发布）"
    print(f"✅ 已提交 {len(items)} 条新闻 + 技术关键词到{where} {branch}")
    return 0


# ======================================================================
# 研究端：学习内容（夜间任务）
# ======================================================================

def clean_quiz(q, where: str, errors: list) -> dict | None:
    if not isinstance(q, dict):
        errors.append(f"{where}：不是对象")
        return None
    track, topic, level = q.get("track"), q.get("topic"), q.get("level")
    if track not in QUIZ_TOPICS:
        errors.append(f"{where}：track 必须是 {list(QUIZ_TOPICS)} 之一")
    elif topic not in QUIZ_TOPICS[track]:
        errors.append(f"{where}：track={track} 的 topic 必须是 {QUIZ_TOPICS[track]} 之一")
    if level not in KW_LEVELS:
        errors.append(f"{where}：level 必须是 基礎 / 発展 / 応用 之一")
    text = str(q.get("q") or "").strip()
    if not text or not JA_CHARS.search(text):
        errors.append(f"{where}：q（问题）不能为空，并且要用日文写")
    choices = q.get("choices")
    if not isinstance(choices, list) or len(choices) != 4 or not all(isinstance(c, str) and c.strip() for c in choices):
        errors.append(f"{where}：choices 必须是 4 个非空字符串")
        choices = ["", "", "", ""]
    elif len({norm_text(c) for c in choices}) < 4:
        errors.append(f"{where}：4 个选项不能重复")
    if any(len(c) > 160 for c in choices):
        errors.append(f"{where}：每个选项最多 160 字")
    answer = q.get("answer")
    if not isinstance(answer, int) or not 0 <= answer <= 3:
        errors.append(f"{where}：answer 必须是 0〜3 的整数（正确选项的位置）")
        answer = 0
    explain = str(q.get("explain") or "").strip()
    if len(explain) < 15 or not JA_CHARS.search(explain):
        errors.append(f"{where}：explain（解析）至少 15 字，用日文写：为什么这个是对的、其他为什么不对")
    if len(explain) > 700:
        errors.append(f"{where}：explain 最多 700 字")
    link = q.get("link")
    if link and not is_url(link):
        errors.append(f"{where}：link 必须是 http(s) 链接或 null")
    code = str(q.get("code") or "").replace("```", "'''")
    if len(code) > 900:
        errors.append(f"{where}：code 最多 900 字（大约 15 行以内）")
    return {"id": quiz_id(text, choices[answer]), "track": track, "topic": topic, "level": level,
            "q": text[:400], "code": code or None,
            "code_lang": q.get("code_lang") if q.get("code_lang") in ("cpp", "hlsl", "text") else ("cpp" if code else None),
            "choices": [c.strip() for c in choices], "answer": answer, "explain": explain,
            "link": link.strip() if link else None}


def validate_learn(data, strict: bool = True) -> dict:
    if not isinstance(data, dict):
        raise ResultError("最外层必须是对象")
    errors = []
    out = {"news": [], "quiz": [], "theme": None, "ideas": {}, "fixes": [], "keywords": [],
           "reviewed_reports": [], "report": str(data.get("report") or "")[:3000]}

    for n, it in enumerate(data.get("news") or [], 1):
        # 研究端は section で書く。交稿後のデータ（発布端が読むもの）は整理済みで category に入っている
        sec = (it.get("section") or it.get("category")) if isinstance(it, dict) else None
        if sec not in SECTIONS:
            errors.append(f"news 第 {n} 条：section 必须是 {sorted(SECTIONS)} 之一")
            continue
        c = clean_item(it, f"news 第 {n} 条", errors, force_category=sec, strict=strict)
        if c:
            out["news"].append(c)
    for sec in SECTIONS:
        if sum(1 for c in out["news"] if c["category"] == sec) > TASKS[sec]["max_items"]:
            errors.append(f"news：{sec} 最多 {TASKS[sec]['max_items']} 条")

    quiz = data.get("quiz") or []
    if len(quiz) > 40:
        errors.append("quiz 一次最多 40 题")
    seen = set()
    for n, q in enumerate(quiz, 1):
        c = clean_quiz(q, f"quiz 第 {n} 题", errors)
        if c:
            if c["id"] in seen:
                errors.append(f"quiz 第 {n} 题：和前面的题重复")
            seen.add(c["id"])
            out["quiz"].append(c)

    th = data.get("theme")
    if th:
        title = str(th.get("title") or "").strip() if isinstance(th, dict) else ""
        angles = th.get("angles") if isinstance(th, dict) else None
        if not title or len(title) > 40 or not JA_CHARS.search(title):
            errors.append("theme.title：用日文，40 字以内")
        if not isinstance(angles, list) or not 2 <= len(angles) <= 4 or not all(isinstance(a, str) and a.strip() for a in angles):
            errors.append("theme.angles：2〜4 个切入角度（字符串）")
            angles = []
        out["theme"] = {"title": title, "angles": [a.strip()[:100] for a in angles],
                        "note": str(th.get("note") or "").strip()[:240] or None} if isinstance(th, dict) else None

    ideas = data.get("ideas") or {}
    if not isinstance(ideas, dict):
        errors.append("ideas 必须是对象：{池名: [词, ...]}")
        ideas = {}
    for pool, words in ideas.items():
        if pool not in IDEA_POOLS:
            errors.append(f"ideas：池名必须是 {IDEA_POOLS} 之一，不能是 {pool}")
            continue
        if not isinstance(words, list) or len(words) > 20:
            errors.append(f"ideas.{pool}：最多 20 个词的数组")
            continue
        limit = 80 if pool == "prompt" else 30
        clean = [w.strip() for w in words if isinstance(w, str) and w.strip()]
        if any(len(w) > limit for w in clean):
            errors.append(f"ideas.{pool}：每个词最多 {limit} 字")
        out["ideas"][pool] = clean

    for n, f in enumerate(data.get("fixes") or [], 1):
        if not isinstance(f, dict) or not isinstance(f.get("id"), str) or f.get("action") not in ("delete", "replace"):
            errors.append(f"fixes 第 {n} 条：需要 id 和 action（delete / replace）")
            continue
        rep = None
        if f["action"] == "replace":
            rep = clean_quiz(f.get("replacement"), f"fixes 第 {n} 条的 replacement", errors)
        out["fixes"].append({"id": f["id"], "action": f["action"], "replacement": rep})

    for n, k in enumerate(data.get("keywords") or [], 1):
        area = k.get("area") if isinstance(k, dict) else None
        if area not in KW_AREAS:
            errors.append(f"keywords 第 {n} 个：area 必须是 {list(KW_AREAS)} 之一")
            continue
        c = clean_keyword(k, f"keywords 第 {n} 个", errors, None)
        if c:
            c.update(area=area, theme=str(k.get("theme") or "").strip()[:60])
            out["keywords"].append(c)

    rr = data.get("reviewed_reports") or []
    out["reviewed_reports"] = [r for r in rr if isinstance(r, str)][:50]

    if errors:
        raise ResultError("\n".join(errors))
    return out


def cmd_learn_context(args) -> int:
    now = now_jst()
    state = load_state()
    print(f"# 学习内容的生成：{now:%Y-%m-%d %H:%M} JST\n")
    print(f"读者：{CONFIG['reader']}\n")

    bank = {}
    for q in state["quiz"]:
        bank.setdefault(q["topic"], []).append(q)
    total = sum(len(v) for v in bank.values())
    small = total < LEARN.get("small_bank", 60)
    quota = LEARN.get("daily_quiz", {})
    print("## 今天要出的题")
    for track, n in quota.items():
        print(f"- {track}：{n * 2 if small else n} 题" + ("（题库还很少，今天加倍）" if small else ""))
    print("\n## 题库现状（按 topic，难度 基礎/発展/応用）")
    for track, topics in QUIZ_TOPICS.items():
        for t in topics:
            qs = bank.get(t, [])
            lv = {l: sum(1 for q in qs if q.get("level") == l) for l in KW_LEVELS}
            print(f"- [{track}] {t}（{TOPIC_NAMES.get(t, t)}）：{len(qs)} 题　基礎 {lv['基礎']} / 発展 {lv['発展']} / 応用 {lv['応用']}")
    print("\n## 已有的题目（不要出意思相同的题）")
    for t, qs in bank.items():
        print(f"\n### {t}")
        print("\n".join(f"- {q['q']}" for q in qs[-40:]))

    print("\n## 最近推送的技术关键词（可以用来出题，帮助复习）")
    print("、".join(f"{k['term']}（{KW_AREAS.get(k.get('area'), {}).get('name', '')}・{k['level']}）"
                   for k in state["keywords"][-45:]) or "（无）")

    print("\n## 以前的「今日のお題」（不要重复）")
    print("、".join(t["title"] for t in state["themes"][-60:]) or "（无）")

    print("\n## アイデアガチャ 词库的现状（每个池子今天补充约 5 个新词，不要和常见的重复）")
    for p in IDEA_POOLS:
        print(f"- {p}：{state['idea_counts'].get(p, 0)} 个")

    print("\n## 被用户回报「题目有问题」的题（请逐一核实：有错就修正或删除，没问题也要写进 reviewed_reports）")
    if state["reports"]:
        for r in state["reports"]:
            print(f"- report_id={r['id']} / quiz_id={r['qid']} / topic={r.get('topic')}\n  问题：{r.get('q')}\n  回报理由：{r.get('reason')}")
    else:
        print("（无）")

    print("\n## 两个分区已经推送过的新闻（不要重复）")
    sec_items = [it for it in state["items"] if it.get("category") in SECTIONS]
    print("\n".join(f"- [{it['category']}] {it['title']}\n  {it['url']}" for it in sec_items[-60:]) or "（无）")
    for sec in sorted(SECTIONS):
        print(f"\n### section = \"{sec}\" 的选题方向\n{TASKS[sec]['brief']}")
    return 0


def cmd_learn_check(args) -> int:
    try:
        L = validate_learn(read_json(args.file))
    except ResultError as e:
        print("❌ 格式有问题，请修改后再检查：\n" + str(e))
        return 1
    print(f"✅ 格式正确：新闻 {len(L['news'])}、题目 {len(L['quiz'])}、お題 {'1' if L['theme'] else '0'}、"
          f"词库 {sum(len(v) for v in L['ideas'].values())} 词、修正 {len(L['fixes'])}")
    return 0


def cmd_learn_submit(args) -> int:
    try:
        L = validate_learn(read_json(args.file))
    except ResultError as e:
        print("❌ 格式有问题，没有提交。请修改后再执行 learn-submit：\n" + str(e))
        return 1
    now = now_jst()
    payload = {"date": now.strftime("%Y-%m-%d"), "created_at": now.isoformat(timespec="seconds"), **L}
    prefix = PREVIEW_PREFIX + "learn-" if args.preview else LEARN_PREFIX
    branch = push_branch(prefix, "learn", "learn.json", payload,
                         f"learn: {payload['date']} ({len(L['quiz'])} quiz, {len(L['news'])} news)")
    print(f"✅ 已提交学习内容到 {branch}" + ("（预览，不会发布）" if args.preview else "（GitHub Actions 会自动写入网站）"))
    return 0


# ======================================================================
# 发布端：Discord
# ======================================================================

MD_SPECIAL = re.compile(r"([*_~`|>\\])")


def md(text: str) -> str:
    """转义 Discord 的 Markdown 符号，避免标题里的符号把排版弄乱。"""
    return MD_SPECIAL.sub(r"\\\1", text).replace("[", "［").replace("]", "］")


def item_line(it: dict) -> str:
    stars = "★" * it["importance"]
    badges = []
    if it.get("level"):
        badges.append(f"`{it['level']}`")
    if it.get("lang") == "en":
        badges.append("`英語`")
    if it.get("read_minutes"):
        badges.append(f"⏱{it['read_minutes']}分")
    if it.get("keywords"):
        badges.append("🔔")
    head = f"{stars} **[{md(it['title'])}]({it['url']})** {' '.join(badges)}".rstrip()
    sub = it["note"] or it["summary"]
    if len(sub) > 90:
        sub = sub[:88] + "…"
    line = f"{head}\n└ {md(sub)}"
    if it.get("deadline"):
        line += f"（⏰ {it['deadline'][5:].replace('-', '/')} 締切）"
    return line


def build_keyword_embed(kw: dict, area_name: str) -> dict:
    nums = "①②③"
    parts = []
    for i, k in enumerate(kw["items"]):
        head = f"**{nums[i]} {k['level']}｜{md(k['term'])}**" + (f"（{md(k['en'])}）" if k.get("en") else "")
        body = f"{md(k['explain'])}\n🛠 {md(k['use'])}"
        if k.get("example"):
            body += f"\n```{k.get('example_lang') or ''}\n{k['example'][:420]}\n```"
        if k.get("link"):
            body += f"\n📖 [ドキュメント]({k['link']})"
        parts.append(f"{head}\n{body}")
    return {"title": f"🔑 今日の技術キーワード｜{area_name}"[:256],
            "description": (f"テーマ：**{md(kw['theme'])}**\n\n" + "\n\n".join(parts))[:4000],
            "color": 0xF2F56A}


def build_batch_embeds(items: list[dict], reminders: list[tuple[int, dict]],
                       kw: dict | None = None, area_name: str = "") -> list[dict]:
    embeds = []
    pick = max(items, key=lambda x: (x["importance"], bool(x.get("keywords")))) if items else None
    if pick:
        t = TASKS[pick["category"]]
        desc = md(pick["summary"])
        if pick.get("points"):
            desc += "\n\n" + "\n".join(f"▸ {md(p)}" for p in pick["points"])
        if pick["note"]:
            desc += f"\n\n💡 {md(pick['note'])}"
        embeds.append({
            "title": f"🔥 イチオシ｜{pick['title']}"[:256],
            "url": pick["url"],
            "description": desc[:1500],
            "color": 0xF1C40F,
            "footer": {"text": f"{t['emoji']} {t['name']} ・ {pick['source']}"[:200]},
        })
    for task in CONFIG["tasks"]:
        group = sorted((it for it in items if it["category"] == task["id"] and it is not pick),
                       key=lambda x: -x["importance"])
        if not group:
            continue
        embeds.append({
            "title": f"{task['emoji']} {task['name']}（{len(group)}）",
            "description": "\n\n".join(item_line(it) for it in group)[:4000],
            "color": int(task["color"], 16),
        })
    if kw:
        embeds.append(build_keyword_embed(kw, area_name))
    if reminders:
        lines = []
        for days, it in reminders:
            when = "**今日まで**" if days == 0 else f"**あと{days}日**"
            lines.append(f"{when}（{it['deadline'][5:].replace('-', '/')}）[{md(it['title'])}]({it['url']})")
        embeds.append({"title": "⏰ 締め切り間近", "description": "\n".join(lines)[:2000], "color": 0xE67E22})
    if CONFIG.get("site_url"):
        embeds.append({"description": f"📖 [詳しい要約・過去の記事・ドリルはサイトで]({CONFIG['site_url']})", "color": 0x2B2D31})
    return embeds


def chunk_embeds(embeds: list[dict]) -> list[list[dict]]:
    """Discord 限制：一条消息最多 10 个 embed、合计 6000 字。超过就拆成多条（同一个帖子里）。"""
    def size(e):
        return sum(len(str(e.get(k, ""))) for k in ("title", "description")) + len(str(e.get("footer", "")))
    chunks, cur, total = [], [], 0
    for e in embeds:
        s = size(e)
        if cur and (len(cur) == 10 or total + s > 5800):
            chunks.append(cur)
            cur, total = [], 0
        cur.append(e)
        total += s
    if cur:
        chunks.append(cur)
    return chunks


def discord_post(webhook: str, payload: dict, thread_id: str | None = None) -> dict:
    import requests

    params = {"wait": "true"}
    if thread_id:
        params["thread_id"] = thread_id
    payload = {**payload, "allowed_mentions": {"parse": []}}
    for attempt in range(3):
        r = requests.post(webhook, params=params, json=payload, timeout=30)
        if r.status_code == 429:
            time.sleep(float(r.json().get("retry_after", 2)) + 0.5)
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"Discord 推送失败：HTTP {r.status_code} {r.text[:300]}")
        return r.json()
    raise RuntimeError("Discord 推送失败：一直被限流（429）")


def post_forum_thread(title: str, embeds: list[dict], dry_run: bool) -> None:
    chunks = chunk_embeds(embeds)
    if dry_run:
        print(f"----- 论坛帖子（dry-run）：{title} -----")
        print(json.dumps(chunks, ensure_ascii=False, indent=1)[:6000])
        return
    webhook = os.environ.get("DISCORD_FORUM_WEBHOOK")
    if not webhook:
        raise RuntimeError("没有设置 DISCORD_FORUM_WEBHOOK")
    first = discord_post(webhook, {"thread_name": title[:100], "embeds": chunks[0]})
    thread_id = first.get("channel_id")
    for chunk in chunks[1:]:
        discord_post(webhook, {"embeds": chunk}, thread_id=thread_id)


# ======================================================================
# 配信：「受け取り設定」をした人へ（自分の Discord チャンネル・メール）
# ======================================================================

def site_link(path: str = "") -> str:
    base = (CONFIG.get("site_url") or "").rstrip("/")
    return f"{base}/{path}" if base else ""


def post_to_own_webhook(url: str, title: str, embeds: list[dict]) -> None:
    """登録された Webhook へ、論坛帖子と同じ内容を送る。フォーラムのチャンネルなら新しいスレッドを作る。"""
    chunks = chunk_embeds(embeds)
    thread_id = None
    for i, chunk in enumerate(chunks):
        payload = {"embeds": chunk}
        if i == 0:
            payload["content"] = f"**{title[:180]}**"
            try:
                discord_post(url, payload)
                continue
            except RuntimeError as e:
                if "thread_name" not in str(e):
                    raise
                first = discord_post(url, {"thread_name": title[:100], "embeds": chunk})   # フォーラムのチャンネルだった
                thread_id = first.get("channel_id")
                continue
        discord_post(url, payload, thread_id=thread_id)
        time.sleep(0.3)


def deliver_webhooks(subs: list[dict], store, title: str, embeds: list[dict], dry_run: bool) -> str:
    targets = [s for s in subs if s.get("webhook_on") and s.get("webhook")]
    if not targets:
        return ""
    if dry_run:
        return f"（dry-run）自分の Discord への配信 {len(targets)} 人"
    ok, errors = 0, []
    for s in targets:
        try:
            post_to_own_webhook(s["webhook"], title, embeds)
            ok += 1
        except Exception as e:
            msg = str(e)
            if any(f"HTTP {c}" in msg for c in (401, 403, 404)):
                store.disable_webhook(s["uid"])
                errors.append("Webhook が削除されていたので、その人への配信を止めました")
            else:
                errors.append(msg[:120])
        time.sleep(0.5)
    return f"自分の Discord へ配信 {ok}/{len(targets)} 人" + (f"（{'; '.join(errors)[:300]}）" if errors else "")


# ---------------------------------------------------------------- メール
def _h(s) -> str:
    import html as H
    return H.escape(str(s or ""))


MAIL_WRAP = ("<div style=\"background:#f4f1e8;padding:24px 12px;font-family:'Hiragino Sans','Noto Sans JP','Yu Gothic',Meiryo,sans-serif;"
             "color:#15161c;line-height:1.8\"><div style=\"max-width:640px;margin:0 auto\">{body}</div></div>")


def _mail_head(title: str, sub: str) -> str:
    return (f"<div style=\"background:#0b0b0b;border-radius:16px 16px 0 0;padding:18px 22px\">"
            f"<div style=\"color:#f2f56a;font-weight:900;font-size:20px;letter-spacing:.04em\">★ HIKARI NEWS</div>"
            f"<div style=\"color:#ffffff;font-size:14px;font-weight:700;margin-top:2px\">{_h(title)}</div>"
            f"<div style=\"color:#b8bcc8;font-size:12px\">{_h(sub)}</div></div>")


def _mail_foot() -> str:
    return (f"<p style=\"font-size:12px;color:#7a7e8a;margin:16px 4px 0;line-height:1.7\">"
            f"記事の要約・解説は AI が作成しています。正確な内容は原文でご確認ください。紹介記事の著作権は各著作者に帰属します。<br>"
            f"配信の停止・設定の変更は <a href=\"{_h(site_link('#/notify'))}\" style=\"color:#b06d00\">受け取り設定</a> から。"
            f" ／ <a href=\"{_h(site_link('#/about'))}\" style=\"color:#b06d00\">このサイトについて</a></p>")


def _mail_item(it: dict, big: bool = False) -> str:
    link = site_link(f"#/today?open={it['id']}") if it.get("id") else ""
    pts = it.get("points") or []
    out = (f"<div style=\"padding:14px 0;border-top:1px solid #ebe6d9\">"
           f"<a href=\"{_h(it['url'])}\" style=\"color:#15161c;text-decoration:none;font-weight:800;font-size:{18 if big else 15}px\">{_h(it['title'])}</a>"
           f"<div style=\"font-size:12px;color:#7a7e8a;margin-top:2px\">{_h(it.get('source'))}"
           + (f" ・ ⏰ 締切 {_h(it['deadline'])}" if it.get("deadline") else "") + "</div>")
    if big and it.get("summary"):
        out += f"<p style=\"margin:8px 0;font-size:14px\">{_h(it['summary'])}</p>"
    if big and pts:
        out += "<ul style=\"margin:6px 0 6px 18px;padding:0;font-size:14px\">" + "".join(f"<li style=\"margin:2px 0\">{_h(p)}</li>" for p in pts) + "</ul>"
    elif it.get("note"):
        out += f"<div style=\"font-size:14px;color:#3c3f4a;margin-top:4px\">💡 {_h(it['note'])}</div>"
    if link and (it.get("detail") or big):
        out += f"<div style=\"margin-top:6px\"><a href=\"{_h(link)}\" style=\"font-size:13px;color:#b06d00;font-weight:700\">サイトで解説を読む →</a></div>"
    return out + "</div>"


def _mail_box(inner: str) -> str:
    return f"<div style=\"background:#fffdf7;border:1px solid #e5e0d2;border-top:0;border-radius:0 0 16px 16px;padding:6px 22px 18px\">{inner}</div>"


def email_for_batch(title: str, items: list[dict], kw: dict | None, area_name: str,
                    reminders: list[tuple[int, dict]]) -> tuple[str, str]:
    """1 回の配信ぶんのメール（HTML とテキスト）。"""
    inner, text = "", [title, ""]
    pick = max(items, key=lambda x: (x["importance"], bool(x.get("keywords")))) if items else None
    if pick:
        inner += "<p style=\"margin:16px 0 0;font-size:12px;font-weight:800;color:#b06d00\">🔥 イチオシ</p>" + _mail_item(pick, big=True)
        text += [f"🔥 {pick['title']}", pick["url"], *[f"・{p}" for p in pick.get("points") or []], ""]
    for task in CONFIG["tasks"]:
        group = [it for it in items if it["category"] == task["id"] and it is not pick]
        if not group:
            continue
        inner += f"<p style=\"margin:18px 0 0;font-size:13px;font-weight:800\">{_h(task['emoji'])} {_h(task['name'])}</p>"
        inner += "".join(_mail_item(it) for it in sorted(group, key=lambda x: -x["importance"]))
        text += [f"{task['emoji']} {task['name']}"] + [f"・{it['title']}\n  {it['url']}" for it in group] + [""]
    if kw:
        inner += (f"<div style=\"margin-top:18px;padding:14px 16px;background:#fbf9c9;border-radius:12px\">"
                  f"<div style=\"font-weight:800;font-size:14px\">🔑 今日の技術キーワード｜{_h(area_name)}</div>"
                  f"<div style=\"font-size:12px;color:#5c6070\">テーマ：{_h(kw['theme'])}</div>")
        for k in kw["items"]:
            inner += (f"<div style=\"margin-top:8px;font-size:14px\"><b>{_h(k['level'])}｜{_h(k['term'])}</b>"
                      f"<div>{_h(k['explain'])}</div><div style=\"color:#5c6070\">🛠 {_h(k['use'])}</div></div>")
            text.append(f"🔑 {k['level']}｜{k['term']}：{k['explain']}")
        inner += "</div>"
    if reminders:
        inner += "<p style=\"margin:18px 0 4px;font-size:13px;font-weight:800\">⏰ 締め切り間近</p>" + "".join(
            f"<div style=\"font-size:14px\">{'今日まで' if d == 0 else f'あと{d}日'}：<a href=\"{_h(it['url'])}\" style=\"color:#15161c\">{_h(it['title'])}</a></div>"
            for d, it in reminders)
    inner += f"<p style=\"margin:20px 0 0\"><a href=\"{_h(site_link('#/today'))}\" style=\"display:inline-block;background:#f2f56a;color:#0b0b0b;font-weight:800;padding:10px 18px;border-radius:10px;border:2px solid #0b0b0b;text-decoration:none\">サイトで全部見る</a></p>"
    html = MAIL_WRAP.format(body=_mail_head(title, "新しい記事が届きました") + _mail_box(inner) + _mail_foot())
    text += ["", f"サイト：{site_link('#/today')}", f"配信の停止・設定：{site_link('#/notify')}"]
    return html, "\n".join(text)


def email_for_day(day: date, items: list[dict], kws: list[dict]) -> tuple[str, str]:
    """1 日 1 回まとめ（22 時ごろ）のメール。"""
    title = f"{day.month}/{day.day}（{WEEKDAYS_JA[day.weekday()]}）のまとめ"
    inner, text = "", [title, ""]
    for slot in ("10", "17", "22"):
        group = sorted((it for it in items if str(it.get("slot")) == slot), key=lambda x: -int(x.get("importance") or 3))
        if not group:
            continue
        inner += f"<p style=\"margin:18px 0 0;font-size:13px;font-weight:800\">🕘 {_h(CONFIG['slots'][slot]['label'])} の便</p>"
        inner += "".join(_mail_item(it) for it in group)
        text += [f"🕘 {CONFIG['slots'][slot]['label']}"] + [f"・{it['title']}\n  {it['url']}" for it in group] + [""]
    if kws:
        inner += ("<div style=\"margin-top:18px;padding:14px 16px;background:#fbf9c9;border-radius:12px\">"
                  "<div style=\"font-weight:800;font-size:14px\">🔑 今日の技術キーワード</div>"
                  + "".join(f"<div style=\"font-size:14px;margin-top:4px\">{_h(k.get('level'))}｜<b>{_h(k.get('term'))}</b>"
                            f"<span style=\"color:#5c6070\">（{_h(k.get('theme'))}）</span></div>" for k in kws) + "</div>")
        text += ["🔑 " + "、".join(str(k.get("term")) for k in kws)]
    inner += f"<p style=\"margin:20px 0 0\"><a href=\"{_h(site_link('#/today'))}\" style=\"display:inline-block;background:#f2f56a;color:#0b0b0b;font-weight:800;padding:10px 18px;border-radius:10px;border:2px solid #0b0b0b;text-decoration:none\">サイトで解説を読む</a></p>"
    html = MAIL_WRAP.format(body=_mail_head(title, f"今日の記事 {len(items)} 本") + _mail_box(inner) + _mail_foot())
    text += ["", f"サイト：{site_link('#/today')}", f"配信の停止・設定：{site_link('#/notify')}"]
    return html, "\n".join(text)


def send_via_relay(url: str, token: str, to_list: list[str], subject: str, html: str, text: str) -> str:
    """Google Apps Script（tools/mail_relay.gs）経由で送る。送信元の Gmail で 1 人ずつ送られる。"""
    try:
        import requests
        r = requests.post(url, json={"token": token, "to": to_list, "subject": subject, "html": html, "text": text}, timeout=90)
        data = r.json()
    except Exception as e:
        return f"⚠️ メールを送れませんでした（Apps Script に接続できない：{str(e)[:150]}）"
    if not data.get("ok"):
        return f"⚠️ メールを送れませんでした（Apps Script：{str(data.get('error'))[:150]}）"
    errs = data.get("errors") or []
    return (f"メール {data.get('sent', 0)}/{len(to_list)} 人（今日あと {data.get('remaining', '?')} 通まで）"
            + (f"（失敗：{'; '.join(map(str, errs))[:300]}）" if errs else ""))


def send_emails(to_list: list[str], subject: str, html: str, text: str, dry_run: bool) -> str:
    """1 人ずつ送る（宛先はお互いに見えない）。Apps Script の中継があればそれを、なければ Gmail（アプリ パスワード）を使う。"""
    if not to_list:
        return ""
    if dry_run:
        return f"（dry-run）メール {len(to_list)} 人：{subject}"
    relay, token = os.environ.get("MAIL_RELAY_URL"), os.environ.get("MAIL_RELAY_TOKEN")
    if relay and token:
        return send_via_relay(relay, token, to_list, subject, html, text)
    addr, pw = os.environ.get("GMAIL_ADDRESS"), os.environ.get("GMAIL_APP_PASSWORD")
    if not addr or not pw:
        return (f"⚠️ メール {len(to_list)} 人ぶん未送信（GitHub Secrets に MAIL_RELAY_URL / MAIL_RELAY_TOKEN、"
                f"または GMAIL_ADDRESS / GMAIL_APP_PASSWORD がまだありません）")
    import smtplib
    import ssl
    from email.message import EmailMessage
    ok, errors = 0, []
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as smtp:
            smtp.login(addr, pw)
            for to in to_list:
                msg = EmailMessage()
                msg["Subject"], msg["From"], msg["To"] = subject, f"HIKARI NEWS <{addr}>", to
                msg["List-Unsubscribe"] = f"<{site_link('#/notify')}>"
                msg.set_content(text)
                msg.add_alternative(html, subtype="html")
                try:
                    smtp.send_message(msg)
                    ok += 1
                except Exception as e:
                    errors.append(str(e)[:120])
    except Exception as e:
        return f"⚠️ メールを送れませんでした：{str(e)[:200]}"
    return f"メール {ok}/{len(to_list)} 人" + (f"（失敗：{'; '.join(errors)[:300]}）" if errors else "")


def deliver_batch(store, title: str, embeds: list[dict], items: list[dict], kw: dict | None, area_name: str,
                  reminders: list[tuple[int, dict]], dry_run: bool) -> str:
    """1 回の配信を、受け取り設定をした人へ。失敗しても論坛帖子・網站には影響させない。"""
    if store is None and not dry_run:
        return ""
    try:
        subs = store.subscribers() if store is not None else []
    except Exception as e:
        return f"（受け取り設定を読めませんでした：{str(e)[:120]}）"
    notes = []
    try:
        notes.append(deliver_webhooks(subs, store, title, embeds, dry_run))
    except Exception as e:   # 配信の失敗で、論坛帖子・網站への発布を「失敗」にしない
        notes.append(f"⚠️ 自分の Discord への配信でエラー：{str(e)[:150]}")
    each = [s["email"] for s in subs if s.get("email_on") and s.get("email_mode") == "each" and s.get("email")]
    if each:
        try:
            html, text = email_for_batch(title, items, kw, area_name, reminders)
            notes.append(send_emails(each, title, html, text, dry_run))
        except Exception as e:
            notes.append(f"⚠️ メール配信でエラー：{str(e)[:150]}")
    return "；".join(n for n in notes if n)


def daily_mail(state: dict, store, now: datetime, dry_run: bool) -> str | None:
    """「1 日 1 回まとめ」の人へ、22 時の便のあと（遅くとも 22:40 以降）に 1 回だけ送る。"""
    today = now.date().isoformat()
    if state.get("last_daily_mail") == today:
        return None
    got22 = any(b.get("date") == today and str(b.get("slot")) == "22" and str(b.get("status", "")).startswith("ok")
                for b in state["batches"])
    if not (got22 or now.hour >= 23 or (now.hour == 22 and now.minute >= 40)):
        return None
    if store is None:
        return None
    state["last_daily_mail"] = today
    try:
        to = [s["email"] for s in store.subscribers() if s.get("email_on") and s.get("email_mode") == "daily" and s.get("email")]
    except Exception as e:
        return f"（受け取り設定を読めませんでした：{str(e)[:120]}）"
    items = [it for it in state["items"] if it.get("date") == today and str(it.get("slot")) in CONFIG["slots"]
             and not TASKS.get(it.get("category"), {}).get("section")]
    kws = [k for k in state.get("keywords", []) if k.get("date") == today]
    if not to or not (items or kws):
        return None
    html, text = email_for_day(now.date(), items, kws)
    return "📮 1 日まとめメール：" + send_emails(to, f"📰 HIKARI NEWS {now.month}/{now.day} のまとめ", html, text, dry_run)


def log(text: str, dry_run: bool) -> None:
    """发给管理员日志频道（没有设置的话只打印出来）。"""
    print(f"[bot-log] {text}")
    webhook = os.environ.get("DISCORD_LOG_WEBHOOK")
    if webhook and not dry_run:
        try:
            discord_post(webhook, {"content": text[:1900]})
        except Exception as e:  # 日志发不出去不影响主流程
            print(f"（bot-log 发送失败：{e}）", file=sys.stderr)


# ======================================================================
# 发布端：主流程
# ======================================================================

def pending_branches(prefix: str) -> list[str]:
    git("fetch", "--prune", "origin", f"+refs/heads/{prefix}*:refs/remotes/origin/{prefix}*")
    out = git("for-each-ref", "--format=%(refname:short)", f"refs/remotes/origin/{prefix}*")
    return sorted(line.split("origin/", 1)[1] for line in out.split() if line)


def due_reminders(state: dict, today: date) -> list[tuple[int, dict]]:
    due = []
    for it in state["items"]:
        if not it.get("deadline"):
            continue
        try:
            days = (date.fromisoformat(it["deadline"]) - today).days
        except ValueError:
            continue
        if days in CONFIG["reminder_days"] and days not in it.get("reminded", []):
            due.append((days, it))
    return sorted(due, key=lambda x: x[0])


def thread_title(day: date, slot: str, cats: list[str]) -> str:
    names = "・".join(TASKS[c]["name"] for c in cats) or "技術キーワード"
    return f"📰 {day.month}/{day.day}（{WEEKDAYS_JA[day.weekday()]}）{CONFIG['slots'][slot]['label']}｜{names}"


def enrich(it: dict, day: date, slot: str) -> dict:
    task = TASKS[it["category"]]
    return {**it, "id": item_id(it["url"]), "date": day.isoformat(), "slot": slot,
            "category_name": task["name"], "emoji": task["emoji"], "section": task.get("section"),
            "keywords": match_keywords(it)}


def remember_item(state: dict, it: dict) -> None:
    state["items"].append({k: it.get(k) for k in ("id", "url", "title", "category", "importance",
                                                   "date", "slot", "deadline", "source", "note")} | {"reminded": []})


def batch_day(batch: dict) -> date:
    d = str(batch.get("date"))
    return date.fromisoformat(d) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) else now_jst().date()


def publish_batch(branch: str, state: dict, store, dry_run: bool) -> str:
    batch = json.loads(git("show", f"origin/{branch}:inbox/batch.json"))  # 只当作数据读取
    items = validate(batch, strict=False)
    slot = batch.get("slot") if batch.get("slot") in CONFIG["slots"] else slot_for(now_jst())
    day = batch_day(batch)
    note_kw = ""
    try:
        kw = validate_keywords(batch, required=False)
    except ResultError as e:
        kw, note_kw = None, f"（技术关键词格式有误，已跳过：{str(e)[:120]}）"
    track = KW_TRACKS.get(slot)
    if kw and track:
        known_terms = {norm_text(k["term"]) for k in used_keywords(state, track["area"])}
        if all(norm_text(k["term"]) in known_terms for k in kw["items"]):
            kw, note_kw = None, "（技术关键词全部重复，已跳过）"

    known = {it["id"] for it in state["items"]}
    fresh = []
    for it in items:
        e = enrich(it, day, slot)
        if e["id"] in known:
            continue
        known.add(e["id"])
        fresh.append(e)

    reminders = due_reminders(state, day) if slot == "10" else []
    note_deliver = ""
    if fresh or reminders or kw:
        cats = [t["id"] for t in CONFIG["tasks"] if any(it["category"] == t["id"] for it in fresh)]
        title = thread_title(day, slot, cats)
        embeds = build_batch_embeds(fresh, reminders, kw, track["name"] if track else "")
        post_forum_thread(title, embeds, dry_run)
        note_deliver = deliver_batch(store, title, embeds, fresh, kw, track["name"] if track else "", reminders, dry_run)

    if not dry_run:
        store.add_items([{**it, "reminded": []} for it in fresh])
        if kw and track:
            store.add_keywords(track["area"], [{**k, "theme": kw["theme"], "date": day.isoformat(), "slot": slot}
                                               for k in kw["items"]])
    for it in fresh:
        remember_item(state, it)
    if kw and track:
        state["keywords"] += [{"term": k["term"], "level": k["level"], "area": track["area"],
                               "theme": kw["theme"], "date": day.isoformat()} for k in kw["items"]]
    for days, it in reminders:
        it.setdefault("reminded", []).append(days)
    state["batches"].append({"branch": branch, "slot": slot, "date": day.isoformat(),
                             "count": len(fresh), "status": "ok"})
    return (f"✅ {day} {CONFIG['slots'][slot]['label']} 已发布：新内容 {len(fresh)} 条"
            f"（重复跳过 {len(items) - len(fresh)} 条），截止提醒 {len(reminders)} 条，"
            f"技术关键词 {'3 个（' + kw['theme'] + '）' if kw else '无'}{note_kw}"
            + (f"\n　{note_deliver}" if note_deliver else ""))


def publish_learn(branch: str, state: dict, store, dry_run: bool) -> str:
    data = json.loads(git("show", f"origin/{branch}:inbox/learn.json"))  # 只当作数据读取
    L = validate_learn(data, strict=False)
    day = batch_day(data)

    known = {it["id"] for it in state["items"]}
    news = []
    for it in L["news"]:
        e = enrich(it, day, "learn")
        if e["id"] not in known:
            known.add(e["id"])
            news.append(e)

    have = {q["id"] for q in state["quiz"]}
    new_q = [q for q in L["quiz"] if q["id"] not in have]
    by_topic: dict[str, list] = {}
    for q in new_q:
        by_topic.setdefault(q["topic"], []).append({**q, "date": day.isoformat()})

    topic_of = {q["id"]: q["topic"] for q in state["quiz"]}
    fixed = 0
    for f in L["fixes"]:
        topic = topic_of.get(f["id"])
        if not topic:
            continue
        rep = {**f["replacement"], "date": day.isoformat()} if f["replacement"] else None
        if not dry_run:
            store.fix_quiz(topic, f["id"], rep)
        state["quiz"] = [q for q in state["quiz"] if q["id"] != f["id"]]
        if rep:
            state["quiz"].append({"id": rep["id"], "topic": rep["topic"], "track": rep["track"],
                                  "level": rep["level"], "q": rep["q"][:90]})
        fixed += 1

    if not dry_run:
        store.add_items([{**it, "reminded": []} for it in news])
        for topic, qs in by_topic.items():
            store.add_quiz(topic, qs)
        if L["theme"]:
            store.set_theme(day.isoformat(), L["theme"])
        if L["ideas"]:
            store.add_ideas(L["ideas"])
        by_area: dict[str, list] = {}
        for k in L["keywords"]:
            by_area.setdefault(k["area"], []).append({**k, "date": day.isoformat(), "slot": "learn"})
        for area, ks in by_area.items():
            store.add_keywords(area, ks)
        if L["reviewed_reports"]:
            store.mark_reports(L["reviewed_reports"], "done")

    for it in news:
        remember_item(state, it)
    state["quiz"] += [{"id": q["id"], "topic": q["topic"], "track": q["track"], "level": q["level"],
                       "q": q["q"][:90]} for q in new_q]
    if L["theme"]:
        state["themes"].append({"date": day.isoformat(), "title": L["theme"]["title"]})
    for pool, words in L["ideas"].items():
        state["idea_counts"][pool] = state["idea_counts"].get(pool, 0) + len(words)
    state["keywords"] += [{"term": k["term"], "level": k["level"], "area": k["area"],
                           "theme": k.get("theme"), "date": day.isoformat()} for k in L["keywords"]]
    state["reports"] = [r for r in state["reports"] if r["id"] not in set(L["reviewed_reports"])]
    state["batches"].append({"branch": branch, "slot": "learn", "date": day.isoformat(),
                             "count": len(news) + len(new_q), "status": "ok"})
    return (f"📚 {day} 学习内容已写入：分区新闻 {len(news)} 条、新题 {len(new_q)} 道"
            f"（重复跳过 {len(L['quiz']) - len(new_q)}）、修正 {fixed} 道、"
            f"お題 {'「' + L['theme']['title'] + '」' if L['theme'] else '无'}、"
            f"词库 +{sum(len(v) for v in L['ideas'].values())}")


def weekly_digest(state: dict, now: datetime, dry_run: bool) -> str | None:
    conf = CONFIG["weekly_digest"]
    today = now.date()
    if today.weekday() != conf["weekday"] or slot_for(now) != conf["slot"] or state.get("last_weekly") == today.isoformat():
        return None
    start = today - timedelta(days=6)
    week = [it for it in state["items"] if start.isoformat() <= it["date"] <= today.isoformat()
            and it.get("category") not in SECTIONS]
    top = sorted(week, key=lambda x: (-x["importance"], x["date"]))[:5]
    upcoming = sorted((it for it in state["items"] if it.get("deadline")
                       and today.isoformat() <= it["deadline"] <= (today + timedelta(days=14)).isoformat()),
                      key=lambda x: x["deadline"])
    if not top and not upcoming:
        return None
    embeds = []
    if top:
        lines = [f"{i}. {'★' * it['importance']} **[{md(it['title'])}]({it['url']})**\n└ {md((it.get('note') or '')[:80])}"
                 for i, it in enumerate(top, 1)]
        embeds.append({"title": "🏆 今週のベスト5", "description": "\n".join(lines)[:4000], "color": 0xF1C40F})
    week_kw = [k for k in state["keywords"] if start.isoformat() <= k.get("date", "") <= today.isoformat()]
    if week_kw:
        terms = " / ".join(dict.fromkeys(k["term"] for k in week_kw))
        embeds.append({"title": "🔑 今週の技術キーワード", "description": md(terms)[:1500], "color": 0xF2F56A})
    if upcoming:
        lines = [f"**{it['deadline'][5:].replace('-', '/')}**　[{md(it['title'])}]({it['url']})" for it in upcoming[:10]]
        embeds.append({"title": "📅 これからの締め切り（2週間）", "description": "\n".join(lines)[:2000], "color": 0xE67E22})
    if CONFIG.get("site_url"):
        embeds.append({"description": f"📖 [今週の記事・ドリルをサイトで]({CONFIG['site_url']})", "color": 0x2B2D31})
    post_forum_thread(f"📅 今週のまとめ {start.month}/{start.day}〜{today.month}/{today.day}", embeds, dry_run)
    state["last_weekly"] = today.isoformat()
    return f"📅 已发布每周汇总（精选 {len(top)} 条，截止日期 {len(upcoming)} 条）"


def missing_batch_warnings(state: dict, now: datetime) -> list[str]:
    """发布时间过了 40 分钟还没收到研究结果，就在日志频道提醒一次。"""
    out = []
    today = now.date().isoformat()
    for slot, conf in CONFIG["slots"].items():
        due = now.replace(hour=int(slot), minute=40, second=0, microsecond=0)
        key = f"{today}-{slot}"
        got = any(b["date"] == today and b["slot"] == slot for b in state["batches"])
        if now >= due and not got and key not in state["warned"] and tasks_for(now.date(), slot):
            state["warned"].append(key)
            out.append(f"⚠️ {today} {conf['label']} 这一批还没收到研究结果，研究端可能失败了。"
                       f"请到 https://claude.ai/code/routines 查看运行记录。")
    if LEARN.get("enabled"):
        due = now.replace(hour=LEARN.get("hour", 7) + 2, minute=30, second=0, microsecond=0)
        key = f"{today}-learn"
        got = any(b["date"] == today and b["slot"] == "learn" for b in state["batches"])
        if now >= due and not got and key not in state["warned"]:
            state["warned"].append(key)
            out.append(f"⚠️ {today} 的学习内容（题目・お題・分区新闻）还没收到，夜间任务可能失败了。")
    return out


def cmd_publish_pending(args) -> int:
    from store import open_store

    now = now_jst()
    state = load_state()
    store = None if args.dry_run else open_store()
    notes, failed = [], False

    for prefix, fn in ((INBOX_PREFIX, publish_batch), (LEARN_PREFIX, publish_learn)):
        for branch in pending_branches(prefix):
            try:
                notes.append(fn(branch, state, store, args.dry_run))
            except Exception as e:
                failed = True
                state["batches"].append({"branch": branch, "slot": "?", "date": now.date().isoformat(),
                                         "count": 0, "status": f"error: {str(e)[:200]}"})
                notes.append(f"❌ {branch} 发布失败：{str(e)[:500]}")
            if not args.dry_run:
                git("push", "origin", "--delete", branch, check=False)

    digest = weekly_digest(state, now, args.dry_run)
    if digest:
        notes.append(digest)
    try:
        daily = daily_mail(state, store, now, args.dry_run)
    except Exception as e:
        daily = f"⚠️ 1 日まとめメールでエラー：{str(e)[:150]}"
    if daily:
        notes.append(daily)
    notes += missing_batch_warnings(state, now)

    if store is not None:
        requests_ = store.new_access_requests()
        if requests_:
            names = "\n".join(f"・{u.get('name', '?')}（{str(u.get('note', ''))[:50]}）" for u in requests_)
            notes.append(f"🙋 有 {len(requests_)} 个新的浏览申请\n{names}\n"
                         f"去网站的「⚙️ 管理」批准：{CONFIG.get('site_url', '')}")
            store.mark_requests_notified([u["uid"] for u in requests_])
        reports = store.new_reports()
        if reports:
            have = {r["id"] for r in state["reports"]}
            state["reports"] += [r for r in reports if r["id"] not in have]
            store.mark_reports([r["id"] for r in reports], "queued")
            notes.append(f"🚩 有 {len(reports)} 个题目被回报有问题，下次学习任务会核实修正")
        contacts = store.new_contacts()
        if contacts:
            kinds = {"takedown": "掲載の取り下げ", "fix": "内容の訂正", "other": "その他"}
            lines = "\n".join(f"・【{kinds.get(c.get('kind'), '?')}】{str(c.get('url') or '（URLなし）')[:200]}\n"
                              f"　{str(c.get('message', ''))[:300]}" + (f"\n　連絡先：{str(c.get('contact'))[:100]}" if c.get("contact") else "")
                              for c in contacts)
            log(f"📮 有 {len(contacts)} 条来自网站表单的请求（请尽快处理，删除请求优先）\n{lines}\n"
                f"在网站的「管理」页可以查看全文：{CONFIG.get('site_url', '')}", args.dry_run)   # 他の通知と混ざって切れないよう単独で送る
            store.mark_contacts([c["id"] for c in contacts])
        store.save_meta({
            "updated": now.isoformat(timespec="minutes"),
            "keywords": CONFIG.get("keywords", []),
            "categories": [{"id": t["id"], "name": t["name"], "emoji": t["emoji"], "color": t["color"],
                            "section": t.get("section")} for t in CONFIG["tasks"]],
        })
        store.flush()

    if notes:
        log("\n".join(notes), args.dry_run)
    if not args.dry_run:
        save_state(state)
    return 1 if failed else 0


# ======================================================================
# 预览：给管理员确认效果的 HTML
# ======================================================================

PAGE_CSS = """body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.7 "Noto Sans JP","Yu Gothic UI",system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:16px} h1{font-size:18px} h2{font-size:16px;margin-top:32px;color:#fff}
a{color:#00a8fc;text-decoration:none} .thread{background:#2b2d31;border-radius:8px;padding:16px}
.tt{font-size:17px;font-weight:700;color:#fff;margin-bottom:12px}
.embed{background:#232428;border-left:4px solid;border-radius:4px;padding:10px 14px;margin:8px 0}
.et{font-weight:700;color:#fff;margin-bottom:4px} .ed{font-size:14px} .ef{font-size:12px;color:#949ba4;margin-top:6px}
code,pre{background:#1e1f22;border-radius:4px;font-size:12px} pre{padding:8px;white-space:pre-wrap}
.card{background:#2b2d31;border-radius:8px;padding:12px 16px;margin:10px 0} .card h3{margin:4px 0;font-size:16px}
.meta{font-size:12px;color:#949ba4} .ok{color:#3ee08f;font-weight:700} pre.rep{white-space:pre-wrap}
ol.pts{margin:10px 0;padding-left:1.4em;color:#f2f56a} ol.pts li span,ol.pts li{color:#dbdee1}
p.para{line-height:1.9;margin:8px 0} dl.terms{background:#1e1f22;border-radius:6px;padding:8px 12px}
dl.terms dt{font-weight:700;color:#ffb874} dl.terms dd{margin:2px 0 8px}"""


def _md_to_html(text: str) -> str:
    import html as H

    s = H.escape(text, quote=False)
    s = re.sub(r"```(\w*)\n(.*?)\n```", lambda m: f"<pre>{m.group(2)}</pre>", s, flags=re.S)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank">\1</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\\([*_~`|>\\])", r"\1", s)
    return s.replace("\n", "<br>")


def load_branch_json(source: str, filename: str) -> dict:
    if Path(source).exists():
        return json.loads(Path(source).read_text(encoding="utf-8"))
    branch = source.removeprefix("origin/")
    git("fetch", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}")
    return json.loads(git("show", f"origin/{branch}:inbox/{filename}"))


def write_page(name: str, body: str) -> Path:
    out = ROOT / "out" / name
    out.parent.mkdir(exist_ok=True)
    out.write_text(f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" '
                   f'content="width=device-width, initial-scale=1"><title>HIKARI NEWS 预览</title><style>{PAGE_CSS}</style>'
                   f'</head><body><div class="wrap">{body}</div></body></html>', encoding="utf-8")
    print(f"✅ 预览已生成：{out}")
    return out


def _writeup_html(it: dict) -> str:
    """预览页：要点・分段解说・术语（网站上的样子的简化版）。"""
    import html as H

    out = ""
    if it.get("points"):
        out += "<ol class='pts'>" + "".join(f"<li>{H.escape(p)}</li>" for p in it["points"]) + "</ol>"
    for para in (it.get("detail") or "").split("\n\n"):
        if para.strip():
            out += "<p class='para'>" + H.escape(para).replace("\n", "<br>") + "</p>"
    if it.get("terms"):
        out += "<dl class='terms'>" + "".join(f"<dt>{H.escape(t['term'])}</dt><dd>{H.escape(t['explain'])}</dd>" for t in it["terms"]) + "</dl>"
    return out


def cmd_preview(args) -> int:
    import html as H

    batch = load_branch_json(args.source, "batch.json")
    items = validate(batch, strict=False)
    slot = batch.get("slot") or args.slot or slot_for(now_jst())
    day = batch_day(batch)
    kw = validate_keywords(batch, required=False)
    track = KW_TRACKS.get(slot)
    known = {it["id"] for it in load_state()["items"]}
    rich = [{**enrich(it, day, slot), "dup": item_id(it["url"]) in known} for it in items]
    cats = [t["id"] for t in CONFIG["tasks"] if any(it["category"] == t["id"] for it in rich)]
    embeds = build_batch_embeds([it for it in rich if not it["dup"]], [], kw, track["name"] if track else "")
    emb_html = "".join(
        f'<div class="embed" style="border-color:#{e.get("color", 0x2B2D31):06x}">'
        + (f'<div class="et">{H.escape(e["title"])}</div>' if e.get("title") else "")
        + f'<div class="ed">{_md_to_html(e.get("description", ""))}</div>'
        + (f'<div class="ef">{H.escape(e["footer"]["text"])}</div>' if e.get("footer") else "") + "</div>"
        for e in embeds)
    rows = "".join(
        f'<div class="card"><div class="meta">{H.escape(it["category_name"])} ・ {"★" * it["importance"]} ・ '
        f'{H.escape(it["source"])}{" ・ ⚠️ 已推送过" if it["dup"] else ""}</div>'
        f'<h3><a href="{H.escape(it["url"])}" target="_blank">{H.escape(it["title"])}</a></h3>'
        f'<p>{H.escape(it["summary"])}</p><p class="meta">💡 {H.escape(it["note"])}</p>{_writeup_html(it)}</div>' for it in rich)
    body = (f"<h1>HIKARI NEWS 预览（没有发送到 Discord）</h1><p>{day} ／ slot {H.escape(str(slot))} ／ {len(rich)} 条</p>"
            f"<h2>① Discord 论坛帖子的样子</h2><div class='thread'><div class='tt'>{H.escape(thread_title(day, slot, cats))}</div>{emb_html}</div>"
            f"<h2>② 全文</h2>{rows}<h2>③ AI 的研究报告</h2><pre class='rep'>{H.escape(batch.get('report') or '（なし）')}</pre>")
    write_page(f"preview-{day}-{slot}.html", body)
    return 0


def cmd_preview_learn(args) -> int:
    import html as H

    data = load_branch_json(args.source, "learn.json")
    L = validate_learn(data, strict=False)
    parts = [f"<h1>学习内容预览（没有写入网站）</h1><p>{H.escape(str(data.get('date', '')))}</p>"]
    if L["theme"]:
        t = L["theme"]
        parts.append(f"<h2>今日のお題</h2><div class='card'><h3>{H.escape(t['title'])}</h3><ul>"
                     + "".join(f"<li>{H.escape(a)}</li>" for a in t["angles"]) + f"</ul><p class='meta'>{H.escape(t['note'] or '')}</p></div>")
    if L["news"]:
        parts.append("<h2>分区新闻</h2>" + "".join(
            f"<div class='card'><div class='meta'>{H.escape(it['category'])}</div><h3><a href='{H.escape(it['url'])}'>{H.escape(it['title'])}</a></h3>"
            f"<p>{H.escape(it['summary'])}</p><p class='meta'>💡 {H.escape(it['note'])}</p>{_writeup_html(it)}</div>" for it in L["news"]))
    if L["quiz"]:
        parts.append(f"<h2>题目（{len(L['quiz'])}）</h2>" + "".join(
            f"<div class='card'><div class='meta'>{q['track']} / {q['topic']} / {q['level']}</div><h3>{H.escape(q['q'])}</h3>"
            + (f"<pre>{H.escape(q['code'])}</pre>" if q["code"] else "")
            + "<ol>" + "".join(f"<li class='{'ok' if i == q['answer'] else ''}'>{H.escape(c)}</li>" for i, c in enumerate(q["choices"])) + "</ol>"
            + f"<p>{H.escape(q['explain'])}</p>" + (f"<a href='{H.escape(q['link'])}'>📖</a>" if q["link"] else "") + "</div>" for q in L["quiz"]))
    if L["ideas"]:
        parts.append("<h2>词库追加</h2>" + "".join(f"<p><b>{p}</b>：{H.escape('、'.join(w))}</p>" for p, w in L["ideas"].items()))
    if L["fixes"]:
        parts.append("<h2>修正</h2>" + "".join(f"<p>{f['id']}：{f['action']}</p>" for f in L["fixes"]))
    parts.append(f"<h2>AI 的报告</h2><pre class='rep'>{H.escape(L['report'] or '（なし）')}</pre>")
    write_page(f"preview-learn-{data.get('date', 'x')}.html", "".join(parts))
    return 0


# ======================================================================

# ======================================================================
# 发布检查（定时任务 PUBLISH_CHECK.md 用）：有没有交了稿、却还没发布的分支
# ======================================================================

def _published_today() -> list[dict]:
    """main 上的 state/published.json 里，今天的发布记录（发布端每次运行后会更新）。"""
    git("fetch", "origin", "main")
    try:
        state = json.loads(git("show", "origin/main:state/published.json"))
    except Exception:
        return []
    today = now_jst().date().isoformat()
    return [b for b in state.get("batches", []) if b.get("date") == today]


def _batch_label(b: dict) -> str:
    slot = str(b.get("slot"))
    return "学习内容" if slot == "learn" else CONFIG["slots"].get(slot, {}).get("label", slot)


def cmd_publish_status(args) -> int:
    now = now_jst()
    pending = pending_branches(INBOX_PREFIX) + pending_branches(LEARN_PREFIX)
    done = _published_today()
    print(f"# 发布状态（{now:%Y-%m-%d %H:%M} 日本时间）\n\n## 今天已经发布的批次")
    for b in done:
        ok = str(b.get("status", "")).startswith("ok")
        print(f"- {'✅' if ok else '❌'} {_batch_label(b)}：{b.get('count', 0)} 条" + ("" if ok else f"（{b.get('status')}）"))
    if not done:
        print("- （还没有）")
    print("\n## 已交稿、还没发布的分支")
    print("\n".join(f"- {br}" for br in pending) or "- （没有）")
    late = [CONFIG["slots"][s]["label"] for s in CONFIG["slots"]
            if now.hour >= int(s) and tasks_for(now.date(), s) and not any(str(b.get("slot")) == s for b in done)
            and not any(f"-{s}-" in br for br in pending)]
    if late:
        print(f"\n⚠️ 研究端还没交稿的批次：{'、'.join(late)}（这不是发布的问题，报告里写上即可）")
    print(f"\nNEED_PUBLISH={'yes' if pending else 'no'}")
    return 0


def cmd_wait_published(args) -> int:
    """触发发布之后，等到待发布的分支都被处理掉（发布端处理完会删除分支），再看有没有失败。"""
    watch = set(pending_branches(INBOX_PREFIX) + pending_branches(LEARN_PREFIX))
    if not watch:
        print("✅ 没有待发布的分支（已经发布完了）")
        return 0
    print(f"等待发布：{', '.join(sorted(watch))}（最多 {args.timeout} 秒）", flush=True)
    deadline = time.time() + args.timeout
    while True:
        left = watch & set(pending_branches(INBOX_PREFIX) + pending_branches(LEARN_PREFIX))
        if not left:
            break
        if time.time() >= deadline:
            print(f"⏳ 超时：还没被处理的分支：{', '.join(sorted(left))}")
            return 1
        time.sleep(15)
    done = {b.get("branch"): b for b in _published_today()}
    failed = [done[br] for br in watch if br in done and not str(done[br].get("status", "")).startswith("ok")]
    for br in sorted(watch):
        b = done.get(br)
        if b:
            ok = str(b.get("status", "")).startswith("ok")
            print(f"{'✅' if ok else '❌'} {br}：{_batch_label(b)} {b.get('count', 0)} 条" + ("" if ok else f"\n   错误：{b.get('status')}"))
        else:
            print(f"✅ {br}：已处理（记录稍后会出现在 main 上）")
    return 2 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="HIKARI NEWS 工具")
    parser.add_argument("--slot", choices=list(CONFIG["slots"]), help="默认按日本时间自动判断")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("context")
    sub.add_parser("feeds").add_argument("--learn", action="store_true", help="学习任务用（分区新闻的候选）")
    sub.add_parser("community")
    sub.add_parser("check").add_argument("file")
    p = sub.add_parser("submit")
    p.add_argument("file")
    p.add_argument("--preview", action="store_true", help="交到预览分支，不发到 Discord")
    sub.add_parser("learn-context")
    sub.add_parser("learn-check").add_argument("file")
    p = sub.add_parser("learn-submit")
    p.add_argument("file")
    p.add_argument("--preview", action="store_true", help="交到预览分支，不写入网站")
    sub.add_parser("publish-pending").add_argument("--dry-run", action="store_true")
    sub.add_parser("preview").add_argument("source", help="预览分支名（claude/preview-…）或结果 JSON 文件")
    sub.add_parser("preview-learn").add_argument("source", help="学习内容的预览分支或 JSON 文件")
    sub.add_parser("publish-status", help="发布检查：今天的发布记录和待发布的分支")
    sub.add_parser("wait-published", help="触发发布后，等待并确认分支被处理").add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    return {"context": cmd_context, "feeds": cmd_feeds, "community": cmd_community, "check": cmd_check,
            "submit": cmd_submit, "learn-context": cmd_learn_context, "learn-check": cmd_learn_check,
            "learn-submit": cmd_learn_submit, "publish-pending": cmd_publish_pending,
            "preview": cmd_preview, "preview-learn": cmd_preview_learn,
            "publish-status": cmd_publish_status, "wait-published": cmd_wait_published}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
