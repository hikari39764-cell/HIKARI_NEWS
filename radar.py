"""HIKARI NEWS 的工具脚本。分成「研究端」和「发布端」两部分。

研究端（Claude 定时任务，没有任何密钥，可以自由上网）:
    python3 radar.py context               这次要研究什么：时段、任务、关键词、已推送过的链接
    python3 radar.py feeds                 优质网站 RSS 的最新文章（研究的第一手候选）
    python3 radar.py community             社区热门候选（研究线索）
    python3 radar.py check out/results.json    检查结果格式
    python3 radar.py submit out/results.json   检查后推送到 GitHub 的 claude/inbox-* 分支
    python3 radar.py submit out/results.json --preview   交到 claude/preview-*（不发 Discord）

管理员本地：
    python radar.py preview claude/preview-…   把预览分支渲染成 out/preview-*.html

发布端（GitHub Actions，持有密钥，不读任何网页）:
    python3 radar.py publish-pending [--dry-run]
        读取所有 claude/inbox-* 分支里的结果（只当作数据读取，不执行里面的任何代码）
        → 检查 → 发 Discord 论坛帖子 → 写入 Firebase → 更新 state/published.json → 删除分支

发布端需要的环境变量（GitHub Secrets）:
    DISCORD_FORUM_WEBHOOK          论坛频道的 Webhook URL
    DISCORD_LOG_WEBHOOK            管理员日志频道的 Webhook URL（可选）
    FIREBASE_SERVICE_ACCOUNT_B64   Firebase 服务账号密钥 JSON 的 base64
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
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
STATE_PATH = ROOT / "state" / "published.json"
JST = timezone(timedelta(hours=CONFIG["timezone_offset_hours"]))
LEVELS = ("入門", "中級", "上級")
JA_CHARS = re.compile(r"[぀-ヿ一-鿿]")
WEEKDAYS_JA = "月火水木金土日"
INBOX_PREFIX = "claude/inbox-"
PREVIEW_PREFIX = "claude/preview-"
TASKS = {t["id"]: t for t in CONFIG["tasks"]}

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


def match_keywords(item: dict) -> list[str]:
    text = " ".join([item["title"], item["summary"], item["note"], *item["tags"]]).lower()
    return [k for k in CONFIG.get("keywords", []) if k.lower() in text]


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {"items": [], "batches": [], "last_weekly": None, "warned": []}


def save_state(state: dict) -> None:
    state["items"] = state["items"][-800:]
    state["batches"] = state["batches"][-120:]
    state["warned"] = state["warned"][-60:]
    STATE_PATH.parent.mkdir(exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def git(*args: str, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{r.stderr.strip()}")
    return r.stdout


# ======================================================================
# 结果检查（研究端和发布端共用）
# ======================================================================

class ResultError(Exception):
    pass


def validate(data) -> list[dict]:
    """检查结果数据。有问题就抛出 ResultError，并说明要怎么改。"""
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise ResultError('最外层必须是 {"items": [...]}')

    errors, clean = [], []
    for n, it in enumerate(items, 1):
        where = f"第 {n} 条"
        if not isinstance(it, dict):
            errors.append(f"{where}：不是对象")
            continue
        cat = it.get("category")
        url = str(it.get("url") or "").strip()
        title = str(it.get("title") or "").strip()
        summary = str(it.get("summary") or "").strip()
        if cat not in TASKS:
            errors.append(f"{where}：category 必须是 {list(TASKS)} 之一")
        if not re.match(r"^https?://[^\s<>\"']+$", url):
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
        clean.append({
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
        })

    for cat, task in TASKS.items():
        count = sum(1 for c in clean if c["category"] == cat)
        if count > task["max_items"]:
            errors.append(f"category {cat} 最多 {task['max_items']} 条，现在有 {count} 条")
    if errors:
        raise ResultError("\n".join(errors))
    return clean


def read_results(path: str) -> list[dict]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ResultError(f"无法读取 JSON：{e}")
    return validate(data)


# ======================================================================
# 研究端
# ======================================================================

def cmd_context(args) -> int:
    now = now_jst()
    slot = args.slot or slot_for(now)
    tasks = tasks_for(now.date(), slot)
    state = load_state()
    recent = [f"- {it.get('title', '')}\n  {it['url']}" for it in state["items"][-200:]]

    print(f"# 本次运行：{now:%Y-%m-%d %H:%M} JST ／ {CONFIG['slots'][slot]['label']} 这一批（slot={slot}）\n")
    print(f"读者：{CONFIG['reader']}\n")
    print(f"关注关键词（找到相关内容时优先）：{'、'.join(CONFIG.get('keywords', [])) or '无'}\n")
    print("## 这一批要做的任务")
    if not tasks:
        print("（这个时段没有任务，直接结束即可。）")
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
    print("\n## 已经推送过的内容（不要再选，同一件事的其他文章也不要选）")
    print("\n".join(recent) if recent else "（无）")
    return 0


def cmd_feeds(args) -> int:
    """读取这一批相关的优质网站 RSS，列出最近的新文章，作为研究的第一手候选。"""
    from collectors import collect_feeds

    now = now_jst()
    slot = args.slot or slot_for(now)
    ids = {t["id"] for t in tasks_for(now.date(), slot)}
    feeds = [f for f in CONFIG.get("feeds", []) if ids & set(f["for"])]
    known = {item_id(it["url"]) for it in load_state()["items"]}
    result = collect_feeds(feeds)
    total = 0
    print(f"# 优质网站的最新文章（slot={slot}，已推送过的不显示）")
    for feed in feeds:
        entries = [e for e in result.get(feed["name"], []) if item_id(e["url"]) not in known]
        if not entries:
            continue
        print(f"\n## {feed['name']}（对应任务：{'、'.join(sorted(ids & set(feed['for'])))}）")
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


def cmd_check(args) -> int:
    try:
        items = read_results(args.file)
    except ResultError as e:
        print("❌ 格式有问题，请修改后再检查：\n" + str(e))
        return 1
    print(f"✅ 格式正确，共 {len(items)} 条")
    return 0


def cmd_submit(args) -> int:
    """检查结果，然后把它作为一个新分支推送到 GitHub。
    正式：claude/inbox-日期-时段-时刻（发布端会发到 Discord）
    预览（--preview）：claude/preview-…（发布端不会处理，只给管理员看效果）
    """
    try:
        items = read_results(args.file)
    except ResultError as e:
        print("❌ 格式有问题，没有提交。请修改后再执行 submit：\n" + str(e))
        return 1
    raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    now = now_jst()
    slot = args.slot or slot_for(now)
    prefix = PREVIEW_PREFIX if args.preview else INBOX_PREFIX
    branch = f"{prefix}{now:%Y%m%d}-{slot}-{now:%H%M%S}"
    batch = {"slot": slot, "date": now.strftime("%Y-%m-%d"),
             "created_at": now.isoformat(timespec="seconds"), "items": items,
             "report": str(raw.get("report") or "")[:3000]}

    inbox = ROOT / "inbox" / "batch.json"
    inbox.parent.mkdir(exist_ok=True)
    inbox.write_text(json.dumps(batch, ensure_ascii=False, indent=1), encoding="utf-8")
    ident = ["-c", "user.name=HIKARI NEWS researcher", "-c", "user.email=researcher@hikari-news.invalid"]
    git("checkout", "-B", branch)
    git("add", "-f", "inbox/batch.json")
    git(*ident, "commit", "-m", f"inbox: {batch['date']} {slot} ({len(items)} items)")
    git("push", "origin", f"HEAD:refs/heads/{branch}")
    if args.preview:
        print(f"✅ 已提交 {len(items)} 条到预览分支 {branch}（不会发到 Discord）。")
    else:
        print(f"✅ 已提交 {len(items)} 条到分支 {branch}。发布会由 GitHub Actions 自动完成。")
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


def build_batch_embeds(items: list[dict], reminders: list[tuple[int, dict]]) -> list[dict]:
    embeds = []
    pick = max(items, key=lambda x: (x["importance"], bool(x.get("keywords")))) if items else None
    if pick:
        t = TASKS[pick["category"]]
        desc = md(pick["summary"])
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
        desc = "\n\n".join(item_line(it) for it in group)
        embeds.append({
            "title": f"{task['emoji']} {task['name']}（{len(group)}）",
            "description": desc[:4000],
            "color": int(task["color"], 16),
        })
    if reminders:
        lines = []
        for days, it in reminders:
            when = "**今日まで**" if days == 0 else f"**あと{days}日**"
            lines.append(f"{when}（{it['deadline'][5:].replace('-', '/')}）[{md(it['title'])}]({it['url']})")
        embeds.append({"title": "⏰ 締め切り間近", "description": "\n".join(lines)[:2000], "color": 0xE67E22})
    if CONFIG.get("site_url"):
        embeds.append({"description": f"📖 [詳しい要約・過去の記事はサイトで]({CONFIG['site_url']})", "color": 0x2B2D31})
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

def pending_branches() -> list[str]:
    git("fetch", "--prune", "origin", f"+refs/heads/{INBOX_PREFIX}*:refs/remotes/origin/{INBOX_PREFIX}*")
    out = git("for-each-ref", "--format=%(refname:short)", f"refs/remotes/origin/{INBOX_PREFIX}*")
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
    names = "・".join(TASKS[c]["name"] for c in cats) or "お知らせ"
    return f"📰 {day.month}/{day.day}（{WEEKDAYS_JA[day.weekday()]}）{CONFIG['slots'][slot]['label']}｜{names}"


def publish_batch(branch: str, state: dict, store, dry_run: bool) -> str:
    raw = git("show", f"origin/{branch}:inbox/batch.json")  # 只当作数据读取
    batch = json.loads(raw)
    items = validate(batch)
    slot = batch.get("slot") if batch.get("slot") in CONFIG["slots"] else slot_for(now_jst())
    day = date.fromisoformat(batch["date"]) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(batch.get("date"))) \
        else now_jst().date()

    known = {it["id"] for it in state["items"]}
    fresh = []
    for it in items:
        iid = item_id(it["url"])
        if iid in known:
            continue
        known.add(iid)
        task = TASKS[it["category"]]
        fresh.append({**it, "id": iid, "date": day.isoformat(), "slot": slot,
                      "category_name": task["name"], "emoji": task["emoji"],
                      "keywords": match_keywords(it)})

    reminders = due_reminders(state, day) if slot == "10" else []
    if fresh or reminders:
        cats = [t["id"] for t in CONFIG["tasks"] if any(it["category"] == t["id"] for it in fresh)]
        post_forum_thread(thread_title(day, slot, cats), build_batch_embeds(fresh, reminders), dry_run)

    if not dry_run:
        store.add_items([{**it, "reminded": []} for it in fresh])
    for it in fresh:
        state["items"].append({k: it[k] for k in ("id", "url", "title", "category", "importance",
                                                   "date", "slot", "deadline", "source", "note")}
                              | {"reminded": []})
    for days, it in reminders:
        it.setdefault("reminded", []).append(days)
    state["batches"].append({"branch": branch, "slot": slot, "date": day.isoformat(),
                             "count": len(fresh), "status": "ok"})
    return (f"✅ {day} {CONFIG['slots'][slot]['label']} 已发布：新内容 {len(fresh)} 条"
            f"（重复跳过 {len(items) - len(fresh)} 条），截止提醒 {len(reminders)} 条")


def weekly_digest(state: dict, now: datetime, dry_run: bool) -> str | None:
    conf = CONFIG["weekly_digest"]
    today = now.date()
    if today.weekday() != conf["weekday"] or slot_for(now) != conf["slot"] or state.get("last_weekly") == today.isoformat():
        return None
    start = today - timedelta(days=6)
    week = [it for it in state["items"] if start.isoformat() <= it["date"] <= today.isoformat()]
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
    if upcoming:
        lines = [f"**{it['deadline'][5:].replace('-', '/')}**　[{md(it['title'])}]({it['url']})" for it in upcoming[:10]]
        embeds.append({"title": "📅 これからの締め切り（2週間）", "description": "\n".join(lines)[:2000], "color": 0xE67E22})
    if CONFIG.get("site_url"):
        embeds.append({"description": f"📖 [今週の記事をサイトで見る]({CONFIG['site_url']})", "color": 0x2B2D31})
    title = f"📅 今週のまとめ {start.month}/{start.day}〜{today.month}/{today.day}"
    post_forum_thread(title, embeds, dry_run)
    state["last_weekly"] = today.isoformat()
    return f"📅 已发布每周汇总（精选 {len(top)} 条，截止日期 {len(upcoming)} 条）"


def missing_batch_warnings(state: dict, now: datetime) -> list[str]:
    """发布时间过了 40 分钟还没收到这一批的结果，就在日志频道提醒一次。"""
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
    return out


def cmd_publish_pending(args) -> int:
    from store import open_store

    now = now_jst()
    state = load_state()
    store = None if args.dry_run else open_store()
    notes, failed = [], False

    for branch in pending_branches():
        try:
            notes.append(publish_batch(branch, state, store, args.dry_run))
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
    notes += missing_batch_warnings(state, now)

    if store is not None:
        requests_ = store.new_access_requests()
        if requests_:
            names = "\n".join(f"・{u.get('name', '?')}（{str(u.get('note', ''))[:50]}）" for u in requests_)
            notes.append(f"🙋 有 {len(requests_)} 个新的浏览申请\n{names}\n"
                         f"去网站的「⚙️ 管理」批准：{CONFIG.get('site_url', '')}")
            store.mark_requests_notified([u["uid"] for u in requests_])
        store.save_meta({
            "updated": now.isoformat(timespec="minutes"),
            "keywords": CONFIG.get("keywords", []),
            "categories": [{"id": t["id"], "name": t["name"], "emoji": t["emoji"], "color": t["color"]}
                           for t in CONFIG["tasks"]],
        })
        store.flush()

    if notes:
        log("\n".join(notes), args.dry_run)
    if not args.dry_run:
        save_state(state)
    return 1 if failed else 0


# ======================================================================
# 预览：把一批结果渲染成「Discord 帖子 + 全文」的 HTML，给管理员确认效果
# ======================================================================

def _md_to_html(text: str) -> str:
    import html as H

    s = H.escape(text, quote=False)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank">\1</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\\([*_~`|>\\])", r"\1", s)
    return s.replace("\n", "<br>")


def load_batch(source: str) -> dict:
    if Path(source).exists():
        data = json.loads(Path(source).read_text(encoding="utf-8"))
        return data if "slot" in data else {"slot": None, "date": None, "items": data.get("items", []),
                                             "report": data.get("report", "")}
    branch = source.removeprefix("origin/")
    git("fetch", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}")
    return json.loads(git("show", f"origin/{branch}:inbox/batch.json"))


def cmd_preview(args) -> int:
    import html as H

    batch = load_batch(args.source)
    items = validate(batch)
    slot = batch.get("slot") or args.slot or slot_for(now_jst())
    day = date.fromisoformat(batch["date"]) if batch.get("date") else now_jst().date()
    known = {it["id"] for it in load_state()["items"]}
    rich = []
    for it in items:
        task = TASKS[it["category"]]
        rich.append({**it, "id": item_id(it["url"]), "category_name": task["name"], "emoji": task["emoji"],
                     "keywords": match_keywords(it), "dup": item_id(it["url"]) in known})
    cats = [t["id"] for t in CONFIG["tasks"] if any(it["category"] == t["id"] for it in rich)]
    title = thread_title(day, slot, cats)
    embeds = build_batch_embeds([it for it in rich if not it["dup"]], [])

    emb_html = "".join(
        f'<div class="embed" style="border-color:#{e.get("color", 0x2B2D31):06x}">'
        + (f'<div class="et">{"<a href=" + chr(34) + H.escape(e["url"]) + chr(34) + ">" if e.get("url") else ""}'
           f'{H.escape(e["title"])}{"</a>" if e.get("url") else ""}</div>' if e.get("title") else "")
        + f'<div class="ed">{_md_to_html(e.get("description", ""))}</div>'
        + (f'<div class="ef">{H.escape(e["footer"]["text"])}</div>' if e.get("footer") else "")
        + "</div>" for e in embeds)

    rows = []
    for it in sorted(rich, key=lambda x: (x["category"], -x["importance"])):
        meta = " ・ ".join(filter(None, [
            f"{it['emoji']} {it['category_name']}", "★" * it["importance"], it["level"],
            {"en": "英語", "ja": "日本語", "other": "その他"}.get(it["lang"] or "", ""),
            f"⏱{it['read_minutes']}分" if it["read_minutes"] else "", it["source"],
            f"⏰ {it['deadline']}" if it["deadline"] else "", "⚠️ 已推送过（正式发布时会跳过）" if it["dup"] else ""]))
        rows.append(
            f'<div class="card"><div class="meta">{H.escape(meta)}</div>'
            f'<h3><a href="{H.escape(it["url"])}" target="_blank">{H.escape(it["title"])}</a></h3>'
            f'<p>{H.escape(it["summary"])}</p><p class="note">💡 {H.escape(it["note"])}</p>'
            f'<div class="tags">{" ".join("#" + H.escape(t) for t in it["tags"])}</div></div>')

    report = batch.get("report") or "（なし）"
    page = f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>HIKARI NEWS 预览</title>
<style>
body{{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.6 "Noto Sans JP","Yu Gothic UI",system-ui,sans-serif}}
.wrap{{max-width:860px;margin:0 auto;padding:16px}} h1{{font-size:18px}} h2{{font-size:16px;margin-top:32px;color:#fff}}
a{{color:#00a8fc;text-decoration:none}} a:hover{{text-decoration:underline}}
.thread{{background:#2b2d31;border-radius:8px;padding:16px}} .tt{{font-size:17px;font-weight:700;color:#fff;margin-bottom:12px}}
.embed{{background:#232428;border-left:4px solid;border-radius:4px;padding:10px 14px;margin:8px 0}}
.et{{font-weight:700;color:#fff;margin-bottom:4px}} .ed{{font-size:14px}} .ef{{font-size:12px;color:#949ba4;margin-top:6px}}
code{{background:#1e1f22;border-radius:3px;padding:0 4px;font-size:12px}}
.card{{background:#2b2d31;border-radius:8px;padding:12px 16px;margin:10px 0}} .card h3{{margin:4px 0;font-size:16px}}
.meta,.tags{{font-size:12px;color:#949ba4}} .note{{color:#b5bac1}} pre{{white-space:pre-wrap;background:#2b2d31;padding:12px;border-radius:8px}}
</style></head><body><div class="wrap">
<h1>HIKARI NEWS 预览（没有发送到 Discord）</h1>
<p>{H.escape(str(day))} ／ slot {H.escape(str(slot))} ／ {len(rich)} 条</p>
<h2>① Discord 论坛帖子的样子</h2>
<div class="thread"><div class="tt">{H.escape(title)}</div>{emb_html}</div>
<h2>② 全文（网站上显示的内容）</h2>{"".join(rows)}
<h2>③ AI 的研究报告</h2><pre>{H.escape(report)}</pre>
</div></body></html>"""
    out = ROOT / "out" / f"preview-{day}-{slot}.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(f"✅ 预览已生成：{out}")
    return 0


# ======================================================================

def main() -> int:
    parser = argparse.ArgumentParser(description="HIKARI NEWS 工具")
    parser.add_argument("--slot", choices=list(CONFIG["slots"]), help="默认按日本时间自动判断")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("context")
    sub.add_parser("feeds")
    sub.add_parser("community")
    sub.add_parser("check").add_argument("file")
    p = sub.add_parser("submit")
    p.add_argument("file")
    p.add_argument("--preview", action="store_true", help="交到预览分支，不发到 Discord")
    sub.add_parser("publish-pending").add_argument("--dry-run", action="store_true")
    sub.add_parser("preview").add_argument("source", help="预览分支名（claude/preview-…）或结果 JSON 文件")
    args = parser.parse_args()
    return {"context": cmd_context, "feeds": cmd_feeds, "community": cmd_community, "check": cmd_check,
            "submit": cmd_submit, "publish-pending": cmd_publish_pending, "preview": cmd_preview}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
