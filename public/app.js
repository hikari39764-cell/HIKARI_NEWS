import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const PAGE_SIZE = 300;   // 一度に Firestore から読む記事数（無料枠の読み取り回数を節約）
const SHOW_STEP = 40;    // 画面に一度に表示する数

const $ = id => document.getElementById(id);
const VIEWS = ["loading", "setup", "login", "apply", "pending", "rejected", "main", "admin"];
function show(view) {
  VIEWS.forEach(v => $("view-" + v).hidden = v !== view);
  $("tabs").hidden = !["main", "admin"].includes(view);
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https?:\/\//.test(u || "") ? u : "#";
const todayStr = () => new Date().toLocaleDateString("sv-SE");

const state = {
  cat: "all", tag: null, q: "", sort: "new", shown: SHOW_STEP, isAdmin: false,
  bookmarks: new Set(store.get("bookmarks", [])), read: new Set(store.get("read", [])),
};
let DATA = { items: [], categories: [], keywords: [] };
let loadMore = null;   // さらに古い記事を読み込む関数（Firestore のときだけ）

// ---------------- 記事一覧 ----------------

function kwOf(it) {
  const text = [it.title, it.summary, it.note, ...(it.tags || [])].join(" ").toLowerCase();
  return DATA.keywords.filter(k => text.includes(k.toLowerCase()));
}
function inCat(it) {
  if (state.cat === "all") return true;
  if (state.cat === "bookmarks") return state.bookmarks.has(it.id);
  if (state.cat === "kw") return kwOf(it).length > 0;
  return it.category === state.cat;
}
function filtered() {
  const q = state.q.toLowerCase();
  const items = DATA.items.filter(it => inCat(it) &&
    (!state.tag || (state.cat === "kw" ? kwOf(it) : (it.tags || [])).includes(state.tag)) &&
    (!q || [it.title, it.summary, it.note, it.source, ...(it.tags || [])].join(" ").toLowerCase().includes(q)));
  items.sort(state.sort === "imp"
    ? (a, b) => b.importance - a.importance || b.date.localeCompare(a.date)
    : (a, b) => b.date.localeCompare(a.date) || (b.slot || "").localeCompare(a.slot || "") || b.importance - a.importance);
  return items;
}

function card(it) {
  const past = it.deadline && it.deadline < todayStr();
  const kws = kwOf(it);
  return `<article class="card ${state.read.has(it.id) ? "read" : ""}">
    <div class="meta">
      <span class="cat">${esc(it.emoji)} ${esc(it.category_name)}</span>
      ${kws.length ? `<span class="kw">🔔 ${kws.map(esc).join("・")}</span>` : ""}
      <span class="stars" title="おすすめ度">${"★".repeat(it.importance || 0)}</span>
      ${it.level ? `<span class="lvl">${esc(it.level)}</span>` : ""}
      <span>${esc(it.source)}</span>
    </div>
    <h3><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" data-id="${esc(it.id)}">${esc(it.title)}</a></h3>
    <p>${esc(it.summary)}</p>
    ${it.note ? `<p class="note">💡 ${esc(it.note)}</p>` : ""}
    ${it.deadline ? `<p class="deadline ${past ? "past" : ""}">⏰ 締め切り：${esc(it.deadline)}${past ? "（終了）" : ""}</p>` : ""}
    <div class="foot">
      <span class="tags">${(it.tags || []).map(t => "#" + esc(t)).join(" ")}</span>
      <button class="bm ${state.bookmarks.has(it.id) ? "on" : ""}" data-bm="${esc(it.id)}"
        title="あとで読む">${state.bookmarks.has(it.id) ? "★" : "☆"}</button>
    </div>
  </article>`;
}

function renderList() {
  const items = filtered();
  const el = $("list");
  if (!items.length) {
    el.innerHTML = `<div class="empty">${DATA.items.length ? "条件に合う記事がありません" : "まだ記事がありません。最初の配信を待ってください。"}</div>`;
  } else {
    let html = "", lastDay = null;
    for (const it of items.slice(0, state.shown)) {
      if (state.sort === "new" && it.date !== lastDay) { html += `<div class="day">${esc(it.date)}</div>`; lastDay = it.date; }
      html += card(it);
    }
    if (items.length > state.shown) {
      html += `<button class="btn more" id="more">もっと見る（残り ${items.length - state.shown} 件）</button>`;
    } else if (loadMore) {
      html += `<button class="btn more" id="older">さらに古い記事を読み込む</button>`;
    }
    el.innerHTML = html;
  }
}

function renderTabs() {
  const tabs = [{ id: "all", label: "すべて" },
    ...(DATA.keywords.length ? [{ id: "kw", label: "🔔 注目キーワード" }] : []),
    ...DATA.categories.map(c => ({ id: c.id, label: `${c.emoji} ${c.name}` })),
    { id: "bookmarks", label: `★ あとで読む (${state.bookmarks.size})` },
    ...(state.isAdmin ? [{ id: "admin", label: "⚙️ 管理" }] : [])];
  $("tabs").innerHTML = tabs.map(t =>
    `<button class="tab ${state.cat === t.id ? "on" : ""}" data-cat="${esc(t.id)}">${esc(t.label)}</button>`).join("");
}

function renderChips() {
  const count = {};
  const keysOf = state.cat === "kw" ? kwOf : it => it.tags || [];
  DATA.items.filter(inCat).forEach(it => keysOf(it).forEach(t => count[t] = (count[t] || 0) + 1));
  const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 18);
  $("chips").innerHTML = top.map(([t, n]) =>
    `<button class="chip ${state.tag === t ? "on" : ""}" data-tag="${esc(t)}">#${esc(t)} ${n}</button>`).join("");
}

function renderDeadlines() {
  const today = todayStr();
  const list = DATA.items.filter(it => it.deadline && it.deadline >= today)
    .sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 10);
  $("deadlines").innerHTML = list.length
    ? list.map(it => {
        const days = Math.round((new Date(it.deadline) - new Date(today)) / 864e5);
        return `<a class="dl" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer">
          <b>${esc(it.deadline)}（あと${days}日）</b>${esc(it.title)}</a>`;
      }).join("")
    : `<p class="note">今のところありません</p>`;
}

function render() {
  renderTabs();
  if (state.cat === "admin") { show("admin"); return; }
  show("main");
  renderChips(); renderList(); renderDeadlines();
}

function setData(items, meta) {
  DATA = { items, categories: meta.categories || [], keywords: meta.keywords || [] };
  if (meta.updated) $("updated").textContent = "最終更新：" + String(meta.updated).replace("T", " ").slice(0, 16);
}

// ---------------- 操作 ----------------

let adminApi = null;

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-cat],[data-tag],[data-bm],[data-act],#more,#older,a[data-id]");
  if (!t) return;
  if (t.dataset.cat) {
    state.cat = t.dataset.cat; state.tag = null; state.shown = SHOW_STEP;
    if (state.cat === "admin" && adminApi) await adminApi.render();
    render();
  } else if (t.dataset.tag) {
    state.tag = state.tag === t.dataset.tag ? null : t.dataset.tag; state.shown = SHOW_STEP; render();
  } else if (t.dataset.bm) {
    const id = t.dataset.bm;
    state.bookmarks.has(id) ? state.bookmarks.delete(id) : state.bookmarks.add(id);
    store.set("bookmarks", [...state.bookmarks]); render();
  } else if (t.id === "more") {
    state.shown += SHOW_STEP; renderList();
  } else if (t.id === "older" && loadMore) {
    t.disabled = true; await loadMore(); state.shown += SHOW_STEP; render();
  } else if (t.dataset.act && adminApi) {
    t.disabled = true;
    await adminApi.setStatus(t.dataset.uid, t.dataset.act);
    await adminApi.render();
  } else if (t.dataset.id) {
    state.read.add(t.dataset.id); store.set("read", [...state.read]);
    t.closest(".card").classList.add("read");
  }
});
$("q").addEventListener("input", e => { state.q = e.target.value; state.shown = SHOW_STEP; renderList(); });
$("sort").addEventListener("change", e => { state.sort = e.target.value; renderList(); });

// ---------------- デモモード（localhost で Firebase 未設定のとき） ----------------

async function startDemo() {
  $("demo-banner").hidden = false;
  const d = await fetch("../local_data.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  setData(d.items || [], d.meta || {});
  render();
}

// ---------------- Firebase ----------------

async function startFirebase() {
  const { initializeApp } = await import(`${SDK}/firebase-app.js`);
  const A = await import(`${SDK}/firebase-auth.js`);
  const F = await import(`${SDK}/firebase-firestore.js`);

  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);

  $("login").onclick = async () => {
    $("login-msg").textContent = "";
    try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); }
    catch (err) { $("login-msg").textContent = "ログインに失敗しました：" + err.code; }
  };
  $("logout").onclick = () => A.signOut(auth);
  $("recheck").onclick = () => location.reload();

  $("apply-form").onsubmit = async e => {
    e.preventDefault();
    const user = auth.currentUser;
    $("apply-submit").disabled = true;
    try {
      await F.setDoc(F.doc(db, "users", user.uid), {
        name: $("apply-name").value.trim(),
        note: $("apply-note").value.trim(),
        email: user.email,
        photoURL: user.photoURL || "",
        status: "pending",
        createdAt: F.serverTimestamp(),
      });
      show("pending");
    } catch (err) {
      $("apply-msg").textContent = "送信に失敗しました：" + err.code;
      $("apply-submit").disabled = false;
    }
  };

  async function loadItems() {
    const meta = await F.getDoc(F.doc(db, "meta", "site"));
    let last = null;
    const items = [];
    async function page() {
      const q = last
        ? F.query(F.collection(db, "items"), F.orderBy("createdAt", "desc"), F.startAfter(last), F.limit(PAGE_SIZE))
        : F.query(F.collection(db, "items"), F.orderBy("createdAt", "desc"), F.limit(PAGE_SIZE));
      const snap = await F.getDocs(q);
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      last = snap.docs[snap.docs.length - 1] || last;
      loadMore = snap.size === PAGE_SIZE ? page : null;
      DATA.items = items;
    }
    setData(items, meta.exists() ? meta.data() : {});
    await page();
  }

  adminApi = {
    async render() {
      const snap = await F.getDocs(F.query(F.collection(db, "users"), F.orderBy("createdAt", "desc")));
      const groups = { pending: [], approved: [], rejected: [] };
      snap.forEach(d => (groups[d.data().status] || groups.pending).push({ uid: d.id, ...d.data() }));
      const row = (u, actions) => `<div class="user">
        <div class="who"><b>${esc(u.name)}</b> <span class="badge ${esc(u.status)}">${esc(u.status)}</span>
          <small>${esc(u.email)}</small><small>${esc(u.note)}</small></div>
        ${actions.map(([act, label, cls]) =>
          `<button class="btn ${cls}" data-act="${act}" data-uid="${esc(u.uid)}">${label}</button>`).join("")}
      </div>`;
      const none = `<p class="note">なし</p>`;
      $("admin-pending").innerHTML = groups.pending.map(u => row(u, [["approved", "承認", "ok"], ["rejected", "拒否", "ng"]])).join("") || none;
      $("admin-approved").innerHTML = groups.approved.map(u => row(u, [["rejected", "承認を取り消す", "ng"]])).join("") || none;
      $("admin-rejected").innerHTML = groups.rejected.map(u => row(u, [["approved", "承認", "ok"], ["delete", "削除（再申請可能に）", ""]])).join("") || none;
    },
    async setStatus(uid, act) {
      const ref = F.doc(db, "users", uid);
      if (act === "delete") await F.deleteDoc(ref);
      else await F.updateDoc(ref, { status: act, reviewedAt: F.serverTimestamp() });
    },
  };

  A.onAuthStateChanged(auth, async user => {
    $("me").hidden = !user;
    if (!user) { show("login"); return; }
    $("me-name").textContent = user.displayName || user.email;
    $("me-photo").src = user.photoURL || "";
    show("loading");
    try {
      state.isAdmin = (await F.getDoc(F.doc(db, "admins", user.uid))).exists();
      const me = await F.getDoc(F.doc(db, "users", user.uid));
      const status = me.exists() ? me.data().status : null;
      if (state.isAdmin || status === "approved") {
        await loadItems();
        render();
      } else if (status === "pending") {
        show("pending");
      } else if (status === "rejected") {
        show("rejected");
      } else {
        $("apply-name").value = user.displayName || "";
        show("apply");
      }
    } catch (err) {
      console.error(err);
      $("view-loading").innerHTML = `<p class="empty">読み込みに失敗しました（${esc(err.code || err.message)}）</p>`;
    }
  });
}

// ---------------- 起動 ----------------

const configured = Boolean(firebaseConfig.apiKey);
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (configured) startFirebase();
else if (isLocal) startDemo();
else show("setup");
