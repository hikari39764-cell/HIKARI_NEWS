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
from urllib.parse import quote, urlsplit, urlunsplit

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
                 "keywords": [], "quiz": [], "themes": [], "reports": [], "idea_counts": {},
                 "specials": [], "special_snap": {}}


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
    state["specials"] = state["specials"][-400:]
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


def email_for_day(day: date, items: list[dict], kws: list[dict], special: dict | None = None) -> tuple[str, str]:
    """1 日 1 回まとめ（22 時ごろ）のメール。"""
    title = f"{day.month}/{day.day}（{WEEKDAYS_JA[day.weekday()]}）のまとめ"
    inner, text = "", [title, ""]
    if special:
        link = site_link(f"#/special?d={day.isoformat()}")
        inner += (f"<div style=\"margin-top:16px;padding:14px 16px;background:#efe9ff;border-radius:12px\">"
                  f"<div style=\"font-size:12px;font-weight:800;color:#7a4dff\">🌙 19:00 特集・今夜の1本</div>"
                  f"<div style=\"font-size:16px;font-weight:900;margin-top:2px\">{_h(special.get('title'))}</div>"
                  f"<div style=\"font-size:14px\">{_h(special.get('hook'))}</div>"
                  f"<div style=\"font-size:13px;color:#5c6070;margin-top:4px\">📈 急上昇：{_h(' / '.join(x.get('title', '') for x in special.get('top5', [])))}</div>"
                  f"<a href=\"{_h(link)}\" style=\"font-size:13px;color:#b06d00;font-weight:700\">特集を読む →</a></div>")
        text += [f"🌙 19:00 特集：{special.get('title')}", str(special.get('hook') or ''), link, ""]
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


def _relay_not_json(r) -> str:
    """Apps Script から JSON 以外（ログイン画面・エラー画面）が返ってきたとき、原因を推測して書く。
    URL にはデプロイ ID が入っているので、ログにはホスト名だけを出す。"""
    import html as H

    host = urlsplit(r.url).netloc
    body = r.text[:30000]
    low = body.lower()
    m = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
    title = re.sub(r"\s+", " ", H.unescape(m.group(1))).strip()[:80] if m else ""
    if host.startswith("accounts.google.") or "servicelogin" in low or "sign in" in title.lower() or "ログイン" in title:
        why = ("返回的是 Google 登录页 → 部署的「アクセスできるユーザー」没有选「全員」，"
               "或者 MAIL_RELAY_URL 用的是以 /dev 结尾的测试网址（要用 /exec 结尾的「ウェブアプリ URL」）")
    elif "script function not found" in low or "関数が見つかりません" in body:
        why = "找不到 doPost → 粘贴代码之后没有用「新バージョン」重新部署"
    elif "authorization is required" in low or "承認が必要" in body or "許可が必要" in body:
        why = "还没有授权 → 在 Apps Script 编辑器里运行一次 test，允许发送邮件的权限"
    elif r.status_code == 404:
        why = "网址找不到（404）→ 确认 MAIL_RELAY_URL 是「ウェブアプリ URL」（https://script.google.com/macros/s/…/exec）"
    else:
        why = "Apps Script 的回复不是 JSON"
    return f"HTTP {r.status_code}・{host}" + (f"・「{title}」" if title else "") + f" → {why}"


def relay_call(url: str, token: str, payload: dict) -> tuple[dict | None, str]:
    """Apps Script（tools/mail_relay.gs）にデータを送る。(返事の JSON, エラーの説明) を返す。"""
    try:
        import requests
        r = requests.post(url.strip(), json={"token": token.strip(), **payload}, timeout=90)
    except Exception as e:
        return None, f"Apps Script に接続できない：{str(e)[:150]}"
    try:
        data = r.json()
    except ValueError:
        return None, _relay_not_json(r)
    if not isinstance(data, dict) or not data.get("ok"):
        err = str(data.get("error") if isinstance(data, dict) else data)[:150]
        if err == "unauthorized":
            err += " → Apps Script 的脚本属性 TOKEN 和 GitHub Secrets 的 MAIL_RELAY_TOKEN 不一致（或 TOKEN 不到 20 个字符）"
        return None, f"Apps Script：{err}"
    return data, ""


def send_via_relay(url: str, token: str, to_list: list[str], subject: str, html: str, text: str) -> str:
    """Google Apps Script 経由で送る。送信元の Gmail で 1 人ずつ送られる。"""
    data, err = relay_call(url, token, {"to": to_list, "subject": subject, "html": html, "text": text})
    if data is None:
        return f"⚠️ メールを送れませんでした（{err}）"
    errs = data.get("errors") or []
    return (f"メール {data.get('sent', 0)}/{len(to_list)} 人（今日あと {data.get('remaining', '?')} 通まで）"
            + (f"（失敗：{'; '.join(map(str, errs))[:300]}）" if errs else ""))


def cmd_mail_check(args) -> int:
    """邮件中继（Apps Script）的检查：收件人为空，所以不会发出任何邮件，也不发 Discord、不写网站。
    结果用 GitHub Actions 的注释（::notice:: / ::error::）显示在运行页面上。"""
    url = (os.environ.get("MAIL_RELAY_URL") or "").strip()
    token = (os.environ.get("MAIL_RELAY_TOKEN") or "").strip()
    if not url or not token:
        missing = "、".join(n for n, v in (("MAIL_RELAY_URL", url), ("MAIL_RELAY_TOKEN", token)) if not v)
        print(f"::error title=邮件中继::GitHub Secrets 里没有 {missing}")
        return 1
    p = urlsplit(url)
    if p.netloc != "script.google.com" or not p.path.endswith("/exec"):
        end = ("/exec" if p.path.endswith("/exec") else "/dev（测试用网址）" if p.path.endswith("/dev") else "不是 /exec")
        print(f"::warning title=邮件中继::MAIL_RELAY_URL 看起来不是 Apps Script 的「ウェブアプリ URL」"
              f"（应该是 https://script.google.com/macros/s/…/exec；现在的主机是 {p.netloc or '?'}，结尾 {end}）")
    data, err = relay_call(url, token, {"to": [], "subject": "check", "html": "", "text": ""})
    if data is None:
        print(f"::error title=邮件中继::{err}")
        return 1
    print(f"::notice title=邮件中继::✅ 设置正确，可以发邮件（今天还能发 {data.get('remaining', '?')} 封）")
    return 0


def mask_emails(s: str) -> str:
    """公开仓库的 Actions 日志谁都能看，所以邮件地址不写进日志。"""
    return re.sub(r"[^\s@<>()（）「」,;:：]+@[^\s@<>()（）「」,;:：]+", "（地址已隐藏）", s)


def cmd_mail_resend(args) -> int:
    """把上一次的新闻（最新的 10:00 / 17:00 / 22:00 批次）重新发给开启了邮件的人（不分「每次」「每天一次」）。
    只发邮件：不发 Discord、不改网站和发布记录。"""
    from store import open_store

    state = load_state()
    last = next((b for b in reversed(state["batches"]) if str(b.get("slot")) in CONFIG["slots"]
                 and str(b.get("status", "")).startswith("ok") and b.get("count")), None)
    if not last:
        print("::error title=重发::发布记录里没有找到上一次的新闻批次")
        return 1
    day, slot = str(last["date"]), str(last["slot"])
    ids = [it["id"] for it in state["items"] if it.get("date") == day and str(it.get("slot")) == slot]
    store = open_store()
    items = [it for it in store.items_by_ids(ids) if it.get("title") and it.get("url")]
    for it in items:
        it.setdefault("importance", 3)
        it.setdefault("category", "")
    track = KW_TRACKS.get(slot)
    ks = store.keywords_for(track["area"], day, slot) if track else []
    kw = {"theme": ks[0].get("theme") or "", "items": ks} if ks else None
    if not items and not kw:
        print(f"::error title=重发::在网站的数据库里找不到 {day} {slot}:00 这一批的内容")
        return 1
    to = sorted({s["email"] for s in store.subscribers() if s.get("email_on") and s.get("email")})
    if not to:
        print("::warning title=重发::现在没有人开启邮件，所以没有发送")
        return 0
    cats = [t["id"] for t in CONFIG["tasks"] if any(it.get("category") == t["id"] for it in items)]
    title = "【再送】" + thread_title(date.fromisoformat(day), slot, cats)
    html, text = email_for_batch(title, items, kw, track["name"] if track else "", [])
    res = mask_emails(send_emails(to, title, html, text, args.dry_run))
    ok = not res.startswith("⚠️")
    print(f"::{'notice' if ok else 'error'} title=重发::{day} {slot}:00 这一批（新闻 {len(items)} 条）→ {res}")
    return 0 if ok else 1


def send_emails(to_list: list[str], subject: str, html: str, text: str, dry_run: bool) -> str:
    """1 人ずつ送る（宛先はお互いに見えない）。Apps Script の中継があればそれを、なければ Gmail（アプリ パスワード）を使う。"""
    if not to_list:
        return ""
    if dry_run:
        return f"（dry-run）メール {len(to_list)} 人：{subject}"
    relay, token = (os.environ.get("MAIL_RELAY_URL") or "").strip(), (os.environ.get("MAIL_RELAY_TOKEN") or "").strip()
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
    special = next((s for s in state.get("specials", []) if s.get("date") == today), None)
    if not to or not (items or kws or special):
        return None
    html, text = email_for_day(now.date(), items, kws, special)
    return "📮 1 日まとめメール：" + send_emails(to, f"📰 HIKARI NEWS {now.month}/{now.day} のまとめ", html, text, dry_run)


def log(text: str, dry_run: bool, private: bool = False) -> None:
    """发给管理员日志频道（没有设置的话只打印出来）。
    仓库是公开的，Actions 日志谁都能看：打印时隐藏邮件地址；private 的内容（表单的留言等）只打印第一行。"""
    webhook = os.environ.get("DISCORD_LOG_WEBHOOK")
    shown = text.split("\n", 1)[0] + "（详细内容只发到日志频道）" if private and webhook and not dry_run else text
    print(f"[bot-log] {mask_emails(shown)}")
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
    sp = CONFIG.get("special", {})
    if sp.get("live"):
        due = now.replace(hour=int(sp.get("hour", 19)), minute=40, second=0, microsecond=0)
        key = f"{today}-special"
        got = any(b["date"] == today and b["slot"] == "special" for b in state["batches"])
        if now >= due and not got and key not in state["warned"]:
            state["warned"].append(key)
            out.append(f"⚠️ {today} 的 19:00 特集还没收到，特集任务可能失败了。请到 https://claude.ai/code/routines 查看运行记录。")
    return out


EARLY_WINDOW = timedelta(minutes=10)   # 公开时间前多少分钟以内的稿，算「该发了」（发布端会等到整点再发）


def due_at(branch: str) -> datetime | None:
    """分支名里的日期和时段 → 这份稿的公开时间（日本时间）。
    claude/inbox-20261115-10-091624 → 2026-11-15 10:00；claude/learn-20261115-learn-063712 → 7:00。"""
    m = re.search(r"-(\d{8})-([a-z0-9]+)-\d{6}$", branch)
    if not m:
        return None
    tag = m.group(2)
    if tag == "learn":
        hour = int(LEARN.get("hour", 7))
    elif tag == "special":
        hour = int(CONFIG.get("special", {}).get("hour", 19))
    elif tag in CONFIG["slots"]:
        hour = int(tag)
    else:
        return None
    return datetime.strptime(m.group(1), "%Y%m%d").replace(hour=hour, tzinfo=JST)


def is_ready(branch: str, now: datetime) -> bool:
    """已经到了（或 10 分钟以内就到）公开时间的稿。更早交的稿留着，等整点前的发布任务。"""
    due = due_at(branch)
    return due is None or due - now <= EARLY_WINDOW


def cmd_publish_pending(args) -> int:
    from store import open_store

    now = now_jst()
    state = load_state()
    store = None if args.dry_run else open_store()
    notes, failed = [], False

    jobs = [(b, fn) for prefix, fn in ((INBOX_PREFIX, publish_batch), (LEARN_PREFIX, publish_learn),
                                       (SPECIAL_PREFIX, publish_special))
            for b in pending_branches(prefix)]
    jobs.sort(key=lambda j: due_at(j[0]) or now)   # 公开时间早的先发
    for branch, fn in jobs:
        due = due_at(branch)
        if due and not args.now:
            gap = (due - now_jst()).total_seconds()
            if gap > EARLY_WINDOW.total_seconds():
                print(f"⏰ {branch}：{due:%m/%d %H:%M} 才公开，现在还早，先留着", flush=True)
                continue
            if gap > 0:
                # 整点前就被触发的话（发布任务在 :56 触发），准备好之后等到整点，准时发出去
                print(f"⏰ {branch}：等到 {due:%H:%M:%S} 准时发布（还有 {gap:.0f} 秒）", flush=True)
                if not args.dry_run:
                    time.sleep(gap)
        try:
            notes.append(fn(branch, state, store, args.dry_run))
        except Exception as e:
            failed = True
            state["batches"].append({"branch": branch, "slot": "?", "date": now_jst().date().isoformat(),
                                     "count": 0, "status": f"error: {str(e)[:200]}"})
            notes.append(f"❌ {branch} 发布失败：{str(e)[:500]}")
        if not args.dry_run:
            git("push", "origin", "--delete", branch, check=False)

    now = now_jst()   # 等过整点的话，后面的判断（每日邮件、漏稿提醒）用发完之后的时间
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
                f"在网站的「管理」页可以查看全文：{CONFIG.get('site_url', '')}", args.dry_run, private=True)   # 他の通知と混ざって切れないよう単独で送る
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
# 19:00 特集：今夜の 1 本（ゲーム紹介）＋ 急上昇 TOP5・期待の新星 ＋ 今日の話題
#   研究端：special-context（Steam・SteamCharts の数値）→ out/special.json → special-check → special-submit
#   発布端：publish_special（Discord は短い版、網站は全文、受け取り設定の人へも配信）
# ======================================================================

SPECIAL = CONFIG.get("special", {})
SPECIAL_PREFIX = "claude/special-"
SPECIAL_CTX = ROOT / "out" / "special_ctx.json"
HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; news-research-bot/1.0)"}
SOURCE_KINDS = ("official", "store", "interview", "talk", "postmortem", "review", "article", "video")
MAKER_KINDS = ("interview", "talk", "postmortem")
RANK_TAGS = ("急上昇", "新作", "復活", "話題", "セール", "大型更新")
WATCH_STATUS = ("近日発売", "新作", "早期アクセス", "体験版あり", "その他")


def _http_json(url: str, tries: int = 2):
    import urllib.request

    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:   # noqa: BLE001
            last = e
            time.sleep(1.5)
    raise RuntimeError(f"{urlsplit(url).netloc}：{str(last)[:120]}")


def _steam_search(filt: str, count: int = 25) -> list[dict]:
    """Steam ストアの一覧（売上上位・人気の新作・近日発売の人気作）。appid は画像の URL から取る。"""
    data = _http_json(f"https://store.steampowered.com/search/results/?query&start=0&count={count}"
                      f"&filter={filt}&cc=jp&l=japanese&json=1")
    out = []
    for i, it in enumerate(data.get("items") or [], 1):
        m = re.search(r"/apps/(\d+)/", str(it.get("logo") or ""))
        if m:
            out.append({"appid": int(m.group(1)), "name": str(it.get("name") or ""), "pos": i})
    return out


def _steam_items(appids: list[int]) -> dict[int, dict]:
    """名前・開発元・発売日を 50 件ずつまとめて取る（Steam ストアの公開 API。鍵は不要）。"""
    info: dict[int, dict] = {}
    for i in range(0, len(appids), 50):
        q = json.dumps({"ids": [{"appid": a} for a in appids[i:i + 50]],
                        "context": {"language": "japanese", "country_code": "JP"},
                        "data_request": {"include_basic_info": True, "include_release": True}}, separators=(",", ":"))
        data = _http_json("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=" + quote(q))
        for it in data.get("response", {}).get("store_items", []):
            rel = it.get("release") or {}
            ts = rel.get("steam_release_date") or rel.get("original_release_date")
            info[int(it["appid"])] = {
                "name": str(it.get("name") or ""), "type": it.get("type"),
                "dev": ", ".join(d.get("name", "") for d in (it.get("basic_info") or {}).get("developers", []))[:80],
                "release": datetime.fromtimestamp(int(ts), JST).date().isoformat() if ts else None,
                "coming_soon": bool(rel.get("is_coming_soon")),
            }
        time.sleep(.3)
    return info


def _charts(appid: int) -> dict | None:
    """SteamCharts の 1 時間ごとの同時接続数から、24 時間ピークと伸び率を出す。
    d1 = 直近 24 時間のピーク ÷ その前の 24 時間のピーク、w1 = 直近 7 日の平均 ÷ その前の 7 日の平均。"""
    try:
        pts = [p for p in _http_json(f"https://steamcharts.com/app/{appid}/chart-data.json", tries=1)
               if isinstance(p, list) and len(p) == 2 and p[1] is not None]
    except Exception:   # noqa: BLE001
        return None
    if not pts:
        return None
    now_ms, day = pts[-1][0], 24 * 3600 * 1000

    def win(a: int, b: int) -> list[float]:
        return [n for t, n in pts if now_ms - b * day < t <= now_ms - a * day]

    l24, p24, l7, p7 = win(0, 1), win(1, 2), win(0, 7), win(7, 14)
    peak = max(l24) if l24 else None
    d1 = peak / max(p24) - 1 if peak and p24 and max(p24) > 0 else None
    w1 = (sum(l7) / len(l7)) / (sum(p7) / len(p7)) - 1 if l7 and p7 and sum(p7) > 0 else None
    return {"peak24": int(peak) if peak else None, "d1": d1, "w1": w1}


def _momentum(r: dict) -> float | None:
    """伸びの強さ。小さすぎるゲーム（24 時間ピークが min_peak 未満）は数に入れない。"""
    if not r.get("peak24") or r["peak24"] < SPECIAL.get("min_peak", 2000):
        return None
    w1, d1 = r.get("w1"), r.get("d1")
    if w1 is None and d1 is None:
        return None
    cap = lambda v: max(-.9, min(v, 3.0)) if v is not None else 0.0   # noqa: E731
    score = (.6 * cap(w1) + .4 * cap(d1)) if w1 is not None else cap(d1)
    if r.get("top_rank") and r.get("last_week_rank"):   # 同時接続ランキングで大きく順位を上げた
        score += max(0, min(r["last_week_rank"] - r["top_rank"], 50)) / 100
    return round(score, 3)


def steam_signals() -> dict:
    """特集の「急上昇」「期待の新星」の材料：Steam 公式の一覧と SteamCharts の推移。失敗しても途中までの結果を返す。"""
    out = {"fetched": now_jst().isoformat(timespec="minutes"), "rows": [], "upcoming": [],
           "topsellers": [], "popularnew": [], "errors": []}
    try:
        most = _http_json("https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/")["response"]["ranks"]
    except Exception as e:   # noqa: BLE001
        most = []
        out["errors"].append(f"同時接続ランキング：{e}")
    for key, filt in (("topsellers", "topsellers"), ("popularnew", "popularnew"), ("upcoming", "popularcomingsoon")):
        try:
            out[key] = _steam_search(filt)
        except Exception as e:   # noqa: BLE001
            out["errors"].append(f"{filt}：{e}")
        time.sleep(.3)
    top = {int(m["appid"]): m for m in most[:100]}
    cand = list(dict.fromkeys([*top, *(x["appid"] for x in out["topsellers"]), *(x["appid"] for x in out["popularnew"])]))[:150]
    try:
        info = _steam_items(cand + [x["appid"] for x in out["upcoming"]])
    except Exception as e:   # noqa: BLE001
        info = {}
        out["errors"].append(f"ゲーム情報：{e}")
    for x in out["upcoming"]:
        i = info.get(x["appid"], {})
        x.update({"name": i.get("name") or x["name"], "dev": i.get("dev", ""), "release": i.get("release")})
    names = {x["appid"]: x["name"] for x in out["topsellers"] + out["popularnew"]}
    today, ok, streak = now_jst().date(), 0, 0
    for a in cand:
        i = info.get(a, {})
        if i.get("type") not in (None, 0):   # 0 = ゲーム（ツール・動画などは除く）
            continue
        # SteamCharts が記録していないゲーム（出たばかりの新作など）は 404。続けて 10 回失敗したら止める
        c = _charts(a) if streak < 10 else None
        ok, streak = (ok + 1, 0) if c else (ok, streak + 1)
        m = top.get(a, {})
        lw = m.get("last_week_rank")
        peak = (c or {}).get("peak24") or m.get("peak_in_game")
        now_players = None
        if not peak:   # 推移のデータがない：今の同時接続数だけ Steam 公式から取る
            try:
                now_players = _http_json(f"https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={a}",
                                         tries=1)["response"].get("player_count")
            except Exception:   # noqa: BLE001
                pass
        row = {"appid": a, "name": i.get("name") or names.get(a) or f"app {a}", "dev": i.get("dev", ""),
               "release": i.get("release"), "top_rank": m.get("rank"), "last_week_rank": lw if lw and lw > 0 else None,
               "peak24": peak, "now": now_players, "d1": (c or {}).get("d1"), "w1": (c or {}).get("w1")}
        age = (today - date.fromisoformat(row["release"])).days if row["release"] else None
        row["new"] = age is not None and 0 <= age <= 30
        row["evergreen"] = bool(row["top_rank"] and row["top_rank"] <= 60 and not row["new"]
                                and row["w1"] is not None and abs(row["w1"]) < .12)
        row["score"] = _momentum(row)
        out["rows"].append(row)
        time.sleep(.25)
    if not ok:
        out["errors"].append("SteamCharts に接続できないため、伸び率がありません（今の同時接続数と順位の変化だけで判断する）")
    elif streak >= 10:
        out["errors"].append("SteamCharts が途中から応答しなくなったため、伸び率は一部のゲームだけ")
    out["rows"].sort(key=lambda r: -(r["score"] if r["score"] is not None else -9))
    return out


# ---------------------------------------------------------------- 画像（Steam ストアの公式画像だけ）
STEAM_IMG = re.compile(r"^https://([a-z0-9-]+\.)*(steamstatic\.com|akamaihd\.net)/[^\s\"'<>]+$")


def _img(u) -> str | None:
    """Steam の画像配信サーバーの URL だけを通す（それ以外の画像は使わない）。"""
    return u if isinstance(u, str) and len(u) < 400 and STEAM_IMG.match(u) else None


def _clean_media(m) -> dict | None:
    if not isinstance(m, dict):
        return None
    shots = [{"thumb": _img(s.get("thumb")), "full": _img(s.get("full"))} for s in m.get("shots") or [] if isinstance(s, dict)]
    out = {"header": _img(m.get("header")), "shots": [s for s in shots if s["thumb"] and s["full"]][:6]}
    return out if out["header"] or out["shots"] else None


def steam_media(appid: int, shots: int = 0) -> dict:
    """ストアページの見出し画像・スクリーンショット・日本の価格（Steam ストアの公開 API）。"""
    d = _http_json(f"https://store.steampowered.com/api/appdetails?appids={int(appid)}&cc=jp&l=japanese"
                   f"&filters=basic,screenshots,price_overview")
    data = (d.get(str(appid)) or {}).get("data") or {}
    out = {"header": _img(data.get("header_image"))}
    if shots:
        out["shots"] = [{"thumb": _img(s.get("path_thumbnail")), "full": _img(s.get("path_full"))}
                        for s in (data.get("screenshots") or [])[:shots]]
        out["shots"] = [s for s in out["shots"] if s["thumb"] and s["full"]]
    price = data.get("price_overview") or {}
    if data.get("is_free"):
        out["price"] = "基本プレイ無料"
    elif price.get("final_formatted"):
        out["price"] = str(price["final_formatted"]).replace("¥ ", "¥")[:30]
    return out


def attach_media(sp: dict) -> int:
    """画像は AI に選ばせない：steam_appid から Steam ストアの公式画像を入れる。失敗しても特集は出す。"""
    n = 0
    g = sp["game"]
    if g.get("steam_appid"):
        try:
            m = steam_media(g["steam_appid"], shots=4)
            g["media"] = _clean_media(m)
            if m.get("price"):
                g["price_jp"] = m["price"]
            n += bool(m.get("header")) + len(m.get("shots") or [])
        except Exception:   # noqa: BLE001
            pass
        time.sleep(.3)
    for it in sp["ranking"]["items"] + sp["watch"]:
        if it.get("steam_appid"):
            try:
                it["img"] = steam_media(it["steam_appid"]).get("header")
                n += bool(it["img"])
            except Exception:   # noqa: BLE001
                pass
            time.sleep(.3)
    return n


def _pct(v) -> str:
    return "—" if v is None else f"{'+' if v >= 0 else '−'}{abs(v) * 100:.0f}%"


def _num(n) -> str:
    if not n:
        return "—"
    return f"{n / 10000:.1f}万" if n >= 10000 else f"{n:,}"


def rank_stat(it: dict) -> str:
    """順位の数字（プログラムが Steam・SteamCharts から入れたもの）を 1 行に。"""
    s = it.get("stats") or {}
    parts = []
    if s.get("w1") is not None:
        parts.append(f"7日 {_pct(s['w1'])}")
    if s.get("d1") is not None:
        parts.append(f"24h {_pct(s['d1'])}")
    if s.get("peak24"):
        parts.append(f"ピーク {_num(s['peak24'])}人")
    elif s.get("now"):
        parts.append(f"同時接続 {_num(s['now'])}人")
    return " ・ ".join(parts)


def cmd_special_context(args) -> int:
    now = now_jst()
    state = load_state()
    print(f"# 19:00 特集の材料（{now:%Y-%m-%d %H:%M} JST）\n\n读者：{CONFIG['reader']}\n")
    print("## 已经介绍过的游戏（「今夜の1本」不要重复）")
    print("、".join(s.get("title", "") for s in state.get("specials", [])[-120:]) or "（无）")
    last = (state.get("specials") or [None])[-1]
    if last:
        print(f"\n## 上一次（{last.get('date')}）的急上昇 TOP5（用来判断 ↑↓ NEW，不要连续几天都是同一批）")
        print(" / ".join(x.get("title", "") for x in last.get("top5", [])) or "（无）")

    print("\n正在读取 Steam・SteamCharts 的数据（1〜3 分钟）…", flush=True)
    sig = steam_signals()
    SPECIAL_CTX.parent.mkdir(exist_ok=True)
    SPECIAL_CTX.write_text(json.dumps(sig, ensure_ascii=False), encoding="utf-8")
    for e in sig["errors"]:
        print(f"⚠️ {e}")

    rows = [r for r in sig["rows"] if r["score"] is not None and not r["evergreen"]]
    print("\n## 急上昇の候補（伸び率の高い順。24 时间峰值不到 "
          f"{SPECIAL.get('min_peak', 2000)} 人的、常年霸榜没在涨的已排除）")
    print("appid | 名前 | 7日（本周平均÷上周平均） | 24h（峰值对比） | 24h 峰值 | 同时在线排名（上周→现在） | 发售日 | 标记")
    for r in rows[:30]:
        rk = f"{r['last_week_rank'] or '圏外'}→{r['top_rank']}" if r["top_rank"] else "—"
        print(f"{r['appid']} | {r['name']} | {_pct(r['w1'])} | {_pct(r['d1'])} | {_num(r['peak24'])} | {rk} | "
              f"{r['release'] or '?'} | {'新作' if r['new'] else ''}")
    fresh = [r for r in sig["rows"] if r["new"] and r["score"] is None]
    if fresh:
        print("\n## 发售不到 30 天、还没有涨幅数据的新作（可以作为「新作」放进 TOP5，数字只有当前在线人数）")
        for r in fresh:
            print(f"{r['appid']} | {r['name']} | 发售 {r['release']} | 在线人数 {_num(r['now'] or r['peak24'])} | "
                  f"同时在线排名 {r['top_rank'] or '圏外'}")
    ever = [r["name"] for r in sig["rows"] if r["evergreen"]]
    if ever:
        print(f"\n## 常年霸榜、这周没有明显变化（不要放进 TOP5）\n{'、'.join(ever[:40])}")

    prev = state.get("special_snap") or {}
    old_up = set(prev.get("upcoming", []))
    print("\n## 近日发售的人气作（Steam「近日発売の人気作」排序。「期待の新星」的候选）")
    for x in sig["upcoming"][:20]:
        mark = " 🆕 今天新进榜" if old_up and x["appid"] not in old_up else ""
        print(f"{x['pos']}. {x['name']}（appid {x['appid']}・{x.get('dev') or '?'}・{x.get('release') or '发售日未定'}）{mark}")
    old_ts = set(prev.get("topsellers", []))
    print("\n## Steam 日本区热销榜")
    for x in sig["topsellers"][:15]:
        mark = " 🆕" if old_ts and x["appid"] not in old_ts else ""
        print(f"{x['pos']}. {x['name']}（appid {x['appid']}）{mark}")
    print("\n## 人气新作（Steam「人気の新作」）")
    print("、".join(f"{x['name']}（{x['appid']}）" for x in sig["popularnew"][:20]) or "（无）")

    today = now.date().isoformat()
    news = [it for it in state["items"] if it.get("date") == today and it.get("category") not in SECTIONS]
    print("\n## 今天已经发布的新闻（「今日の話題」可以从这里选，也可以自己再找）")
    print("\n".join(f"- [{it.get('source', '')}] {it.get('title', '')}\n  {it['url']}" for it in news) or "（无）")
    print(f"\n（数据已保存到 {SPECIAL_CTX.relative_to(ROOT)}，special-check / special-submit 会用它自动填入数字）")
    return 0


def _s(v, n: int) -> str:
    return str(v or "").strip()[:n]


def _sources(raw, where: str, errs: list, need: int, kinds: bool) -> list:
    if not isinstance(raw, list):
        errs.append(f"{where}：sources 必须是数组")
        return []
    out = []
    for k, s in enumerate(raw, 1):
        url = s.get("url") if isinstance(s, dict) else s
        if not is_url(url):
            errs.append(f"{where}：第 {k} 个来源的 url 不对")
            continue
        if kinds:
            kind = s.get("kind") if isinstance(s, dict) else None
            if kind not in SOURCE_KINDS:
                errs.append(f"{where}：第 {k} 个来源的 kind 必须是 {list(SOURCE_KINDS)} 之一")
            out.append({"title": _s(s.get("title") if isinstance(s, dict) else "", 120) or urlsplit(url).netloc,
                        "url": url.strip(), "kind": kind if kind in SOURCE_KINDS else "article"})
        else:
            out.append(url.strip())
    if len(out) < need:
        errs.append(f"{where}：来源至少要 {need} 个")
    return out[:8]


def _paras(text, where: str, errs: list, lo: int, hi: int, pmax: int) -> str:
    t = str(text or "").replace("\r\n", "\n").strip()
    ps = [re.sub(r"[ \t]+\n", "\n", p).strip() for p in re.split(r"\n[ \t]*\n", t) if p.strip()]
    if not lo <= len(t) <= hi:
        errs.append(f"{where}：要 {lo}〜{hi} 字，现在是 {len(t)} 字")
    if not 2 <= len(ps) <= pmax:
        errs.append(f"{where}：要分成 2〜{pmax} 段（段与段之间空一行）")
    if any(len(p) > 340 for p in ps):
        errs.append(f"{where}：每段最多 340 字")
    if t and not JA_CHARS.search(t):
        errs.append(f"{where}：必须用日文写")
    return "\n\n".join(ps)[:hi + 200]


def _points(raw, where: str, errs: list, lo: int, hi: int, each: int) -> list:
    pts = [str(p).strip() for p in raw if str(p).strip()] if isinstance(raw, list) else []
    if not lo <= len(pts) <= hi:
        errs.append(f"{where}：要写 {lo}〜{hi} 条，现在是 {len(pts)} 条")
    if any(len(p) > each for p in pts):
        errs.append(f"{where}：每条最多 {each} 字")
    return [p[:each + 20] for p in pts[:hi]]


def _terms(raw, errs: list) -> list:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 3:
        errs.append("game.terms 是最多 3 个的数组")
        raw = raw[:3] if isinstance(raw, list) else []
    out = []
    for k, t in enumerate(raw, 1):
        term = _s(t.get("term"), 60) if isinstance(t, dict) else ""
        explain = _s(t.get("explain"), 200) if isinstance(t, dict) else ""
        if not term or not explain or len(term) > 40 or len(explain) > 160:
            errs.append(f"game.terms 第 {k} 个：term（最多 40 字）和 explain（最多 160 字）都要写")
            continue
        out.append({"term": term, "explain": explain})
    return out


def validate_special(data, strict: bool = True, ctx: dict | None = None) -> dict:
    """特集の原稿を検査して整える。strict=False（発布端）は足りない所があっても止めない。
    急上昇 TOP5 の数字は AI に書かせず、ctx（special-context が取った数値）から入れる。"""
    errors: list[str] = []
    errs = errors if strict else []
    if not isinstance(data, dict):
        raise ResultError("最外层必须是 JSON 对象")
    g = data.get("game") if isinstance(data.get("game"), dict) else {}
    if not g:
        errors.append("game（今夜の1本）不能为空")

    def need(key: str, n: int, where: str = "game") -> str:
        v = _s(g.get(key), n + 40)
        if not v:
            errs.append(f"{where}.{key} 不能为空")
        elif len(v) > n:
            errs.append(f"{where}.{key} 最多 {n} 字")
        return v[:n]

    plats = [_s(p, 30) for p in g.get("platforms") or [] if _s(p, 30)] if isinstance(g.get("platforms"), list) else []
    if not plats:
        errs.append("game.platforms 要写平台（数组）")
    appid = g.get("steam_appid")
    appid = int(appid) if isinstance(appid, (int, str)) and str(appid).isdigit() else None
    if not is_url(g.get("url")):
        errs.append("game.url 要写官方网站或商店页面的 URL")
    player = g.get("player") if isinstance(g.get("player"), dict) else {}
    maker = g.get("maker") if isinstance(g.get("maker"), dict) else {}
    summary = need("summary", 260)
    if summary and len(summary) < 80:
        errs.append("game.summary 至少 80 字")
    game = {
        "title": need("title", 80), "title_en": _s(g.get("title_en"), 80), "developer": need("developer", 80),
        "platforms": plats[:6], "release": need("release", 40), "genre": need("genre", 40),
        "price": _s(g.get("price"), 30), "engine": _s(g.get("engine"), 40), "steam_appid": appid,
        "url": _s(g.get("url"), 500), "hook": need("hook", 60), "why_now": _s(g.get("why_now"), 140), "summary": summary,
        "player": {"points": _points(player.get("points"), "game.player.points", errs, 3, 4, 90),
                   "detail": _paras(player.get("detail"), "game.player.detail", errs, 200, 1000, 5),
                   "for_whom": _s(player.get("for_whom"), 120), "caution": _s(player.get("caution"), 120)},
        "maker": {"points": _points(maker.get("points"), "game.maker.points", errs, 3, 4, 90),
                  "detail": _paras(maker.get("detail"), "game.maker.detail", errs, 300, 1400, 6)},
        "steal": _points(g.get("steal"), "game.steal（盗めるポイント）", errs, 2, 3, 110),
        "exercise": _s(g.get("exercise"), 180),
        "terms": _terms(g.get("terms"), errs),
        "sources": _sources(g.get("sources"), "game", errs, 3, True),
        "media": None if strict else _clean_media(g.get("media")),
        "price_jp": "" if strict else _s(g.get("price_jp"), 30),
    }
    if not game["player"]["for_whom"]:
        errs.append("game.player.for_whom（どんな人に向いているか）不能为空")
    if len(game["exercise"]) < 20:
        errs.append("game.exercise（やってみよう）至少 20 字")
    if strict and not any(s["kind"] in MAKER_KINDS for s in game["sources"]):
        errs.append("game.sources 里至少要有 1 个 interview / talk / postmortem（作り手視点的依据）")

    rows = {r["appid"]: r for r in (ctx or {}).get("rows", [])}
    rk = data.get("ranking") if isinstance(data.get("ranking"), dict) else {}
    items = rk.get("items") if isinstance(rk.get("items"), list) else []
    if len(items) != SPECIAL.get("ranking_size", 5):
        errs.append(f"ranking.items 要正好 {SPECIAL.get('ranking_size', 5)} 款，现在是 {len(items)} 款")
    ranking = []
    for k, it in enumerate(items[:5], 1):
        if not isinstance(it, dict):
            errs.append(f"ranking 第 {k} 款不是对象")
            continue
        w = f"ranking 第 {k} 款"
        a = it.get("steam_appid")
        a = int(a) if isinstance(a, (int, str)) and str(a).isdigit() else None
        row = rows.get(a)
        if strict and row and row.get("evergreen"):
            errs.append(f"{w}（{row['name']}）是常年霸榜、这周没在涨的游戏，换成真正在升温的")
        why = _s(it.get("why"), 200)
        if not 30 <= len(why) <= 160:
            errs.append(f"{w}：why（为什么在涨）要 30〜160 字")
        if not is_url(it.get("url")):
            errs.append(f"{w}：url 不对")
        tag = it.get("tag") if it.get("tag") in RANK_TAGS else "急上昇"
        stat_keys = ("peak24", "now", "d1", "w1", "top_rank", "last_week_rank", "release")
        if row:   # 研究端：special-context の数値を入れる（AI が書いた数字は使わない）
            stats = {k2: row.get(k2) for k2 in stat_keys}
        elif not strict and isinstance(it.get("stats"), dict):   # 発布端：交稿のときに入れた数値をそのまま使う
            stats = {k2: it["stats"].get(k2) for k2 in stat_keys if isinstance(it["stats"].get(k2), (int, float, str, type(None)))}
        else:
            stats = None
        if strict and a and ctx and not row:
            errs.append(f"{w}：appid {a} 不在 special-context 的数据里（数字填不上）。用表里的游戏，或者去掉 steam_appid 并写清来源")
        ranking.append({"rank": k, "title": _s(it.get("title"), 60) or (row or {}).get("name", ""), "steam_appid": a,
                        "url": _s(it.get("url"), 500), "why": why[:160], "tag": tag, "stats": stats,
                        "img": None if strict else _img(it.get("img")),
                        "sources": _sources(it.get("sources"), w, errs, 1, False)})
    watch = []
    raw_w = data.get("watch") if isinstance(data.get("watch"), list) else []
    if not 1 <= len(raw_w) <= 3:
        errs.append(f"watch（期待の新星）要 1〜3 款，现在是 {len(raw_w)} 款")
    for k, it in enumerate(raw_w[:3], 1):
        if not isinstance(it, dict):
            continue
        w = f"watch 第 {k} 款"
        why = _s(it.get("why"), 200)
        if not 30 <= len(why) <= 160:
            errs.append(f"{w}：why（为什么有潜力）要 30〜160 字")
        if not is_url(it.get("url")):
            errs.append(f"{w}：url 不对")
        a = it.get("steam_appid")
        watch.append({"title": _s(it.get("title"), 60), "steam_appid": int(a) if str(a or "").isdigit() else None,
                      "url": _s(it.get("url"), 500), "why": why[:160],
                      "status": it.get("status") if it.get("status") in WATCH_STATUS else "その他",
                      "img": None if strict else _img(it.get("img")),
                      "sources": _sources(it.get("sources"), w, errs, 1, False)})
    news = []
    raw_n = data.get("news") if isinstance(data.get("news"), list) else []
    if not 3 <= len(raw_n) <= 5:
        errs.append(f"news（今日の話題）要 3〜5 条，现在是 {len(raw_n)} 条")
    for k, it in enumerate(raw_n[:5], 1):
        if not isinstance(it, dict) or not is_url(it.get("url")):
            errs.append(f"news 第 {k} 条：url 不对")
            continue
        w = f"news 第 {k} 条"
        summ, why = _s(it.get("summary"), 240), _s(it.get("why"), 180)
        if not 40 <= len(summ) <= 200:
            errs.append(f"{w}：summary 要 40〜200 字")
        if not 20 <= len(why) <= 140:
            errs.append(f"{w}：why（为什么是话题）要 20〜140 字")
        news.append({"title": _s(it.get("title"), 120), "url": _s(it.get("url"), 500), "id": item_id(it["url"]),
                     "source": _s(it.get("source"), 40), "summary": summ[:200], "why": why[:140]})
    if errors:
        raise ResultError("\n".join(errors))
    basis = _s(rk.get("basis"), 200) or ("Steam の同時接続数（SteamCharts）の伸び率をもとに、"
                                         "定番の上位作品を除いて、伸びている理由が確認できたものを選びました。")
    return {"game": game, "ranking": {"basis": basis, "items": ranking}, "watch": watch, "news": news,
            "report": _s(data.get("report"), 3000)}


def _special_ctx() -> dict | None:
    try:
        return json.loads(SPECIAL_CTX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def cmd_special_check(args) -> int:
    ctx = _special_ctx()
    try:
        sp = validate_special(read_json(args.file), True, ctx)
    except ResultError as e:
        print("❌ 格式有问题，请修改后再检查：\n" + str(e))
        return 1
    print(f"✅ 格式正确：今夜の1本「{sp['game']['title']}」、急上昇 {len(sp['ranking']['items'])} 款、"
          f"期待の新星 {len(sp['watch'])} 款、今日の話題 {len(sp['news'])} 条"
          + ("" if ctx else "\n⚠️ 没有找到 special-context 的数据，排名的数字会是空的。请先执行 special-context"))
    for it in sp["ranking"]["items"]:
        print(f"  {it['rank']}. {it['title']}　{rank_stat(it) or '（没有数字）'}")
    return 0


def cmd_special_submit(args) -> int:
    ctx = _special_ctx()
    try:
        sp = validate_special(read_json(args.file), True, ctx)
    except ResultError as e:
        print("❌ 格式有问题，没有提交。请修改后再执行 special-submit：\n" + str(e))
        return 1
    n_img = attach_media(sp)
    print(f"🖼 Steam ストアの画像 {n_img} 枚を付けました（steam_appid から自動で取得）")
    now = now_jst()
    payload = {**sp, "date": now.strftime("%Y-%m-%d"), "created_at": now.isoformat(timespec="seconds"),
               "data": {"fetched": (ctx or {}).get("fetched"),
                        "upcoming": [x["appid"] for x in (ctx or {}).get("upcoming", [])][:25],
                        "topsellers": [x["appid"] for x in (ctx or {}).get("topsellers", [])][:25]}}
    prefix = PREVIEW_PREFIX if args.preview else SPECIAL_PREFIX
    branch = push_branch(prefix, "special", "special.json", payload,
                         f"special: {payload['date']} {sp['game']['title'][:40]}")
    where = "预览分支（不会发到 Discord）" if args.preview else f"分支（{SPECIAL.get('label', '19:00')} 准时发布）"
    print(f"✅ 已提交 19:00 特集到{where} {branch}")
    return 0


def special_title(day: date, sp: dict) -> str:
    return f"🌙 {day.month}/{day.day}（{WEEKDAYS_JA[day.weekday()]}）19:00 特集｜{sp['game']['title']}"


def _moves(sp: dict, prev: dict | None) -> None:
    """前回の TOP5 と比べて ↑↓→ NEW を付ける。"""
    before = {(x.get("appid") or x.get("title")): i for i, x in enumerate((prev or {}).get("top5", []), 1)}
    for it in sp["ranking"]["items"]:
        p = before.get(it.get("steam_appid") or it["title"])
        it["move"] = "new" if p is None else "up" if p > it["rank"] else "down" if p < it["rank"] else "same"


MOVE_MARK = {"new": "🆕", "up": "⬆", "down": "⬇", "same": "➡"}


def build_special_embeds(sp: dict, day: date) -> list[dict]:
    g, site = sp["game"], CONFIG.get("site_url", "").rstrip("/")
    link = f"{site}/#/special?d={day.isoformat()}" if site else ""
    desc = (f"**{md(g['hook'])}**\n{md(g['summary'])}\n\n🎮 **プレイヤー視点**\n"
            + "\n".join(f"▸ {md(p)}" for p in g["player"]["points"][:2])
            + "\n\n🛠 **作り手視点**\n" + "\n".join(f"▸ {md(p)}" for p in g["maker"]["points"][:2]))
    if link:
        desc += f"\n\n📖 [続きはサイトで：作り手の工夫・盗めるポイント・やってみよう]({link})"
    embeds = [{"title": f"🌙 今夜の1本｜{g['title']}"[:256], "url": g["url"], "description": desc[:3000], "color": 0x8E6CFF,
               "footer": {"text": f"{g['developer']} ・ {' / '.join(g['platforms'])} ・ {g['genre']}"[:200]}}]
    if (g.get("media") or {}).get("header"):
        embeds[0]["image"] = {"url": g["media"]["header"]}
    lines = []
    for it in sp["ranking"]["items"]:
        stat = rank_stat(it)
        why = it["why"] if len(it["why"]) <= 70 else it["why"][:68] + "…"
        lines.append(f"**{it['rank']}.** {MOVE_MARK.get(it.get('move'), '')} **[{md(it['title'])}]({it['url']})** `{it['tag']}`\n"
                     f"└ {(stat + ' ・ ') if stat else ''}{md(why)}")
    fetched = (sp.get("data") or {}).get("fetched") or ""
    embeds.append({"title": "📈 急上昇 TOP5", "description": "\n".join(lines)[:4000], "color": 0xFF4F6D,
                   **({"footer": {"text": f"数字：Steam・SteamCharts（{fetched[5:16].replace('T', ' ')} 時点）"}} if fetched else {})})
    top_img = next((it["img"] for it in sp["ranking"]["items"] if it.get("img")), None)
    if top_img:
        embeds[-1]["thumbnail"] = {"url": top_img}
    if sp["watch"]:
        embeds.append({"title": "🌱 期待の新星", "color": 0x3EE08F, "description": "\n".join(
            f"▸ **[{md(w['title'])}]({w['url']})** `{w['status']}`\n└ {md(w['why'][:80])}" for w in sp["watch"])[:2000]})
        w_img = next((w["img"] for w in sp["watch"] if w.get("img")), None)
        if w_img:
            embeds[-1]["thumbnail"] = {"url": w_img}
    if sp["news"]:
        embeds.append({"title": "📰 今日の話題", "color": 0x5865F2, "description": "\n".join(
            f"▸ [{md(n['title'])}]({n['url']})\n└ {md(n['why'][:80])}" for n in sp["news"])[:3000]})
    if link:
        embeds.append({"description": f"📖 [特集の全文・過去の特集はサイトで]({link})", "color": 0x2B2D31})
    return embeds


def email_for_special(title: str, sp: dict, day: date) -> tuple[str, str]:
    g = sp["game"]
    link = site_link(f"#/special?d={day.isoformat()}")
    inner = (f"<p style=\"margin:16px 0 0;font-size:12px;font-weight:800;color:#7a4dff\">🌙 今夜の1本</p>"
             f"<p style=\"margin:4px 0 0;font-size:19px;font-weight:900\"><a href=\"{_h(g['url'])}\" style=\"color:#15161c;text-decoration:none\">{_h(g['title'])}</a></p>"
             f"<p style=\"margin:2px 0;font-size:12px;color:#7a7e8a\">{_h(g['developer'])} ・ {_h(' / '.join(g['platforms']))}</p>"
             + (f"<img src=\"{_h(g['media']['header'])}\" width=\"460\" alt=\"\" style=\"display:block;width:100%;max-width:460px;height:auto;border-radius:10px;margin:10px 0 0\">"
                if (g.get("media") or {}).get("header") else "")
             + 
             f"<p style=\"margin:8px 0;font-size:15px;font-weight:700\">{_h(g['hook'])}</p><p style=\"margin:6px 0;font-size:14px\">{_h(g['summary'])}</p>"
             "<ul style=\"margin:6px 0 6px 18px;padding:0;font-size:14px\">"
             + "".join(f"<li>🎮 {_h(p)}</li>" for p in g["player"]["points"][:2])
             + "".join(f"<li>🛠 {_h(p)}</li>" for p in g["maker"]["points"][:2]) + "</ul>"
             f"<p style=\"margin:6px 0 0\"><a href=\"{_h(link)}\" style=\"font-size:13px;color:#b06d00;font-weight:700\">続きをサイトで読む →</a></p>"
             "<p style=\"margin:20px 0 4px;font-size:13px;font-weight:800\">📈 急上昇 TOP5</p>"
             + "".join(f"<div style=\"font-size:14px;margin:3px 0\"><b>{it['rank']}.</b> <a href=\"{_h(it['url'])}\" style=\"color:#15161c\">{_h(it['title'])}</a>"
                       f" <span style=\"color:#7a7e8a;font-size:12px\">{_h(rank_stat(it))}</span></div>" for it in sp["ranking"]["items"])
             + ("<p style=\"margin:18px 0 4px;font-size:13px;font-weight:800\">📰 今日の話題</p>"
                + "".join(f"<div style=\"font-size:14px;margin:3px 0\">・<a href=\"{_h(n['url'])}\" style=\"color:#15161c\">{_h(n['title'])}</a></div>" for n in sp["news"])
                if sp["news"] else ""))
    html = MAIL_WRAP.format(body=_mail_head(title, "19:00 特集") + _mail_box(inner) + _mail_foot())
    text = "\n".join([title, "", f"🌙 今夜の1本：{g['title']}", g["hook"], g["summary"], link, "", "📈 急上昇 TOP5",
                      *[f"{it['rank']}. {it['title']}（{rank_stat(it)}）" for it in sp["ranking"]["items"]], "",
                      "📰 今日の話題", *[f"・{n['title']}\n  {n['url']}" for n in sp["news"]], "",
                      f"配信の停止・設定：{site_link('#/notify')}"])
    return html, text


def publish_special(branch: str, state: dict, store, dry_run: bool) -> str:
    data = json.loads(git("show", f"origin/{branch}:inbox/special.json"))  # 只当作数据读取
    sp = {**validate_special(data, strict=False), "data": data.get("data") or {}}
    day = batch_day(data)
    if any(s.get("date") == day.isoformat() for s in state.get("specials", [])):
        state["batches"].append({"branch": branch, "slot": "special", "date": day.isoformat(), "count": 0, "status": "ok (dup)"})
        return f"⚠️ {day} 的 19:00 特集已经发过了，这次的稿跳过"
    prev = (state.get("specials") or [None])[-1]
    _moves(sp, prev)
    title = special_title(day, sp)
    embeds = build_special_embeds(sp, day)
    post_forum_thread(title, embeds, dry_run)
    note = ""
    if store is not None or dry_run:
        try:
            subs = store.subscribers() if store is not None else []
            notes = [deliver_webhooks(subs, store, title, embeds, dry_run)]
            each = [s["email"] for s in subs if s.get("email_on") and s.get("email_mode") == "each" and s.get("email")]
            if each:
                html, text = email_for_special(title, sp, day)
                notes.append(send_emails(each, title, html, text, dry_run))
            note = "；".join(n for n in notes if n)
        except Exception as e:   # noqa: BLE001  配信の失敗で特集の発布を失敗にしない
            note = f"⚠️ 受け取り設定の人への配信でエラー：{str(e)[:150]}"
    if not dry_run:
        store.add_special(day.isoformat(), {**sp, "date": day.isoformat()})
    state.setdefault("specials", []).append({
        "date": day.isoformat(), "title": sp["game"]["title"], "appid": sp["game"]["steam_appid"], "hook": sp["game"]["hook"],
        "top5": [{"appid": it["steam_appid"], "title": it["title"]} for it in sp["ranking"]["items"]],
        "watch": [w["title"] for w in sp["watch"]]})
    state["special_snap"] = {"date": day.isoformat(), **{k: sp["data"].get(k, []) for k in ("upcoming", "topsellers")}}
    state["batches"].append({"branch": branch, "slot": "special", "date": day.isoformat(),
                             "count": 1 + len(sp["news"]), "status": "ok"})
    return (f"🌙 {day} 19:00 特集已发布：「{sp['game']['title']}」、急上昇 {len(sp['ranking']['items'])} 款、"
            f"新星 {len(sp['watch'])} 款、话题 {len(sp['news'])} 条" + (f"\n　{mask_emails(note)}" if note else ""))


def cmd_preview_special(args) -> int:
    import html as H

    data = load_branch_json(args.source, "special.json")
    sp = {**validate_special(data, strict=False), "data": data.get("data") or {}}
    if sp["game"].get("steam_appid") and not sp["game"].get("media"):
        attach_media(sp)
    day = batch_day(data)
    _moves(sp, (load_state().get("specials") or [None])[-1])
    embeds = build_special_embeds(sp, day)
    emb_html = "".join(
        f'<div class="embed" style="border-color:#{e.get("color", 0x2B2D31):06x}">'
        + (f'<div class="et">{H.escape(e["title"])}</div>' if e.get("title") else "")
        + f'<div class="ed">{_md_to_html(e.get("description", ""))}</div>'
        + (f'<div class="ef">{H.escape(e["footer"]["text"])}</div>' if e.get("footer") else "") + "</div>" for e in embeds)
    g = sp["game"]

    def block(name: str, part: dict) -> str:
        return (f"<h3>{name}</h3><ol class='pts'>" + "".join(f"<li>{H.escape(p)}</li>" for p in part["points"]) + "</ol>"
                + "".join(f"<p class='para'>{H.escape(p)}</p>" for p in part["detail"].split("\n\n")))
    media = g.get("media") or {}
    gallery = ((f"<img src='{H.escape(media['header'])}' style='max-width:460px;width:100%;border-radius:8px'>" if media.get("header") else "")
               + "".join(f"<a href='{H.escape(x['full'])}'><img src='{H.escape(x['thumb'])}' style='width:200px;margin:4px;border-radius:6px'></a>"
                         for x in media.get("shots") or []))
    full = (gallery + f"<div class='card'><div class='meta'>{H.escape(g['developer'])} ・ {H.escape(' / '.join(g['platforms']))} ・ "
            f"{H.escape(g.get('price_jp') or g['price'] or '')} ・ "
            f"{H.escape(g['release'])} ・ {H.escape(g['genre'])} ・ {H.escape(g['engine'] or '')}</div>"
            f"<h3><a href='{H.escape(g['url'])}'>{H.escape(g['title'])}</a></h3><p><b>{H.escape(g['hook'])}</b></p>"
            f"<p>{H.escape(g['summary'])}</p><p class='meta'>なぜ今：{H.escape(g['why_now'])}</p>"
            + block("🎮 プレイヤー視点", g["player"]) + f"<p class='meta'>向いている人：{H.escape(g['player']['for_whom'])}"
            f"<br>注意：{H.escape(g['player']['caution'])}</p>" + block("🛠 作り手視点", g["maker"])
            + "<h3>💡 ここを盗め</h3><ol>" + "".join(f"<li>{H.escape(s)}</li>" for s in g["steal"]) + "</ol>"
            + f"<h3>✏️ やってみよう</h3><p>{H.escape(g['exercise'])}</p>"
            + ("<dl class='terms'>" + "".join(f"<dt>{H.escape(t['term'])}</dt><dd>{H.escape(t['explain'])}</dd>" for t in g["terms"]) + "</dl>" if g["terms"] else "")
            + "<h3>出典</h3><ul>" + "".join(f"<li>[{s['kind']}] <a href='{H.escape(s['url'])}'>{H.escape(s['title'])}</a></li>" for s in g["sources"]) + "</ul></div>")
    rank = "".join(f"<div class='card'>" + (f"<img src='{H.escape(it['img'])}' style='width:184px;float:right;border-radius:6px'>" if it.get("img") else "")
                   + f"<b>{it['rank']}. <a href='{H.escape(it['url'])}'>{H.escape(it['title'])}</a></b> "
                   f"［{it['tag']}・{MOVE_MARK.get(it.get('move'), '')}］<div class='meta'>{H.escape(rank_stat(it))}</div>"
                   f"<p>{H.escape(it['why'])}</p></div>" for it in sp["ranking"]["items"])
    watch = "".join(f"<div class='card'><b><a href='{H.escape(w['url'])}'>{H.escape(w['title'])}</a></b>［{w['status']}］"
                    f"<p>{H.escape(w['why'])}</p></div>" for w in sp["watch"])
    news = "".join(f"<div class='card'><b><a href='{H.escape(n['url'])}'>{H.escape(n['title'])}</a></b>（{H.escape(n['source'])}）"
                   f"<p>{H.escape(n['summary'])}</p><p class='meta'>💬 {H.escape(n['why'])}</p></div>" for n in sp["news"])
    body = (f"<h1>19:00 特集 预览（没有发送到 Discord）</h1><p>{day}</p>"
            f"<h2>① Discord 论坛帖子的样子</h2><div class='thread'><div class='tt'>{H.escape(special_title(day, sp))}</div>{emb_html}</div>"
            f"<h2>② 今夜の1本（网站上的全文）</h2>{full}<h2>③ 急上昇 TOP5</h2><p class='meta'>{H.escape(sp['ranking']['basis'])}</p>{rank}"
            f"<h2>④ 期待の新星</h2>{watch}<h2>⑤ 今日の話題</h2>{news}"
            f"<h2>⑥ AI 的报告</h2><pre class='rep'>{H.escape(sp['report'] or '（なし）')}</pre>")
    write_page(f"preview-special-{day}.html", body)
    out = ROOT / "out" / "special_preview.json"   # ローカルの網站（?demo）で特集ページを確認する用
    out.write_text(json.dumps({**sp, "date": day.isoformat()}, ensure_ascii=False), encoding="utf-8")
    return 0


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
    if slot == "special":
        return f"{SPECIAL.get('label', '19:00')} 特集"
    return "学习内容" if slot == "learn" else CONFIG["slots"].get(slot, {}).get("label", slot)


def pending_all() -> list[str]:
    return pending_branches(INBOX_PREFIX) + pending_branches(LEARN_PREFIX) + pending_branches(SPECIAL_PREFIX)


def cmd_publish_status(args) -> int:
    now = now_jst()
    pending = pending_all()
    ready = [br for br in pending if is_ready(br, now)]
    done = _published_today()
    print(f"# 发布状态（{now:%Y-%m-%d %H:%M} 日本时间）\n\n## 今天已经发布的批次")
    for b in done:
        ok = str(b.get("status", "")).startswith("ok")
        print(f"- {'✅' if ok else '❌'} {_batch_label(b)}：{b.get('count', 0)} 条" + ("" if ok else f"（{b.get('status')}）"))
    if not done:
        print("- （还没有）")
    print("\n## 已交稿、还没发布的分支")
    for br in pending:
        due = due_at(br)
        when = f"{due:%H:%M} 公开" if due else "公开时间不明"
        print(f"- {br}（{when}" + ("）" if br in ready else "，现在还早，不用管）"))
    if not pending:
        print("- （没有）")
    late = [CONFIG["slots"][s]["label"] for s in CONFIG["slots"]
            if now >= now.replace(hour=int(s), minute=0, second=0, microsecond=0) - EARLY_WINDOW
            and tasks_for(now.date(), s) and not any(str(b.get("slot")) == s for b in done)
            and not any(f"-{s}-" in br for br in pending)]
    sp_due = now.replace(hour=int(SPECIAL.get("hour", 19)), minute=0, second=0, microsecond=0)
    if (SPECIAL.get("live") and now >= sp_due - EARLY_WINDOW and not any(str(b.get("slot")) == "special" for b in done)
            and not any("-special-" in br for br in pending)):
        late.append(f"{SPECIAL.get('label', '19:00')} 特集")
    if late:
        print(f"\n⚠️ 研究端还没交稿的批次：{'、'.join(late)}（这不是发布的问题，报告里写上即可）")
    print(f"\nNEED_PUBLISH={'yes' if ready else 'no'}")
    return 0


def cmd_wait_published(args) -> int:
    """触发发布之后，等到待发布的分支都被处理掉（发布端处理完会删除分支），再看有没有失败。
    发布端会等到整点才发，所以最多等到「公开时间 + timeout 秒」。"""
    now = now_jst()
    watch = {br for br in pending_all() if is_ready(br, now)}
    if not watch:
        print("✅ 没有待发布的分支（已经发布完了）")
        return 0
    last_due = max([d for d in map(due_at, watch) if d] + [now])
    deadline = max(now, last_due) + timedelta(seconds=args.timeout)
    print(f"等待发布：{', '.join(sorted(watch))}（{last_due:%H:%M} 公开，最多等到 {deadline:%H:%M:%S}）", flush=True)
    while True:
        left = watch & set(pending_all())
        if not left:
            break
        if now_jst() >= deadline:
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
    p = sub.add_parser("publish-pending")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--now", action="store_true", help="不等公开时间，所有待发布的稿马上发")
    sub.add_parser("preview").add_argument("source", help="预览分支名（claude/preview-…）或结果 JSON 文件")
    sub.add_parser("preview-learn").add_argument("source", help="学习内容的预览分支或 JSON 文件")
    sub.add_parser("publish-status", help="发布检查：今天的发布记录和待发布的分支")
    sub.add_parser("wait-published", help="触发发布后，等待并确认分支被处理").add_argument("--timeout", type=int, default=240)
    sub.add_parser("mail-check", help="检查邮件中继（Apps Script）的设置，不发任何邮件")
    sub.add_parser("special-context", help="19:00 特集的材料（Steam・SteamCharts 的伸び率など）")
    sub.add_parser("special-check").add_argument("file")
    p = sub.add_parser("special-submit")
    p.add_argument("file")
    p.add_argument("--preview", action="store_true", help="交到预览分支，不发到 Discord")
    sub.add_parser("preview-special").add_argument("source", help="特集的预览分支（claude/preview-…）或 JSON 文件")
    sub.add_parser("mail-resend", help="把上一次的新闻重新发给开启了邮件的人（只发邮件）").add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    return {"context": cmd_context, "feeds": cmd_feeds, "community": cmd_community, "check": cmd_check,
            "submit": cmd_submit, "learn-context": cmd_learn_context, "learn-check": cmd_learn_check,
            "learn-submit": cmd_learn_submit, "publish-pending": cmd_publish_pending,
            "preview": cmd_preview, "preview-learn": cmd_preview_learn,
            "publish-status": cmd_publish_status, "wait-published": cmd_wait_published,
            "mail-check": cmd_mail_check, "mail-resend": cmd_mail_resend,
            "special-context": cmd_special_context, "special-check": cmd_special_check,
            "special-submit": cmd_special_submit, "preview-special": cmd_preview_special}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
