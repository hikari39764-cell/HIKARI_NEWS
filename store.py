"""数据保存：正式运行时存进 Firebase Firestore，本地测试时存进 local_data.json。

设置了环境变量 FIREBASE_SERVICE_ACCOUNT_B64（服务账号密钥 JSON 的 base64）
或 FIREBASE_SERVICE_ACCOUNT（JSON 全文）就用 Firestore，
否则自动用本地 JSON 文件，方便在没有 Firebase 的情况下测试。
注意：任何情况下都不要把这些值打印出来。
"""

import base64
import json
import os
from datetime import date, timedelta
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
    def __init__(self, path: Path):
        self.path = path
        self.data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"items": [], "meta": {}}

    def known_ids(self) -> set[str]:
        return {it["id"] for it in self.data["items"]}

    def recent_urls(self, n: int) -> list[str]:
        return [it["url"] for it in self.data["items"][-n:]]

    def add_items(self, items: list[dict]) -> None:
        self.data["items"].extend(items)

    def due_reminders(self, today: date, days: int) -> list[dict]:
        end = (today + timedelta(days=days)).isoformat()
        return [it for it in self.data["items"]
                if it.get("deadline") and today.isoformat() <= it["deadline"] <= end
                and not it.get("reminded")]

    def mark_reminded(self, ids: list[str]) -> None:
        for it in self.data["items"]:
            if it["id"] in ids:
                it["reminded"] = True

    def save_meta(self, meta: dict) -> None:
        self.data["meta"] = meta

    def new_access_requests(self) -> list[dict]:
        return []  # 本地模式没有用户

    def mark_requests_notified(self, uids: list[str]) -> None:
        pass

    def flush(self) -> None:
        self.data["items"] = self.data["items"][-3000:]
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")


class FirestoreStore:
    """Firestore 的结构：
    items/{id}      每条内容
    meta/site       分类、关键词、最后更新时间
    users/{uid}     浏览申请（status: pending / approved / rejected）
    admins/{uid}    管理员（你自己，手动在控制台建一次）
    """

    def __init__(self, service_account: dict):
        import firebase_admin
        from firebase_admin import credentials, firestore

        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(service_account))
        self.db = firestore.client()
        self.fs = firestore

    def known_ids(self) -> set[str]:
        return {ref.id for ref in self.db.collection("items").list_documents()}

    def recent_urls(self, n: int) -> list[str]:
        q = self.db.collection("items").order_by(
            "createdAt", direction=self.fs.Query.DESCENDING).limit(n)
        return [d.to_dict().get("url") for d in q.stream()]

    def add_items(self, items: list[dict]) -> None:
        batch = self.db.batch()
        for it in items:
            batch.set(self.db.collection("items").document(it["id"]),
                      {**it, "createdAt": self.fs.SERVER_TIMESTAMP})
        batch.commit()

    def due_reminders(self, today: date, days: int) -> list[dict]:
        end = (today + timedelta(days=days)).isoformat()
        q = (self.db.collection("items")
             .where("deadline", ">=", today.isoformat())
             .where("deadline", "<=", end))
        docs = [d.to_dict() for d in q.stream()]
        return [it for it in docs if not it.get("reminded")]

    def mark_reminded(self, ids: list[str]) -> None:
        for i in ids:
            self.db.collection("items").document(i).update({"reminded": True})

    def save_meta(self, meta: dict) -> None:
        self.db.collection("meta").document("site").set(meta)

    def new_access_requests(self) -> list[dict]:
        q = self.db.collection("users").where("status", "==", "pending")
        docs = [{"uid": d.id, **d.to_dict()} for d in q.stream()]
        return [u for u in docs if not u.get("notified")]

    def mark_requests_notified(self, uids: list[str]) -> None:
        for uid in uids:
            self.db.collection("users").document(uid).update({"notified": True})

    def flush(self) -> None:
        pass  # Firestore 是即时写入的
