"""HIKARI NEWS 的工具脚本。定时任务里的 Claude 按 RESEARCH.md 的步骤调用它。

    python radar.py context              今天要研究什么：任务、关键词、最近推送过的链接
    python radar.py community            从各社区抓热门候选（研究线索）
    python radar.py check out/results.json     只检查结果格式，不发布
    python radar.py publish out/results.json   检查 → 推送 Discord → 写入 Firebase
    python radar.py publish out/results.json --dry-run   只打印要推送的内容

环境变量（在云端环境里设置）:
    DISCORD_WEBHOOK_URL            Discord 频道的 Webhook URL
    FIREBASE_SERVICE_ACCOUNT_B64   Firebase 服务账号密钥 JSON 的 base64
没有设置 Firebase 时会使用本地的 local_data.json（方便测试）。
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
JST = timezone(timedelta(hours=CONFIG["timezone_offset_hours"]))
DISCORD_LIMIT = 1900
LEVELS = ("入門", "中級", "上級")
JA_CHARS = re.compile(r"[぀-ヿ一-鿿]")

# Windows 终端也能正常显示日文
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


# ---------- 共用 ----------

def now_jst() -> datetime:
    return datetime.now(JST)


def current_slot(now: datetime) -> str:
    return "am" if now.hour < 14 else "pm"


def tasks_for(now: datetime, slot: str) -> list[dict]:
    return [t for t in CONFIG["tasks"] if now.weekday() in t["when"].get(slot, [])]


def normalize_url(url: str) -> str:
    p = urlsplit(url.strip())
    query = "&".join(q for q in p.query.split("&") if q and not q.startswith("utm_"))
    return urlunsplit((p.scheme, p.netloc.lower(), p.path.rstrip("/"), query, ""))


def item_id(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode()).hexdigest()[:16]


def match_keywords(item: dict) -> list[str]:
    text = " ".join([item["title"], item["summary"], item["note"], *item["tags"]]).lower()
    return [k for k in CONFIG.get("keywords", []) if k.lower() in text]


# ---------- context ----------

def cmd_context(args) -> int:
    from store import open_store

    now = now_jst()
    slot = args.slot or current_slot(now)
    tasks = tasks_for(now, slot)
    store = open_store()
    recent = store.recent_urls(200)

    print(f"# 本次运行：{now:%Y-%m-%d %H:%M} JST（{'朝' if slot == 'am' else '夜'} / slot={slot}）\n")
    print(f"读者：{CONFIG['reader']}\n")
    print(f"关注关键词（找到相关内容时优先）：{'、'.join(CONFIG.get('keywords', [])) or '无'}\n")
    print("## 今天要做的任务")
    if not tasks:
        print("（今天这个时段没有任务。直接结束即可。）")
    for t in tasks:
        print(f"\n### category = \"{t['id']}\"  {t['emoji']} {t['name']}（最多 {t['max_items']} 条）")
        print(t["brief"])
    print("\n## 已经推送过的链接（不要再选，也不要选同一件事的其他报道）")
    print("\n".join(recent) if recent else "（无）")
    return 0


# ---------- community ----------

def cmd_community(args) -> int:
    from collectors import collect_candidates

    cands = collect_candidates(CONFIG["community"])
    print(f"\n# 社区候选 {len(cands)} 条（按来源分组，score = 点赞/分数）\n")
    for c in cands:
        print(f"- [{c['source']}] {c['title']}  (score {c['score']})")
        print(f"  {c['url']}")
        if c.get("text"):
            print(f"  {c['text'][:200]}")
    return 0


# ---------- check / publish ----------

class ResultError(Exception):
    pass


def validate(path: Path, slot: str) -> list[dict]:
    """检查 results.json。有问题就抛出 ResultError，并说明要怎么改。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ResultError(f"无法读取 JSON：{e}")
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise ResultError('最外层必须是 {"items": [...]}')

    valid_ids = {t["id"]: t for t in CONFIG["tasks"]}
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
        if cat not in valid_ids:
            errors.append(f"{where}：category 必须是 {list(valid_ids)} 之一")
        if not url.startswith(("http://", "https://")):
            errors.append(f"{where}：url 必须是 http(s) 链接")
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
        clean.append({
            "category": cat,
            "title": title[:200],
            "summary": summary[:600],
            "url": url,
            "source": str(it.get("source") or urlsplit(url).netloc)[:80],
            "tags": [str(t)[:30] for t in tags][:5],
            "note": str(it.get("note") or "").strip()[:300],
            "importance": importance,
            "level": it.get("level") if it.get("level") in LEVELS else None,
            "deadline": str(deadline) if deadline else None,
        })

    for cat, task in valid_ids.items():
        count = sum(1 for c in clean if c["category"] == cat)
        if count > task["max_items"]:
            errors.append(f"category {cat} 最多 {task['max_items']} 条，现在有 {count} 条")
    if errors:
        raise ResultError("\n".join(errors))
    return clean


def cmd_check(args) -> int:
    try:
        items = validate(Path(args.file), args.slot or current_slot(now_jst()))
    except ResultError as e:
        print("❌ 格式有问题，请修改后再检查：\n" + str(e))
        return 1
    print(f"✅ 格式正确，共 {len(items)} 条")
    return 0


def format_discord(task: dict, items: list[dict], label: str) -> str:
    stars = "★★★★★"
    lines = [f"## {task['emoji']} {task['name']}（{label}）"]
    for i, it in enumerate(sorted(items, key=lambda x: -x["importance"]), 1):
        badge = f" `{it['level']}`" if it["level"] else ""
        lines.append(f"**{i}. {it['title']}** {stars[:it['importance']]}{badge}")
        lines.append(it["summary"])
        if it["note"]:
            lines.append(f"💡 {it['note']}")
        if it["deadline"]:
            lines.append(f"⏰ 締め切り：{it['deadline']}")
        if it["keywords"]:
            lines.append(f"🔔 キーワード：{'、'.join(it['keywords'])}")
        lines.append(f"<{it['url']}>")
        lines.append("")
    if CONFIG.get("site_url"):
        lines.append(f"🔗 まとめサイト：<{CONFIG['site_url']}>")
    return "\n".join(lines)


def split_for_discord(text: str) -> list[str]:
    chunks, cur = [], ""
    for line in text.splitlines(keepends=True):
        if len(cur) + len(line) > DISCORD_LIMIT and cur:
            chunks.append(cur)
            cur = ""
        cur += line
    if cur.strip():
        chunks.append(cur)
    return chunks


def post_discord(text: str, dry_run: bool) -> None:
    if dry_run:
        print("----- Discord（dry-run）-----\n" + text)
        return
    import requests

    url = os.environ.get("DISCORD_WEBHOOK_URL")
    if not url:
        raise RuntimeError("没有设置 DISCORD_WEBHOOK_URL")
    for chunk in split_for_discord(text):
        # flags=4：不展开链接预览；allowed_mentions：禁止 @everyone 之类的提及
        r = requests.post(url, timeout=30, json={
            "content": chunk, "flags": 4, "allowed_mentions": {"parse": []},
        })
        if r.status_code >= 400:
            raise RuntimeError(f"Discord 推送失败：HTTP {r.status_code}")


def cmd_publish(args) -> int:
    from store import open_store

    now = now_jst()
    slot = args.slot or current_slot(now)
    try:
        items = validate(Path(args.file), slot)
    except ResultError as e:
        print("❌ 格式有问题，没有发布。请修改后再执行 publish：\n" + str(e))
        return 1

    store = open_store()
    known = store.known_ids()
    today = now.strftime("%Y-%m-%d")
    label = f"{today} {'朝' if slot == 'am' else '夜'}"
    fresh = []
    for it in items:
        iid = item_id(it["url"])
        if iid in known:
            print(f"跳过（之前推送过）：{it['title']}")
            continue
        known.add(iid)
        task = next(t for t in CONFIG["tasks"] if t["id"] == it["category"])
        fresh.append({**it, "id": iid, "date": today, "slot": slot,
                      "category_name": task["name"], "emoji": task["emoji"],
                      "keywords": match_keywords(it), "reminded": False})

    for task in CONFIG["tasks"]:
        group = [it for it in fresh if it["category"] == task["id"]]
        if group:
            post_discord(format_discord(task, group, label), args.dry_run)

    # 截止日期提醒（早上那次）
    due = store.due_reminders(now.date(), CONFIG["reminder_days"]) if slot == "am" else []
    due_new = [it for it in fresh if it["deadline"] and
               today <= it["deadline"] <= (now.date() + timedelta(days=CONFIG["reminder_days"])).isoformat()]
    reminders = sorted({it["id"]: it for it in due + due_new}.values(), key=lambda x: x["deadline"])
    if reminders:
        text = "## ⏰ 締め切りが近いチャンス\n" + "\n".join(
            f"**{it['deadline']}**　{it['title']}\n<{it['url']}>" for it in reminders)
        post_discord(text, args.dry_run)

    # 新的浏览申请通知
    requests_ = store.new_access_requests()
    if requests_:
        names = "\n".join(f"・{u.get('name', '?')}（{u.get('note', '')[:50]}）" for u in requests_)
        link = f"\n<{CONFIG['site_url']}>" if CONFIG.get("site_url") else ""
        post_discord(f"## 🙋 新しい閲覧申請が {len(requests_)} 件あります\n{names}{link}", args.dry_run)

    if args.dry_run:
        print(f"\n（dry-run：没有写入数据库）新条目 {len(fresh)} 条")
        return 0

    store.add_items(fresh)
    store.mark_reminded([it["id"] for it in reminders])
    store.mark_requests_notified([u["uid"] for u in requests_])
    store.save_meta({
        "updated": now.isoformat(timespec="minutes"),
        "keywords": CONFIG.get("keywords", []),
        "categories": [{"id": t["id"], "name": t["name"], "emoji": t["emoji"]} for t in CONFIG["tasks"]],
    })
    store.flush()
    print(f"✅ 发布完成：新条目 {len(fresh)} 条，提醒 {len(reminders)} 条，新申请 {len(requests_)} 件")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="HIKARI NEWS 工具")
    parser.add_argument("--slot", choices=["am", "pm"], help="默认按日本时间自动判断")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("context")
    sub.add_parser("community")
    for name in ("check", "publish"):
        p = sub.add_parser(name)
        p.add_argument("file")
        if name == "publish":
            p.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    return {"context": cmd_context, "community": cmd_community,
            "check": cmd_check, "publish": cmd_publish}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
