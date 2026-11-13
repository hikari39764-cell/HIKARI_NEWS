import { firebaseConfig } from "./firebase-config.js";

/* =========================================================================
   HIKARI NEWS — front-end
   ・ハッシュルーティング（#/today #/search #/chance #/saved #/admin）
   ・斜めワイプの画面転換、カードの段差表示、詳細ドロワー、Ctrl+K パレット
   ・Firebase（本番）/ ローカルのデモデータ（localhost で設定なしのとき）
   ========================================================================= */

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const PAGE_SIZE = 300;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const DEFAULT_CATS = [
  { id: "ai", name: "AIトレンド", emoji: "🤖", color: "5865F2" },
  { id: "industry", name: "ゲーム業界", emoji: "🎮", color: "ED4245" },
  { id: "tech", name: "技術・学習", emoji: "📚", color: "57F287" },
  { id: "ai_howto", name: "AI活用", emoji: "🛠️", color: "FEE75C" },
  { id: "classic", name: "定番の一本", emoji: "📌", color: "9B59B6" },
  { id: "community", name: "SNS・コミュニティ", emoji: "💬", color: "EB459E" },
  { id: "chance", name: "チャンス情報", emoji: "🎯", color: "F0B232" },
];
const SLOT_LABEL = { "10": "10:00", "17": "17:00", "22": "22:00" };
const WEEK = "日月火水木金土";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https?:\/\//.test(u || "") ? u : "#";
const todayStr = () => new Date().toLocaleDateString("sv-SE");
const daysUntil = d => Math.round((new Date(d + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 864e5);
const norm = s => String(s || "").normalize("NFKC").toLowerCase()
  .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

/* ------------------------------------------------------------------ prefs */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const P = {
  bookmarks: new Set(store.get("bookmarks", [])),
  read: new Map(Object.entries(store.get("readAt", {}))),
  chance: store.get("chance", {}),
  myKw: store.get("myKw", []),
  open: new Set(store.get("openBatches", [])),
  save() {
    store.set("bookmarks", [...this.bookmarks]);
    store.set("readAt", Object.fromEntries(this.read));
    store.set("chance", this.chance);
    store.set("myKw", this.myKw);
    store.set("openBatches", [...this.open].slice(-30));
  },
};

/* ------------------------------------------------------------------ state */
const S = { items: [], cats: DEFAULT_CATS, keywords: [], updated: null, isAdmin: false, ready: false,
            loadMore: null, adminApi: null, route: null, params: {} };
const catOf = id => S.cats.find(c => c.id === id) || { id, name: id, emoji: "•", color: "FFD23F" };
const catColor = id => "#" + (catOf(id).color || "FFD23F");
const byId = id => S.items.find(it => it.id === id);
const itemText = it => norm([it.title, it.summary, it.note, it.source, it.category_name, ...(it.tags || [])].join(" "));
const kwOf = it => {
  const t = itemText(it);
  return [...new Set([...S.keywords, ...P.myKw])].filter(k => t.includes(norm(k)));
};
const sortNew = (a, b) => b.date.localeCompare(a.date) || String(b.slot).localeCompare(String(a.slot)) || b.importance - a.importance;

/* ============================================================== components */
const stars = n => `<span class="stars" title="おすすめ度 ${n}">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? "" : "off"}"></i>`).join("")}</span>`;

function dlBadge(it) {
  if (!it.deadline) return "";
  const d = daysUntil(it.deadline);
  const cls = d < 0 ? "past" : d <= 3 ? "hot" : d <= 7 ? "warm" : "";
  const txt = d < 0 ? "終了" : d === 0 ? "今日まで" : `あと${d}日`;
  return `<span class="dl-badge ${cls}">${txt}</span>`;
}

function hl(text, terms) {
  let s = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    s = s.replace(re, m => `<mark>${m}</mark>`);
  }
  return s;
}

function rowHTML(it, i = 0, terms = [], extra = "") {
  const kws = kwOf(it);
  const meta = [
    `<span class="chip" style="--cat:${catColor(it.category)}" data-cat="${esc(it.category)}">${esc(catOf(it.category).name)}</span>`,
    stars(it.importance),
    it.level ? `<span class="lvl">${esc(it.level)}</span>` : "",
    it.lang === "en" ? `<span>英語</span>` : "",
    it.read_minutes ? `<span><i class="ti ti-clock"></i> ${it.read_minutes}分</span>` : "",
    `<span>${esc(it.source)}</span>`,
    kws.length ? `<span class="kw"><i class="ti ti-bell"></i> ${kws.map(esc).join("・")}</span>` : "",
  ].join("");
  return `<article class="row reveal ${P.read.has(it.id) ? "read" : ""}" style="--cat:${catColor(it.category)};--i:${i}" data-open="${esc(it.id)}">
    <div>
      <div class="meta">${meta}</div>
      <h3>${hl(it.title, terms)}</h3>
      <p class="sub">${hl(it.note || it.summary, terms)}</p>
      ${extra}
    </div>
    <div class="side">
      <button class="bm ${P.bookmarks.has(it.id) ? "on" : ""}" data-bm="${esc(it.id)}" aria-label="あとで読む">
        <i class="ti ${P.bookmarks.has(it.id) ? "ti-bookmark-filled" : "ti-bookmark"}"></i></button>
      ${dlBadge(it)}
    </div>
  </article>`;
}

function heroHTML(it) {
  return `<section class="hero reveal" style="--i:0" data-open="${esc(it.id)}">
    <span class="tag">TODAY'S PICK</span>
    <span class="big-num">${esc(SLOT_LABEL[it.slot] || "")}</span>
    <div class="meta">
      <span class="chip" style="--cat:${catColor(it.category)}">${esc(catOf(it.category).name)}</span>
      ${stars(it.importance)}
      ${it.level ? `<span class="lvl">${esc(it.level)}</span>` : ""}
      ${it.read_minutes ? `<span><i class="ti ti-clock"></i> ${it.read_minutes}分</span>` : ""}
      <span>${esc(it.source)}</span>
    </div>
    <h2>${esc(it.title)}</h2>
    <p>${esc(it.summary)}</p>
    ${it.note ? `<p class="note"><i class="ti ti-bulb"></i> ${esc(it.note)}</p>` : ""}
    <div class="acts">
      <a class="btn primary" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" data-read="${esc(it.id)}"><i class="ti ti-external-link"></i>原文を読む</a>
      <button class="btn" data-bm="${esc(it.id)}"><i class="ti ti-bookmark"></i>${P.bookmarks.has(it.id) ? "保存済み" : "あとで読む"}</button>
    </div>
  </section>`;
}

const emptyHTML = (title, body) => `<div class="empty reveal"><b>${esc(title)}</b>${esc(body)}</div>`;

/* ================================================================== views */

function viewToday() {
  if (!S.items.length) return `<div class="page">${emptyHTML("まだ記事がありません", "最初の配信（10:00 / 17:00 / 22:00）をお待ちください。")}</div>`;
  const dates = [...new Set(S.items.map(it => it.date))].sort().reverse().slice(0, 4);
  const latest = S.items.filter(it => it.date === dates[0]);
  const pick = [...latest].sort((a, b) => b.importance - a.importance || kwOf(b).length - kwOf(a).length)[0];

  const groups = [];
  for (const d of dates) {
    for (const slot of ["22", "17", "10"]) {
      const its = S.items.filter(it => it.date === d && String(it.slot) === slot && it !== pick).sort((a, b) => b.importance - a.importance);
      if (its.length) groups.push({ key: `${d}-${slot}`, d, slot, its });
    }
  }
  let n = 1;
  const batches = groups.map((g, gi) => {
    const open = P.open.has(g.key) || (gi === 0 && !P.open.has("closed:" + g.key));
    const day = new Date(g.d + "T00:00:00");
    const dayLbl = g.d === todayStr() ? "今日" : `${day.getMonth() + 1}/${day.getDate()}（${WEEK[day.getDay()]}）`;
    const cats = [...new Set(g.its.map(it => catOf(it.category).name))].join("・");
    return `<section class="batch reveal" style="--i:${n++}">
      <div class="batch-h ${open ? "open" : ""}" data-batch="${g.key}">
        <span class="time">${SLOT_LABEL[g.slot]}</span>
        <div><div class="lbl">${dayLbl}の便</div><div class="sub">${esc(cats)} ・ ${g.its.length}件</div></div>
        <span class="rule"></span><i class="ti ti-chevron-down chev"></i>
      </div>
      <div class="batch-body"><div><div class="rows">${g.its.map((it, i) => rowHTML(it, open ? i : 0)).join("")}</div></div></div>
    </section>`;
  }).join("");

  const d0 = new Date(dates[0] + "T00:00:00");
  return `<div class="page">
    <div class="ph reveal"><h1>今日の<em>ヒカリ</em></h1>
      <p>${d0.getMonth() + 1}月${d0.getDate()}日（${WEEK[d0.getDay()]}）${S.updated ? ` ・ 最終更新 ${esc(String(S.updated).replace("T", " ").slice(5, 16))}` : ""}</p></div>
    <div class="grid2">
      <div>${heroHTML(pick)}${batches}${S.loadMore ? `<p style="text-align:center;margin-top:30px"><button class="btn ghost" id="older">さらに古い記事を読み込む</button></p>` : ""}</div>
      ${sideHTML()}
    </div>
  </div>`;
}

function sideHTML() {
  const up = S.items.filter(it => it.deadline && daysUntil(it.deadline) >= 0).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 5);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toLocaleDateString("sv-SE");
  const top = S.items.filter(it => it.date >= weekAgo).sort((a, b) => b.importance - a.importance || sortNew(a, b)).slice(0, 5);
  const allKw = [...new Set([...S.keywords, ...P.myKw])];
  const st = readStats();
  return `<aside class="side-col">
    <div class="box reveal" style="--i:2"><h4 class="hot">締め切り間近</h4>
      ${up.length ? up.map(it => `<a class="mini" data-open="${esc(it.id)}">${dlBadge(it)}<div><div class="t">${esc(it.title)}</div></div></a>`).join("") : `<p class="sub" style="color:var(--muted);margin:0">今のところありません</p>`}
      <p style="margin:10px 0 0"><a class="btn sm ghost" href="#/chance">チャンス一覧 →</a></p></div>
    <div class="box reveal" style="--i:3"><h4>今週の人気</h4>
      ${top.map((it, i) => `<a class="mini" data-open="${esc(it.id)}"><span class="n">${i + 1}</span><div><div class="t">${esc(it.title)}</div><div class="d">${esc(catOf(it.category).name)}</div></div></a>`).join("")}</div>
    <div class="box reveal" style="--i:4"><h4 class="volt">マイキーワード</h4>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${allKw.map(k => {
        const c = S.items.filter(it => itemText(it).includes(norm(k))).length;
        const mine = P.myKw.includes(k);
        return `<span class="chip ${mine ? "" : "plain"}" style="--cat:var(--volt)" data-kw="${esc(k)}">${esc(k)} <b>${c}</b>${mine ? ` <i class="ti ti-x" data-rmkw="${esc(k)}"></i>` : ""}</span>`;
      }).join("")}</div>
      <form class="kwin" id="kwform"><input type="text" id="kwinput" maxlength="20" placeholder="キーワードを追加"><button class="btn sm primary">追加</button></form></div>
    <div class="box reveal" style="--i:5"><h4>学習ログ</h4>
      <div class="stat"><div><b>${st.week}</b><span>今週の読了</span></div><div><b>${st.streak}</b><span>連続日数</span></div><div><b>${P.bookmarks.size}</b><span>あとで読む</span></div></div>
      <p style="margin:12px 0 0"><a class="btn sm ghost" href="#/saved">マイページ →</a></p></div>
  </aside>`;
}

function readStats() {
  const ts = [...P.read.values()].map(Number);
  const weekAgo = Date.now() - 7 * 864e5;
  const days = new Set(ts.map(t => new Date(t).toLocaleDateString("sv-SE")));
  let streak = 0;
  for (let d = new Date(); days.has(d.toLocaleDateString("sv-SE")); d.setDate(d.getDate() - 1)) streak++;
  return { week: ts.filter(t => t >= weekAgo).length, total: ts.length, streak };
}

/* ---------------------------------------------------------------- search */
const F_DEF = { q: "", cats: "", lvl: "", lang: "", period: "", dl: "", min: "", sort: "new" };

function viewSearch() {
  const f = { ...F_DEF, ...S.params };
  const chip = (key, val, label, color = "var(--flare)") => {
    const on = key === "cats" ? f.cats.split(",").includes(val) : f[key] === val;
    return `<button class="chip ${on ? "on" : ""}" style="--cat:${color}" data-f="${key}" data-v="${esc(val)}">${label}</button>`;
  };
  return `<div class="page">
    <div class="ph reveal"><h1>さが<em>す</em></h1><p>タイトル・要約・タグ・サイト名から検索。ひらがな／カタカナ、全角／半角は区別しません。</p></div>
    <div class="sbar reveal" style="--i:1"><i class="ti ti-search ico"></i><input type="search" id="sq" value="${esc(f.q)}" placeholder="例：シェーダー、Godot、インターン、Steam" autofocus></div>
    <div class="filters reveal" style="--i:2">
      <div class="frow"><span>カテゴリ</span>${S.cats.map(c => chip("cats", c.id, esc(c.name), "#" + c.color)).join("")}</div>
      <div class="frow"><span>難易度</span>${["入門", "中級", "上級"].map(l => chip("lvl", l, l)).join("")}
        <span style="width:auto;margin-left:14px">原文</span>${chip("lang", "ja", "日本語")}${chip("lang", "en", "英語")}</div>
      <div class="frow"><span>期間</span>${chip("period", "1", "今日")}${chip("period", "7", "1週間")}${chip("period", "30", "1か月")}
        <span style="width:auto;margin-left:14px">条件</span>${chip("dl", "1", "締め切りあり", "var(--hot)")}${chip("min", "4", "★4以上")}${chip("min", "5", "★5のみ")}</div>
      <div class="frow"><span>並び順</span>${chip("sort", "new", "新しい順", "var(--volt)")}${chip("sort", "imp", "おすすめ順", "var(--volt)")}
        <button class="btn sm ghost" id="freset" style="margin-left:auto">条件をリセット</button></div>
    </div>
    <div id="results"></div>
  </div>`;
}

function runSearch() {
  const f = { ...F_DEF, ...S.params };
  const terms = norm(f.q).split(/\s+/).filter(Boolean);
  const cats = f.cats ? f.cats.split(",") : [];
  const since = f.period ? new Date(Date.now() - (Number(f.period) - 1) * 864e5).toLocaleDateString("sv-SE") : "";
  let list = S.items.filter(it => {
    if (cats.length && !cats.includes(it.category)) return false;
    if (f.lvl && it.level !== f.lvl) return false;
    if (f.lang && it.lang !== f.lang) return false;
    if (since && it.date < since) return false;
    if (f.dl && !it.deadline) return false;
    if (f.min && it.importance < Number(f.min)) return false;
    if (terms.length) { const t = itemText(it); return terms.every(w => t.includes(w)); }
    return true;
  });
  list.sort(f.sort === "imp" ? (a, b) => b.importance - a.importance || sortNew(a, b) : sortNew);
  const rawTerms = f.q.split(/\s+/).filter(Boolean);
  $("#results").innerHTML = `<p class="count"><b>${list.length}</b> 件</p>` +
    (list.length ? `<div class="rows" style="padding:0">${list.slice(0, 120).map((it, i) => rowHTML(it, Math.min(i, 12), rawTerms)).join("")}</div>`
                 : emptyHTML("見つかりませんでした", "キーワードを短くするか、条件を減らしてみてください。"));
}

function setParams(patch) {
  S.params = { ...S.params, ...patch };
  const qs = new URLSearchParams(Object.entries(S.params).filter(([k, v]) => v && F_DEF[k] !== v)).toString();
  history.replaceState(null, "", `#/search${qs ? "?" + qs : ""}`);
  runSearch();
}

/* ---------------------------------------------------------------- chance */
function viewChance() {
  const f = S.params.f || "all";
  let list = S.items.filter(it => it.deadline).sort((a, b) => a.deadline.localeCompare(b.deadline));
  if (f === "want") list = list.filter(it => P.chance[it.id] === "want");
  else if (f === "done") list = list.filter(it => P.chance[it.id] === "done");
  else if (f !== "past") list = list.filter(it => daysUntil(it.deadline) >= 0);
  if (f === "past") list = list.filter(it => daysUntil(it.deadline) < 0).reverse();
  const groups = [["今週まで", d => d <= 7], ["今月中", d => d > 7 && d <= 31], ["それ以降", d => d > 31], ["終了", d => d < 0]];
  let i = 0;
  const body = groups.map(([name, fn]) => {
    const g = list.filter(it => fn(daysUntil(it.deadline)) && (name !== "終了" || f === "past" || f === "want" || f === "done"));
    if (!g.length) return "";
    return `<div class="tl-g reveal" style="--i:${i++}">— ${name}</div>` + g.map(it => {
      const st = P.chance[it.id];
      const extra = `<div class="seg" style="margin-top:10px">
        <button class="btn sm ${st === "want" ? "on" : ""}" data-chance="${esc(it.id)}" data-st="want"><i class="ti ti-star"></i>気になる</button>
        <button class="btn sm ${st === "done" ? "on" : ""}" data-chance="${esc(it.id)}" data-st="done"><i class="ti ti-check"></i>応募済み</button>
        <span style="color:var(--muted);font-size:12px;align-self:center">締め切り ${esc(it.deadline.replace(/-/g, "/"))}</span></div>`;
      return `<div style="position:relative"><span class="tl-dot" style="--cat:${catColor(it.category)}"></span>${rowHTML(it, i++, [], extra)}</div>`;
    }).join("");
  }).join("");
  const tab = (k, l) => `<a class="btn sm ${f === k ? "primary" : ""}" href="#/chance${k === "all" ? "" : "?f=" + k}">${l}</a>`;
  return `<div class="page">
    <div class="ph reveal"><h1>チャン<em>ス</em></h1><p>ゲームジャム・コンテスト・インターン・採用。締め切りが近い順。</p></div>
    <div class="seg reveal" style="--i:1">${tab("all", "受付中")}${tab("want", "気になる")}${tab("done", "応募済み")}${tab("past", "終了したもの")}</div>
    <div class="tl">${body || emptyHTML("該当するものはありません", "チャンス情報は毎週月・木の 22:00 便で届きます。")}</div>
  </div>`;
}

/* ----------------------------------------------------------------- saved */
function viewSaved() {
  const tab = S.params.t || "later";
  const st = readStats();
  let list;
  if (tab === "read") list = S.items.filter(it => P.read.has(it.id)).sort((a, b) => P.read.get(b.id) - P.read.get(a.id));
  else list = S.items.filter(it => P.bookmarks.has(it.id)).sort(sortNew);
  const byCat = S.cats.map(c => ({ c, n: S.items.filter(it => it.category === c.id && P.read.has(it.id)).length }));
  const max = Math.max(1, ...byCat.map(x => x.n));
  const t = (k, l) => `<a class="btn sm ${tab === k ? "primary" : ""}" href="#/saved${k === "later" ? "" : "?t=" + k}">${l}</a>`;
  return `<div class="page">
    <div class="ph reveal"><h1>マイ<em>ページ</em></h1><p>あとで読む・読んだ記事・学習ログ（このブラウザに保存されます）</p></div>
    <div class="grid2">
      <div>
        <div class="seg reveal" style="--i:1">${t("later", `あとで読む（${P.bookmarks.size}）`)}${t("read", `読んだ記事（${P.read.size}）`)}</div>
        ${list.length ? `<div class="rows" style="padding:6px 0">${list.map((it, i) => rowHTML(it, i)).join("")}</div>`
          : emptyHTML(tab === "read" ? "まだ読んだ記事はありません" : "保存した記事はありません", tab === "read" ? "「原文を読む」を開くと、ここに記録されます。" : "記事の右側にあるしおりのアイコンで保存できます。")}
      </div>
      <aside class="side-col">
        <div class="box reveal" style="--i:2"><h4>学習ログ</h4>
          <div class="stat"><div><b>${st.total}</b><span>累計</span></div><div><b>${st.week}</b><span>今週</span></div><div><b>${st.streak}</b><span>連続日数</span></div></div></div>
        <div class="box reveal" style="--i:3"><h4 class="volt">ジャンル別</h4>
          ${byCat.map(({ c, n }) => `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between;font-size:12px"><span>${esc(c.name)}</span><span style="color:var(--muted)">${n}</span></div>
            <div style="height:8px;background:var(--ink-4);transform:skewX(-14deg)"><div style="height:100%;width:${(n / max) * 100}%;background:#${c.color};transition:width .8s var(--ease-out)"></div></div></div>`).join("")}</div>
      </aside>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- admin */
function viewAdmin() {
  if (!S.adminApi) return `<div class="page">${emptyHTML("管理画面", "デモモードでは使えません。")}</div>`;
  return `<div class="page"><div class="ph reveal"><h1>管<em>理</em></h1><p>閲覧申請の承認・拒否</p></div><div id="admin-list"><div class="sk"></div><div class="sk"></div></div></div>`;
}

async function renderAdminList() {
  const groups = await S.adminApi.list();
  const row = (u, acts) => `<div class="user reveal"><div class="who"><b>${esc(u.name)}</b> <span class="lvl">${esc(u.status)}</span><small>${esc(u.email)}</small><small>${esc(u.note)}</small></div>
    ${acts.map(([a, l, cls]) => `<button class="btn sm ${cls}" data-act="${a}" data-uid="${esc(u.uid)}">${l}</button>`).join("")}</div>`;
  const sec = (title, list, acts) => `<h3 style="font:400 16px var(--f-display);margin:26px 0 10px">${title}（${list.length}）</h3>` +
    (list.map(u => row(u, acts)).join("") || `<p style="color:var(--muted)">なし</p>`);
  $("#admin-list").innerHTML =
    sec("承認待ち", groups.pending, [["approved", "承認", "primary"], ["rejected", "拒否", ""]]) +
    sec("承認済み", groups.approved, [["rejected", "承認を取り消す", ""]]) +
    sec("拒否", groups.rejected, [["approved", "承認", "primary"], ["delete", "削除（再申請可能に）", ""]]);
  updateAdminBadge(groups.pending.length);
}
function updateAdminBadge(n) { const b = $("#admin-badge"); b.hidden = !n; b.textContent = n; }

/* ============================================================ gate views */
const GATES = {
  loading: () => `<div class="page"><div class="sk big"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>`,
  setup: () => gate(`<h2>設定が<em>未完了</em></h2><p>public/firebase-config.js に Firebase の設定を入力してください。</p>`),
  login: () => gate(`<h2>HIKARI <em>NEWS</em></h2><p>ゲーム制作を学ぶ人のための、AI・技術・業界・チャンス情報を毎日3回お届けします。閲覧には管理者の承認が必要です。</p>
    <button class="btn primary" id="login"><i class="ti ti-brand-google"></i>Google でログイン</button><div class="msg" id="login-msg"></div>`),
  apply: name => gate(`<h2>閲覧<em>申請</em></h2><p>管理者が承認すると読めるようになります。</p>
    <form id="apply-form"><label for="apply-name">お名前（ニックネーム可）</label><input type="text" id="apply-name" maxlength="50" required value="${esc(name || "")}">
    <label for="apply-note">ひとこと（所属・どこで知ったか など）</label><textarea id="apply-note" maxlength="300"></textarea>
    <p style="margin-top:18px"><button class="btn primary" id="apply-submit">申請する</button></p><div class="msg" id="apply-msg"></div></form>`),
  pending: () => gate(`<h2>承認<em>待ち</em></h2><p>申請を受け付けました。承認されると、このページで記事が読めるようになります。</p><button class="btn" id="recheck"><i class="ti ti-refresh"></i>状態を再確認</button>`),
  rejected: () => gate(`<h2>申請は<em>承認されませんでした</em></h2><p>心当たりがない場合は管理者に連絡してください。</p>`),
  error: msg => gate(`<h2>読み込みに<em>失敗</em></h2><p>${esc(msg)}</p><button class="btn" id="recheck"><i class="ti ti-refresh"></i>再読み込み</button>`),
};
const gate = inner => `<div class="gate"><div class="beams"><i></i><i></i><i></i></div><div class="gate-card">${inner}</div></div>`;

function showGate(name, arg) {
  S.ready = false;
  $("#nav").hidden = $("#bnav").hidden = $("#open-pal").hidden = true;
  $("#view").innerHTML = GATES[name](arg);
  const re = $("#recheck"); if (re) re.onclick = () => location.reload();
}

/* ================================================================ router */
const VIEWS = { today: viewToday, search: viewSearch, chance: viewChance, saved: viewSaved, admin: viewAdmin };

function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const route = VIEWS[path] ? path : "today";
  return { route, params: Object.fromEntries(new URLSearchParams(qs || "")) };
}

let first = true;
function render() {
  if (!S.ready) return;
  const { route, params } = parseHash();
  if (route === "admin" && !S.isAdmin) { location.hash = "#/today"; return; }
  const changed = route !== S.route;
  S.route = route; S.params = params;
  const draw = () => {
    $("#view").innerHTML = VIEWS[route]();
    if (route === "search") runSearch();
    if (route === "admin" && S.adminApi) renderAdminList();
    moveIndicator();
    if (changed) window.scrollTo({ top: 0 });
  };
  if (first || !changed || REDUCED) { first = false; draw(); } else wipe(draw);
}

function wipe(midway) {
  const w = $("#wipe");
  w.hidden = false;
  const bands = $$("i", w);
  const at = x => `translateX(${x}) skewX(-20deg)`;
  // タブが非表示などでアニメーションが止まっても、一定時間後には必ず先へ進む
  const run = (from, to, dur, step, ease) => Promise.race([
    Promise.all(bands.map((b, i) =>
      b.animate([{ transform: at(from) }, { transform: at(to) }], { duration: dur, delay: i * step, easing: ease, fill: "forwards" }).finished)),
    new Promise(r => setTimeout(r, dur + 300)),
  ]);
  run("-250vw", "-75vw", 300, 55, "cubic-bezier(.7,0,.2,1)").then(() => {
    midway();
    return new Promise(r => setTimeout(r, 90));
  }).then(() => run("-75vw", "120vw", 420, -40, "cubic-bezier(.6,0,.15,1)"))
    .then(() => { w.hidden = true; bands.forEach(b => b.getAnimations().forEach(a => a.cancel())); });
}

function moveIndicator() {
  const r = S.route;
  $$(".nav a, .bnav a").forEach(a => a.classList.toggle("on", a.dataset.r === r));
  const on = $(`.nav a[data-r="${r}"]`), ind = $("#ind");
  if (on && ind) { ind.style.left = on.offsetLeft + "px"; ind.style.width = on.offsetWidth + "px"; }
}

/* ================================================================ drawer */
function openDetail(id) {
  const it = byId(id);
  if (!it) return;
  const related = S.items.filter(x => x.id !== id && (x.category === it.category || (x.tags || []).some(t => (it.tags || []).includes(t))))
    .sort((a, b) => (b.tags || []).filter(t => (it.tags || []).includes(t)).length - (a.tags || []).filter(t => (it.tags || []).includes(t)).length || sortNew(a, b)).slice(0, 4);
  const d = $("#drawer");
  d.style.setProperty("--cat", catColor(it.category));
  d.innerHTML = `<div class="band"><div class="cat">${esc(catOf(it.category).emoji)} ${esc(catOf(it.category).name)}</div><h2>${esc(it.title)}</h2>
      <button class="x" data-close aria-label="閉じる"><i class="ti ti-x"></i></button></div>
    <div class="in">
      <div class="meta" style="margin:6px 0 16px">${stars(it.importance)}${it.level ? `<span class="lvl">${esc(it.level)}</span>` : ""}
        ${it.lang === "en" ? "<span>原文：英語</span>" : ""}${it.read_minutes ? `<span><i class="ti ti-clock"></i> ${it.read_minutes}分</span>` : ""}
        <span>${esc(it.source)}</span><span>${esc(it.date)} ${esc(SLOT_LABEL[it.slot] || "")}便</span>${dlBadge(it)}</div>
      <p class="sum">${esc(it.summary)}</p>
      ${it.note ? `<div class="learn"><b>POINT</b>${esc(it.note)}</div>` : ""}
      ${it.deadline ? `<p><i class="ti ti-calendar"></i> 締め切り：<b>${esc(it.deadline.replace(/-/g, "/"))}</b></p>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:14px 0">${(it.tags || []).map(t => `<a class="chip plain" href="#/search?q=${encodeURIComponent(t)}" data-close>#${esc(t)}</a>`).join("")}</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:18px">
        <a class="btn primary" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" data-read="${esc(it.id)}"><i class="ti ti-external-link"></i>原文を読む</a>
        <button class="btn ${P.bookmarks.has(it.id) ? "on" : ""}" data-bm="${esc(it.id)}"><i class="ti ti-bookmark"></i>${P.bookmarks.has(it.id) ? "保存済み" : "あとで読む"}</button>
        <button class="btn ${P.read.has(it.id) ? "on" : ""}" data-toggle-read="${esc(it.id)}"><i class="ti ti-check"></i>${P.read.has(it.id) ? "読了" : "読了にする"}</button>
      </div>
      ${related.length ? `<h5>関連する記事</h5>${related.map(x => `<a class="mini" data-open="${esc(x.id)}"><span class="chip" style="--cat:${catColor(x.category)}">${esc(catOf(x.category).name)}</span><div class="t">${esc(x.title)}</div></a>`).join("")}` : ""}
    </div>`;
  d.scrollTop = 0;
  d.classList.add("on"); d.setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("on");
}
function closeDetail() {
  $("#drawer").classList.remove("on"); $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("on");
}

/* =============================================================== palette */
let palSel = 0, palHits = [];
function openPal() {
  if (!S.ready) return;
  $("#pal").hidden = false;
  const q = $("#pal-q"); q.value = ""; palQuery(""); setTimeout(() => q.focus(), 10);
}
function closePal() { $("#pal").hidden = true; }
function palQuery(q) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  palHits = (terms.length ? S.items.filter(it => { const t = itemText(it); return terms.every(w => t.includes(w)); })
    .sort((a, b) => (norm(b.title).includes(terms[0]) - norm(a.title).includes(terms[0])) || sortNew(a, b))
    : [...S.items].sort(sortNew)).slice(0, 8);
  palSel = 0;
  const raw = q.split(/\s+/).filter(Boolean);
  $("#pal-list").innerHTML = palHits.map((it, i) => `<li class="${i === 0 ? "sel" : ""}" data-i="${i}" style="--cat:${catColor(it.category)}">
    <span class="c"></span><span class="t">${hl(it.title, raw)}<small>${esc(catOf(it.category).name)} ・ ${esc(it.source)} ・ ${esc(it.date)}</small></span></li>`).join("")
    || `<li><span class="t" style="color:var(--muted)">見つかりませんでした</span></li>`;
}
function palMove(d) {
  if (!palHits.length) return;
  palSel = (palSel + d + palHits.length) % palHits.length;
  $$("#pal-list li").forEach((li, i) => li.classList.toggle("sel", i === palSel));
  $$("#pal-list li")[palSel]?.scrollIntoView({ block: "nearest" });
}

/* ================================================================ events */
function toast(msg) {
  $$(".toast").forEach(t => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2400);
}

function markRead(id) {
  if (!P.read.has(id)) { P.read.set(id, Date.now()); P.save(); }
  $$(`.row[data-open="${CSS.escape(id)}"]`).forEach(r => r.classList.add("read"));
}

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-bm],[data-read],[data-toggle-read],[data-open],[data-close],[data-close-pal],[data-batch],[data-f],[data-kw],[data-rmkw],[data-chance],[data-act],#freset,#older,#pal-list li,#pal-all");
  if (!t) return;
  if (t.dataset.bm) {
    e.preventDefault(); e.stopPropagation();
    const id = t.dataset.bm, on = !P.bookmarks.has(id);
    on ? P.bookmarks.add(id) : P.bookmarks.delete(id); P.save();
    $$(`[data-bm="${CSS.escape(id)}"]`).forEach(b => {
      b.classList.toggle("on", on);
      if (b.classList.contains("bm")) { b.innerHTML = `<i class="ti ${on ? "ti-bookmark-filled" : "ti-bookmark"}"></i>`; if (on) { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); } }
      else b.innerHTML = `<i class="ti ti-bookmark"></i>${on ? "保存済み" : "あとで読む"}`;
    });
    toast(on ? "あとで読む に追加！" : "保存を解除しました");
  } else if (t.dataset.read) {
    markRead(t.dataset.read);
  } else if (t.dataset.toggleRead) {
    const id = t.dataset.toggleRead;
    P.read.has(id) ? P.read.delete(id) : P.read.set(id, Date.now()); P.save();
    openDetail(id); toast(P.read.has(id) ? "読了にしました" : "未読に戻しました");
    $$(`.row[data-open="${CSS.escape(id)}"]`).forEach(r => r.classList.toggle("read", P.read.has(id)));
  } else if (t.dataset.rmkw) {
    e.stopPropagation();
    P.myKw = P.myKw.filter(k => k !== t.dataset.rmkw); P.save(); $("#view").innerHTML = VIEWS[S.route]();
  } else if (t.dataset.kw) {
    location.hash = `#/search?q=${encodeURIComponent(t.dataset.kw)}`;
  } else if (t.dataset.chance) {
    e.stopPropagation();
    const id = t.dataset.chance, st = t.dataset.st;
    P.chance[id] = P.chance[id] === st ? undefined : st; P.save();
    $("#view").innerHTML = viewChance();
    toast(P.chance[id] === "done" ? "応募済みにしました" : P.chance[id] === "want" ? "気になるリストに追加" : "解除しました");
  } else if (t.dataset.open && !e.target.closest("a[href]:not([data-open])")) {
    if (e.target.closest(".chip[data-cat]")) { e.stopPropagation(); location.hash = `#/search?cats=${t.querySelector("[data-cat]")?.dataset.cat || ""}`; return; }
    openDetail(t.dataset.open);
  } else if (t.matches("[data-close]")) {
    closeDetail();
  } else if (t.matches("[data-close-pal]")) {
    closePal();
  } else if (t.dataset.batch) {
    const key = t.dataset.batch, open = !t.classList.contains("open");
    t.classList.toggle("open", open);
    if (open) { P.open.add(key); P.open.delete("closed:" + key); t.nextElementSibling.querySelectorAll(".row").forEach((r, i) => { r.style.setProperty("--i", i); r.classList.remove("reveal"); void r.offsetWidth; r.classList.add("reveal"); }); }
    else { P.open.delete(key); P.open.add("closed:" + key); }
    P.save();
  } else if (t.dataset.f) {
    const k = t.dataset.f, v = t.dataset.v, cur = { ...F_DEF, ...S.params };
    if (k === "cats") { const s = new Set(cur.cats.split(",").filter(Boolean)); s.has(v) ? s.delete(v) : s.add(v); setParams({ cats: [...s].join(",") }); }
    else setParams({ [k]: cur[k] === v && k !== "sort" ? "" : v });
    $$(`[data-f]`).forEach(b => { const c = { ...F_DEF, ...S.params }; b.classList.toggle("on", b.dataset.f === "cats" ? c.cats.split(",").includes(b.dataset.v) : c[b.dataset.f] === b.dataset.v); });
  } else if (t.id === "freset") {
    S.params = {}; history.replaceState(null, "", "#/search"); $("#view").innerHTML = viewSearch(); runSearch();
  } else if (t.id === "older" && S.loadMore) {
    t.disabled = true; t.textContent = "読み込み中…"; await S.loadMore(); $("#view").innerHTML = viewToday();
  } else if (t.matches("#pal-list li") && palHits[t.dataset.i]) {
    closePal(); openDetail(palHits[t.dataset.i].id);
  } else if (t.id === "pal-all") {
    const q = $("#pal-q").value; closePal(); location.hash = `#/search${q ? "?q=" + encodeURIComponent(q) : ""}`;
  } else if (t.dataset.act && S.adminApi) {
    t.disabled = true; await S.adminApi.setStatus(t.dataset.uid, t.dataset.act); await renderAdminList(); toast("更新しました");
  }
});

document.addEventListener("submit", e => {
  if (e.target.id === "kwform") {
    e.preventDefault();
    const v = $("#kwinput").value.trim();
    if (v && !P.myKw.includes(v)) { P.myKw.push(v); P.save(); toast(`「${v}」を追加しました`); }
    $("#view").innerHTML = VIEWS[S.route]();
  }
});

let deb;
document.addEventListener("input", e => {
  if (e.target.id === "sq") { clearTimeout(deb); deb = setTimeout(() => setParams({ q: e.target.value }), 120); }
  if (e.target.id === "pal-q") palQuery(e.target.value);
});

document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#pal").hidden ? openPal() : closePal(); return; }
  if (e.key === "/" && !typing && S.ready) { e.preventDefault(); openPal(); return; }
  if (e.key === "Escape") { if (!$("#pal").hidden) closePal(); else closeDetail(); return; }
  if (!$("#pal").hidden) {
    if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
    if (e.key === "Enter" && palHits[palSel]) { e.preventDefault(); const id = palHits[palSel].id; closePal(); openDetail(id); }
  }
});

$("#scrim").addEventListener("click", closeDetail);
$("#open-pal").addEventListener("click", openPal);
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next; store.set("theme", next);
  try { localStorage.setItem("theme", next); } catch {}
  $("#theme").innerHTML = `<i class="ti ${next === "light" ? "ti-sun" : "ti-moon-stars"}"></i>`;
});
window.addEventListener("hashchange", () => { closeDetail(); render(); });
window.addEventListener("resize", moveIndicator);

function enterApp() {
  S.ready = true;
  $("#nav").hidden = $("#bnav").hidden = $("#open-pal").hidden = false;
  $("#nav-admin").hidden = !S.isAdmin;
  render();
  requestAnimationFrame(moveIndicator);
  document.fonts?.ready.then(moveIndicator);   // フォント読み込み後にタブ幅が変わるため
}

function setData(items, meta = {}) {
  S.items = items.map(it => ({ ...it, slot: String(it.slot || "") }));
  if (meta.categories?.length) {
    S.cats = meta.categories.map(c => ({ ...DEFAULT_CATS.find(d => d.id === c.id), ...c, color: c.color || DEFAULT_CATS.find(d => d.id === c.id)?.color || "FFD23F" }));
  }
  S.keywords = meta.keywords || [];
  S.updated = meta.updated || null;
}

/* ================================================================ boot: demo */
async function startDemo() {
  const tag = document.createElement("div"); tag.className = "demo"; tag.textContent = "DEMO（localhost・ローカルデータ）";
  document.body.appendChild(tag);
  showGate("loading");
  const d = await fetch("../samples/demo_site.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  setData(d.items || [], d.meta || {});
  enterApp();
}

/* ============================================================ boot: firebase */
async function startFirebase() {
  showGate("loading");
  const { initializeApp } = await import(`${SDK}/firebase-app.js`);
  const A = await import(`${SDK}/firebase-auth.js`);
  const F = await import(`${SDK}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);

  $("#logout").onclick = () => A.signOut(auth).then(() => location.reload());

  S.adminApi = {
    async list() {
      const snap = await F.getDocs(F.query(F.collection(db, "users"), F.orderBy("createdAt", "desc")));
      const g = { pending: [], approved: [], rejected: [] };
      snap.forEach(d => (g[d.data().status] || g.pending).push({ uid: d.id, ...d.data() }));
      return g;
    },
    async setStatus(uid, act) {
      const ref = F.doc(db, "users", uid);
      if (act === "delete") await F.deleteDoc(ref);
      else await F.updateDoc(ref, { status: act, reviewedAt: F.serverTimestamp() });
    },
  };

  async function loadItems() {
    const meta = await F.getDoc(F.doc(db, "meta", "site"));
    let last = null;
    const items = [];
    async function page() {
      const base = [F.collection(db, "items"), F.orderBy("createdAt", "desc")];
      const q = last ? F.query(...base, F.startAfter(last), F.limit(PAGE_SIZE)) : F.query(...base, F.limit(PAGE_SIZE));
      const snap = await F.getDocs(q);
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      last = snap.docs[snap.docs.length - 1] || last;
      S.loadMore = snap.size === PAGE_SIZE ? page : null;
      setData(items, meta.exists() ? meta.data() : {});
    }
    await page();
  }

  A.onAuthStateChanged(auth, async user => {
    $("#me").hidden = !user;
    if (!user) {
      showGate("login");
      $("#login").onclick = async () => {
        $("#login-msg").textContent = "";
        try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); }
        catch (err) { $("#login-msg").textContent = "ログインできませんでした（" + err.code + "）"; }
      };
      return;
    }
    $("#me-photo").src = user.photoURL || "";
    showGate("loading");
    try {
      S.isAdmin = (await F.getDoc(F.doc(db, "admins", user.uid))).exists();
      const me = await F.getDoc(F.doc(db, "users", user.uid));
      const status = me.exists() ? me.data().status : null;
      if (S.isAdmin || status === "approved") {
        await loadItems();
        S.adminApi = S.isAdmin ? S.adminApi : null;
        enterApp();
        if (S.isAdmin) S.adminApi.list().then(g => updateAdminBadge(g.pending.length)).catch(() => {});
      } else if (status === "pending") showGate("pending");
      else if (status === "rejected") showGate("rejected");
      else {
        showGate("apply", user.displayName);
        $("#apply-form").onsubmit = async e => {
          e.preventDefault();
          $("#apply-submit").disabled = true;
          try {
            await F.setDoc(F.doc(db, "users", user.uid), {
              name: $("#apply-name").value.trim(), note: $("#apply-note").value.trim(),
              email: user.email, photoURL: user.photoURL || "", status: "pending", createdAt: F.serverTimestamp(),
            });
            showGate("pending");
          } catch (err) {
            $("#apply-msg").textContent = "送信できませんでした（" + err.code + "）";
            $("#apply-submit").disabled = false;
          }
        };
      }
    } catch (err) {
      console.error(err);
      showGate("error", err.code || err.message);
    }
  });
}

/* ================================================================== boot */
$("#theme").innerHTML = `<i class="ti ${document.documentElement.dataset.theme === "light" ? "ti-sun" : "ti-moon-stars"}"></i>`;
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const demoParam = new URLSearchParams(location.search).has("demo");
if (isLocal && (demoParam || !firebaseConfig.apiKey)) startDemo();
else if (firebaseConfig.apiKey) startFirebase();
else showGate("setup");
