"""社区内容收集：从各个社区的免费公开接口抓「候选内容」，作为 AI 研究的线索。

每个 fetch_* 函数都返回同样格式的候选列表：
    {"source": "Hacker News", "title": "...", "text": "...", "url": "...", "score": 123}
某个来源失败（网络错误、被限流）时只打印警告，不影响其他来源。
"""

from __future__ import annotations

import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import requests

UA = {"User-Agent": "hikari-news/1.0 (personal study project)"}
TIMEOUT = 20


def _get(url: str, **kw):
    r = requests.get(url, headers=UA, timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


def _clip(text: str, n: int = 400) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:n]


# ---------- Hacker News（英文，技术圈） ----------

def fetch_hackernews(cfg: dict) -> list[dict]:
    since = int(time.time()) - 36 * 3600
    out = []
    for q in cfg["queries"]:
        data = _get("https://hn.algolia.com/api/v1/search", params={
            "query": q, "tags": "story", "hitsPerPage": 15,
            "numericFilters": f"created_at_i>{since},points>{cfg.get('min_points', 30)}",
        }).json()
        for h in data["hits"]:
            out.append({
                "source": "Hacker News",
                "title": h.get("title") or "",
                "text": f"{h.get('points', 0)} points, {h.get('num_comments', 0)} comments",
                "url": h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}",
                "discussion": f"https://news.ycombinator.com/item?id={h['objectID']}",
                "score": h.get("points", 0),
            })
    return out


# ---------- Reddit（英文，用 RSS 读取每个版块的当日热门） ----------

def fetch_reddit(cfg: dict) -> list[dict]:
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for i, sub in enumerate(cfg["subreddits"]):
        if i:
            time.sleep(4)  # Reddit 限流很严，每个版块之间等几秒
        try:
            xml = _get(f"https://www.reddit.com/r/{sub}/top/.rss", params={"t": "day", "limit": 10}).text
        except requests.RequestException as e:
            print(f"  警告：Reddit r/{sub} 读取失败（跳过）：{e}", file=sys.stderr)
            continue
        for e in ET.fromstring(xml).findall("a:entry", ns)[:10]:
            link = e.find("a:link", ns)
            out.append({
                "source": f"Reddit r/{sub}",
                "title": e.findtext("a:title", "", ns),
                "text": _clip(e.findtext("a:content", "", ns)),
                "url": link.get("href") if link is not None else "",
                "score": 0,
            })
    return out


# ---------- Qiita（日文，技术文章） ----------

def fetch_qiita(cfg: dict) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%d")
    out = []
    headers = dict(UA)
    if os.environ.get("QIITA_TOKEN"):  # 可选：有 token 时限流更宽松
        headers["Authorization"] = f"Bearer {os.environ['QIITA_TOKEN']}"
    for tag in cfg["tags"]:
        r = requests.get("https://qiita.com/api/v2/items", headers=headers, timeout=TIMEOUT, params={
            "query": f"tag:{tag} created:>={since} stocks:>={cfg.get('min_stocks', 5)}",
            "per_page": 10,
        })
        r.raise_for_status()
        for it in r.json():
            out.append({
                "source": "Qiita",
                "title": it["title"],
                "text": _clip(it.get("body", "")),
                "url": it["url"],
                "score": it.get("stocks_count", 0) or it.get("likes_count", 0),
            })
    return out


# ---------- Zenn（日文，技术文章） ----------

def fetch_zenn(cfg: dict) -> list[dict]:
    out = []
    for topic in cfg["topics"]:
        data = _get("https://zenn.dev/api/articles", params={"topicname": topic, "order": "daily"}).json()
        for a in data.get("articles", [])[:10]:
            out.append({
                "source": "Zenn",
                "title": a["title"],
                "text": f"いいね {a.get('liked_count', 0)}",
                "url": "https://zenn.dev" + a["path"],
                "score": a.get("liked_count", 0),
            })
    return out


# ---------- Bluesky（英文/日文，帖子） ----------

def fetch_bluesky(cfg: dict) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = []
    for q in cfg["queries"]:
        data = _get("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts", params={
            "q": q, "sort": "top", "since": since, "limit": 15,
        }).json()
        for p in data.get("posts", []):
            handle = p["author"]["handle"]
            rkey = p["uri"].rsplit("/", 1)[-1]
            likes = p.get("likeCount", 0)
            if likes < cfg.get("min_likes", 10):
                continue
            out.append({
                "source": f"Bluesky @{handle}",
                "title": _clip(p["record"].get("text", ""), 80),
                "text": _clip(p["record"].get("text", "")),
                "url": f"https://bsky.app/profile/{handle}/post/{rkey}",
                "score": likes,
            })
    return out


FETCHERS = {
    "hackernews": fetch_hackernews,
    "reddit": fetch_reddit,
    "qiita": fetch_qiita,
    "zenn": fetch_zenn,
    "bluesky": fetch_bluesky,
}


def collect_candidates(sources_cfg: dict, per_source: int = 15) -> list[dict]:
    """从所有启用的来源收集候选。每个来源按热度取前 per_source 条，避免某个来源占满。"""
    seen, out = set(), []
    for name, fn in FETCHERS.items():
        conf = sources_cfg.get(name)
        if not conf or not conf.get("enabled", True):
            continue
        try:
            got = fn(conf)
            print(f"  {name}: {len(got)} 条候选")
        except Exception as e:
            print(f"  警告：{name} 收集失败（跳过）：{e}", file=sys.stderr)
            continue
        got.sort(key=lambda c: -c["score"])
        for c in got[:per_source]:
            if c["url"] and c["url"] not in seen:
                seen.add(c["url"])
                out.append(c)
    return out


# ======================================================================
# 优质网站的 RSS / Atom（研究的第一手候选）
# ======================================================================

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "rss1": "http://purl.org/rss/1.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "media": "http://search.yahoo.com/mrss/",
}


def _parse_date(text: str | None):
    from email.utils import parsedate_to_datetime

    if not text:
        return None
    text = text.strip()
    try:
        d = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _parse_feed(xml: bytes) -> list[dict]:
    """支持 RSS 2.0、RSS 1.0 (RDF)、Atom。返回 [{title, url, published, text}]。"""
    root = ET.fromstring(xml)
    out = []
    for it in root.iter("item"):  # RSS 2.0
        out.append({
            "title": it.findtext("title") or "",
            "url": (it.findtext("link") or "").strip(),
            "published": _parse_date(it.findtext("pubDate") or it.findtext("dc:date", namespaces=NS)),
            "text": it.findtext("description") or "",
        })
    for it in root.iter(f"{{{NS['rss1']}}}item"):  # RSS 1.0
        out.append({
            "title": it.findtext("rss1:title", "", NS),
            "url": it.findtext("rss1:link", "", NS).strip(),
            "published": _parse_date(it.findtext("dc:date", namespaces=NS)),
            "text": it.findtext("rss1:description", "", NS),
        })
    for it in root.iter(f"{{{NS['atom']}}}entry"):  # Atom（含 YouTube）
        link = ""
        for ln in it.findall("atom:link", NS):
            if ln.get("rel", "alternate") == "alternate":
                link = ln.get("href", "")
                break
        text = it.findtext("atom:summary", "", NS) or it.findtext("media:group/media:description", "", NS)
        out.append({
            "title": it.findtext("atom:title", "", NS),
            "url": link,
            "published": _parse_date(it.findtext("atom:published", None, NS) or it.findtext("atom:updated", None, NS)),
            "text": text,
        })
    return out


def fetch_feed(feed: dict) -> list[dict]:
    xml = _get(feed["url"]).content
    since = datetime.now(timezone.utc) - timedelta(hours=feed.get("max_age_hours", 48))
    items = [e for e in _parse_feed(xml) if e["url"] and e["published"] and e["published"] >= since]
    items.sort(key=lambda e: e["published"], reverse=True)
    return [{
        "source": feed["name"],
        "title": _clip(e["title"], 150),
        "url": e["url"],
        "published": e["published"],
        "text": _clip(e["text"], 220),
    } for e in items[: feed.get("max_items", 12)]]


def collect_feeds(feeds: list[dict]) -> dict[str, list[dict]]:
    """并行读取多个 RSS。返回 {来源名: [条目…]}，失败的来源返回空列表并打印警告。"""
    from concurrent.futures import ThreadPoolExecutor

    def one(feed):
        try:
            return feed["name"], fetch_feed(feed)
        except Exception as e:
            print(f"  警告：{feed['name']} 读取失败（跳过）：{e}", file=sys.stderr)
            return feed["name"], []

    with ThreadPoolExecutor(max_workers=8) as pool:
        return dict(pool.map(one, feeds))
