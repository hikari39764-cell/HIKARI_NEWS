"""数据保存：正式运行时存进 Firebase Firestore，本地测试时存进 local_data.json。

设置了环境变量 FIREBASE_SERVICE_ACCOUNT_B64（服务账号密钥 JSON 的 base64）
或 FIREBASE_SERVICE_ACCOUNT（JSON 全文）就用 Firestore，否则用本地 JSON 文件。
注意：任何情况下都不要把这些值打印出来。

Firestore 的结构：
  items/{id}            新闻条目（分区新闻也在这里，带 section 字段）
  meta/site             分类、关键词、最后更新时间
  learn/kw_{area}       技术关键词图鉴      {items: [...]}
  learn/quiz_{topic}    题库（按 topic）    {items: [...]}
  learn/ideas           アイデアガチャ词库  {genre: [...], mechanic: [...], ...}
  learn/daily           今日のお題          {date, theme}
  learn/themes          お題的历史          {items: [...]}
  reports/{id}          用户回报的问题题目  {qid, topic, track, q, reason, uid, status}
  users/{uid}           浏览申请
  users/{uid}/progress  学习进度（网站端读写）
  admins/{uid}          管理员
"""

import base64
import json
import os
from pathlib import Path

LOCAL_PATH = Path(__file__).parent / "local_data.json"


def open_store():
    if os.environ.get("FIREBASE_SERVICE_ACCOUNT_B64"):
        raw = base64.b64decode(os.environ["FIREBASE_SERVICE_ACCOUNT_B64"]).decode("utf-8")
        return FirestoreStore(json.loads(raw))
    if os.environ.get("FIREBASE_SERVICE_ACCOUNT"):
        return FirestoreStore(json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"]))
    print("（没有设置 Firebase 密钥，使用本地 local_data.json）")
    return JsonStore(LOCAL_PATH)


class JsonStore:
    """本地测试用。结构和 Firestore 相同，方便网站的演示模式直接读取。"""

    def __init__(self, path: Path):
        self.path = path
        self.data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.data.setdefault("items", [])
        self.data.setdefault("meta", {})
        self.data.setdefault("learn", {})

    def _bundle(self, doc: str) -> list:
        return self.data["learn"].setdefault(doc, {}).setdefault("items", [])

    def add_items(self, items):
        self.data["items"].extend(items)

    def add_keywords(self, area, entries):
        self._bundle(f"kw_{area}").extend(entries)

    def add_quiz(self, topic, entries):
        self._bundle(f"quiz_{topic}").extend(entries)

    def fix_quiz(self, topic, qid, replacement):
        items = self._bundle(f"quiz_{topic}")
        items[:] = [q for q in items if q.get("id") != qid]
        if replacement:
            self._bundle(f"quiz_{replacement['topic']}").append(replacement)

    def set_theme(self, day, theme):
        self.data["learn"]["daily"] = {"date": day, "theme": theme}
        self._bundle("themes").append({"date": day, **theme})

    def add_ideas(self, pools):
        doc = self.data["learn"].setdefault("ideas", {})
        for pool, words in pools.items():
            cur = doc.setdefault(pool, [])
            cur.extend(w for w in words if w not in cur)

    def save_meta(self, meta):
        self.data["meta"] = meta

    def new_access_requests(self):
        return []

    def mark_requests_notified(self, uids):
        pass

    def new_reports(self):
        return []

    def mark_reports(self, ids, status):
        pass

    def new_contacts(self):
        return []

    def mark_contacts(self, ids):
        pass

    def subscribers(self):
        return self.data.get("subscribers", [])   # ローカルの試験用

    def disable_webhook(self, uid):
        for s in self.data.get("subscribers", []):
            if s.get("uid") == uid:
                s["webhook_on"] = False

    def flush(self):
        self.data["items"] = self.data["items"][-3000:]
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")


class FirestoreStore:
    def __init__(self, service_account: dict):
        import firebase_admin
        from firebase_admin import credentials, firestore

        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(service_account))
        self.db = firestore.client()
        self.fs = firestore

    # ---------------------------------------------------------------- items
    def add_items(self, items):
        if not items:
            return
        batch = self.db.batch()
        for it in items:
            batch.set(self.db.collection("items").document(it["id"]), {**it, "createdAt": self.fs.SERVER_TIMESTAMP})
        batch.commit()

    def save_meta(self, meta):
        self.db.collection("meta").document("site").set(meta)

    # ---------------------------------------------------------------- learn
    def _append(self, doc: str, entries: list):
        if entries:
            self.db.collection("learn").document(doc).set(
                {"items": self.fs.ArrayUnion(entries), "updated": self.fs.SERVER_TIMESTAMP}, merge=True)

    def add_keywords(self, area, entries):
        self._append(f"kw_{area}", entries)

    def add_quiz(self, topic, entries):
        self._append(f"quiz_{topic}", entries)

    def fix_quiz(self, topic, qid, replacement):
        ref = self.db.collection("learn").document(f"quiz_{topic}")
        snap = ref.get()
        items = (snap.to_dict() or {}).get("items", []) if snap.exists else []
        ref.set({"items": [q for q in items if q.get("id") != qid], "updated": self.fs.SERVER_TIMESTAMP}, merge=True)
        if replacement:
            self._append(f"quiz_{replacement['topic']}", [replacement])

    def set_theme(self, day, theme):
        self.db.collection("learn").document("daily").set({"date": day, "theme": theme})
        self._append("themes", [{"date": day, **theme}])

    def add_ideas(self, pools):
        data = {pool: self.fs.ArrayUnion(words) for pool, words in pools.items() if words}
        if data:
            self.db.collection("learn").document("ideas").set(data, merge=True)

    # -------------------------------------------------------------- reports
    def new_reports(self):
        q = self.db.collection("reports").where("status", "==", "new")
        return [{"id": d.id, **{k: v for k, v in d.to_dict().items() if k in ("qid", "topic", "track", "q", "reason")}}
                for d in q.stream()]

    def mark_reports(self, ids, status):
        for i in ids:
            ref = self.db.collection("reports").document(i)
            if ref.get().exists:
                ref.update({"status": status})

    # ------------------------------------------------- 掲載の取り下げ・訂正の依頼
    def new_contacts(self):
        q = self.db.collection("contacts").where("status", "==", "new")
        return [{"id": d.id, **{k: v for k, v in d.to_dict().items() if k in ("kind", "url", "message", "contact")}}
                for d in q.stream()]

    def mark_contacts(self, ids):
        for i in ids:
            self.db.collection("contacts").document(i).update({"status": "notified"})

    # ------------------------------------------------ 受け取り設定（メール・Discord）
    def subscribers(self):
        out = []
        for d in self.db.collection("subscriptions").stream():
            s = d.to_dict() or {}
            out.append({"uid": d.id, "email": s.get("email") or "", "email_on": bool(s.get("email_on")),
                        "email_mode": s.get("email_mode") or "each", "webhook": s.get("webhook") or "",
                        "webhook_on": bool(s.get("webhook_on"))})
        return out

    def disable_webhook(self, uid):
        """Webhook が消されていた（404 など）ときは、その人への Discord 配信を止める。"""
        self.db.collection("subscriptions").document(uid).update({"webhook_on": False})

    # --------------------------------------------------------------- users
    def new_access_requests(self):
        q = self.db.collection("users").where("status", "==", "pending")
        docs = [{"uid": d.id, **d.to_dict()} for d in q.stream()]
        return [u for u in docs if not u.get("notified")]

    def mark_requests_notified(self, uids):
        for uid in uids:
            self.db.collection("users").document(uid).update({"notified": True})

    def flush(self):
        pass  # Firestore 是即时写入的
