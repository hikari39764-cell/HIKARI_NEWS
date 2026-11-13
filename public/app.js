import { firebaseConfig } from "./firebase-config.js";
import { logoSVG } from "./logo.js";

/* =========================================================================
   HIKARI NEWS — front-end v2
   ・アイコン中心の UI（ボタンはアイコン＋ツールチップ、文字は最小限）
   ・ロゴのイントロ、斜めワイプ転換、スクロールで現れるカード、保存時の星のはじけ
   ・Firebase（本番）/ ローカルのデモデータ（localhost?demo）
   ========================================================================= */

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const PAGE_SIZE = 300;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const DEFAULT_CATS = [
  { id: "ai", name: "AIトレンド", color: "7B8CFF" },
  { id: "industry", name: "ゲーム業界", color: "FF6B6B" },
  { id: "tech", name: "技術・学習", color: "5EE6A0" },
  { id: "ai_howto", name: "AI活用", color: "F2F56A" },
  { id: "classic", name: "定番の一本", color: "C59BFF" },
  { id: "community", name: "SNS・コミュニティ", color: "FF8FC8" },
  { id: "chance", name: "チャンス情報", color: "FFB874" },
];
const CAT_ICON = { ai: "ti-robot", industry: "ti-device-gamepad-2", tech: "ti-code", ai_howto: "ti-wand",
                   classic: "ti-pin", community: "ti-messages", chance: "ti-trophy" };
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
const ic = (name, extra = "") => `<i class="ti ${name}" ${extra}></i>`;

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
    store.set("bookmarks", [...this.bookmarks]); store.set("readAt", Object.fromEntries(this.read));
    store.set("chance", this.chance); store.set("myKw", this.myKw); store.set("openBatches", [...this.open].slice(-30));
  },
};

/* ------------------------------------------------------------------ state */
const S = { items: [], cats: DEFAULT_CATS, keywords: [], updated: null, isAdmin: false, ready: false,
            loadMore: null, adminApi: null, route: null, params: {} };
const catOf = id => S.cats.find(c => c.id === id) || { id, name: id, color: "F2F56A" };
const catColor = id => "#" + (catOf(id).color || "F2F56A");
const catIc = (id, tip = true) => `<span class="cat-ic" style="--cat:${catColor(id)}" ${tip ? `data-tip="${esc(catOf(id).name)}"` : ""}>${ic(CAT_ICON[id] || "ti-point")}</span>`;
const byId = id => S.items.find(it => it.id === id);
const itemText = it => norm([it.title, it.summary, it.note, it.source, it.category_name, ...(it.tags || [])].join(" "));
const kwOf = it => { const t = itemText(it); return [...new Set([...S.keywords, ...P.myKw])].filter(k => t.includes(norm(k))); };
const sortNew = (a, b) => b.date.localeCompare(a.date) || String(b.slot).localeCompare(String(a.slot)) || b.importance - a.importance;

/* ============================================================== components */
const stars = n => `<span class="stars" data-tip="おすすめ度 ${n}/5">${[1, 2, 3, 4, 5].map(i =>
  i <= n ? `<i class="ti ti-star-filled"></i>` : `<i class="ti ti-star off"></i>`).join("")}</span>`;
const LV = { "入門": 1, "中級": 2, "上級": 3 };
const level = l => l ? `<span class="lv" data-tip="難易度：${esc(l)}">${[1, 2, 3].map(i => `<i class="${i <= LV[l] ? "on" : ""}"></i>`).join("")}</span>` : "";

function dlBadge(it) {
  if (!it.deadline) return "";
  const d = daysUntil(it.deadline);
  const cls = d < 0 ? "past" : d <= 3 ? "hot" : d <= 7 ? "warm" : "";
  const txt = d < 0 ? "終了" : d === 0 ? "今日" : `${d}日`;
  return `<span class="dl ${cls}" data-tip="締め切り ${esc(it.deadline.replace(/-/g, "/"))}">${ic("ti-hourglass")}${txt}</span>`;
}

function hl(text, terms) {
  let s = esc(text);
  for (const t of terms) {
    if (!t) continue;
    s = s.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m => `<mark>${m}</mark>`);
  }
  return s;
}

function metaLine(it) {
  const kws = kwOf(it);
  return [
    stars(it.importance), level(it.level),
    it.read_minutes ? `<span data-tip="読む時間の目安">${ic("ti-clock")} ${it.read_minutes}分</span>` : "",
    it.lang === "en" ? `<span data-tip="原文は英語">${ic("ti-language")} EN</span>` : "",
    `<span>${esc(it.source)}</span>`,
    kws.length ? `<span class="kw" data-tip="キーワード：${esc(kws.join("・"))}">${ic("ti-bell-ringing")}</span>` : "",
  ].join("");
}

const bmBtn = (id, cls = "ib sm ghost") => `<button class="${cls} bm ${P.bookmarks.has(id) ? "on" : ""}" data-bm="${esc(id)}" data-tip="${P.bookmarks.has(id) ? "保存済み" : "あとで読む"}">${ic(P.bookmarks.has(id) ? "ti-bookmark-filled" : "ti-bookmark")}</button>`;

function rowHTML(it, i = 0, terms = [], extra = "") {
  return `<article class="row rv ${P.read.has(it.id) ? "read" : ""}" style="--cat:${catColor(it.category)};--i:${i}" data-open="${esc(it.id)}">
    ${catIc(it.category)}
    <div class="body">
      <h3>${hl(it.title, terms)}</h3>
      <p class="sub">${hl(it.note || it.summary, terms)}</p>
      <div class="meta" style="margin-top:6px"><span class="m-cat">${catIc(it.category, false)}</span>${metaLine(it)}</div>
      ${extra}
    </div>
    <div class="acts">
      ${dlBadge(it)}
      ${bmBtn(it.id)}
      <span class="ib sm ghost go" aria-hidden="true">${ic("ti-arrow-right")}</span>
    </div>
  </article>`;
}

function heroHTML(it) {
  return `<section class="hero rv" style="--i:0;--cat:${catColor(it.category)}" data-open="${esc(it.id)}">
    <span class="glow"></span>
    <span class="deco">${logoSVG({ full: false })}</span>
    <span class="rib">${ic("ti-star-filled")} PICK</span>
    <div class="meta">${catIc(it.category)}${metaLine(it)}</div>
    <h2>${esc(it.title)}</h2>
    <p>${esc(it.note || it.summary)}</p>
    <div class="acts">
      <a class="btn" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" data-read="${esc(it.id)}">${ic("ti-external-link")}読む</a>
      ${bmBtn(it.id, "ib")}
      <button class="ib" data-open-btn="${esc(it.id)}" data-tip="くわしく">${ic("ti-info-circle")}</button>
    </div>
  </section>`;
}

const emptyHTML = (title, body = "") => `<div class="empty rv in">${logoSVG({ full: false })}<b>${esc(title)}</b>${esc(body)}</div>`;
const pageHead = (icon, title, right = "") => `<div class="ph rv" style="--i:0"><span class="pi">${ic(icon)}</span><h1>${title}</h1>${right}</div>`;

/* ================================================================== views */
function viewToday() {
  if (!S.items.length) return `<div class="page">${emptyHTML("まだ記事がありません", "次の便（10:00 / 17:00 / 22:00）をお待ちください")}</div>`;
  const dates = [...new Set(S.items.map(it => it.date))].sort().reverse().slice(0, 4);
  const latest = S.items.filter(it => it.date === dates[0]);
  const pick = [...latest].sort((a, b) => b.importance - a.importance || kwOf(b).length - kwOf(a).length)[0];

  const groups = [];
  for (const d of dates) for (const slot of ["22", "17", "10"]) {
    const its = S.items.filter(it => it.date === d && String(it.slot) === slot && it !== pick).sort((a, b) => b.importance - a.importance);
    if (its.length) groups.push({ key: `${d}-${slot}`, d, slot, its });
  }
  const batches = groups.map((g, gi) => {
    const open = P.open.has(g.key) || (gi === 0 && !P.open.has("closed:" + g.key));
    const day = new Date(g.d + "T00:00:00");
    const dayLbl = g.d === todayStr() ? "今日" : `${day.getMonth() + 1}/${day.getDate()}（${WEEK[day.getDay()]}）`;
    const cats = [...new Set(g.its.map(it => it.category))];
    return `<section class="batch rv" style="--i:${gi + 1}">
      <div class="batch-h ${open ? "open" : ""}" data-batch="${g.key}" role="button" aria-expanded="${open}">
        <span class="time">${SLOT_LABEL[g.slot]}</span>
        <span class="day"><b>${dayLbl}</b><span class="cats">${cats.map(c => catIc(c)).join("")}</span></span>
        <span class="rule"></span><span class="cnt">${g.its.length}</span>${ic("ti-chevron-down chev")}
      </div>
      <div class="batch-body"><div><div class="rows">${g.its.map((it, i) => rowHTML(it, i)).join("")}</div></div></div>
    </section>`;
  }).join("");

  const d0 = new Date(dates[0] + "T00:00:00");
  return `<div class="page">
    ${pageHead("ti-sun", "今日のヒカリ", `<span class="when">${ic("ti-calendar")}${d0.getMonth() + 1}/${d0.getDate()} ${WEEK[d0.getDay()]}${S.updated ? ` ・ ${ic("ti-refresh")}${esc(String(S.updated).slice(11, 16))}` : ""}</span>`)}
    <div class="grid2">
      <div>${heroHTML(pick)}${batches}${S.loadMore ? `<p style="text-align:center;margin-top:48px"><button class="btn plain" id="older">${ic("ti-history")}もっと前</button></p>` : ""}</div>
      ${sideHTML()}
    </div>
  </div>`;
}

function sideHTML() {
  const up = S.items.filter(it => it.deadline && daysUntil(it.deadline) >= 0).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 4);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toLocaleDateString("sv-SE");
  const top = S.items.filter(it => it.date >= weekAgo).sort((a, b) => b.importance - a.importance || sortNew(a, b)).slice(0, 5);
  const allKw = [...new Set([...S.keywords, ...P.myKw])];
  const st = readStats();
  return `<aside class="side-col">
    <div class="box rv" style="--i:2"><div class="box-h"><span class="hi h">${ic("ti-hourglass")}</span>締め切り<a class="ib sm ghost more" href="#/chance" data-tip="チャンス一覧">${ic("ti-arrow-right")}</a></div>
      ${up.length ? up.map(it => `<a class="mini" data-open="${esc(it.id)}">${dlBadge(it)}<span class="t">${esc(it.title)}</span></a>`).join("") : `<p style="color:var(--muted);margin:0;font-size:13px">なし</p>`}</div>
    <div class="box rv" style="--i:3"><div class="box-h"><span class="hi">${ic("ti-flame")}</span>今週の人気</div>
      ${top.map((it, i) => `<a class="mini" data-open="${esc(it.id)}"><span class="rank">${i + 1}</span><span class="t">${esc(it.title)}</span></a>`).join("")}</div>
    <div class="box rv" style="--i:4"><div class="box-h"><span class="hi p">${ic("ti-bell-ringing")}</span>キーワード</div>
      <div class="kw-list">${allKw.map(k => {
        const n = S.items.filter(it => itemText(it).includes(norm(k))).length;
        const mine = P.myKw.includes(k);
        return `<span class="chip" style="--cat:var(--peach)" data-kw="${esc(k)}">${esc(k)}<span class="n">${n}</span>${mine ? `<i class="ti ti-x" data-rmkw="${esc(k)}" data-tip="削除"></i>` : ""}</span>`;
      }).join("")}</div>
      <form class="kwin" id="kwform"><input type="text" id="kwinput" maxlength="20" placeholder="追加…"><button class="ib sm" data-tip="追加">${ic("ti-plus")}</button></form></div>
    <div class="box rv" style="--i:5"><div class="box-h"><span class="hi">${ic("ti-chart-bar")}</span>学習ログ<a class="ib sm ghost more" href="#/saved" data-tip="マイページ">${ic("ti-arrow-right")}</a></div>
      <div class="stat">
        <div data-tip="今週読んだ記事">${ic("ti-book")}<b data-count="${st.week}">0</b></div>
        <div data-tip="連続日数">${ic("ti-flame")}<b data-count="${st.streak}">0</b></div>
        <div data-tip="あとで読む">${ic("ti-bookmark")}<b data-count="${P.bookmarks.size}">0</b></div></div></div>
  </aside>`;
}

function readStats() {
  const ts = [...P.read.values()].map(Number);
  const days = new Set(ts.map(t => new Date(t).toLocaleDateString("sv-SE")));
  let streak = 0;
  for (let d = new Date(); days.has(d.toLocaleDateString("sv-SE")); d.setDate(d.getDate() - 1)) streak++;
  return { week: ts.filter(t => t >= Date.now() - 7 * 864e5).length, total: ts.length, streak };
}

/* ---------------------------------------------------------------- search */
const F_DEF = { q: "", cats: "", lvl: "", lang: "", period: "", dl: "", min: "", sort: "new" };

function viewSearch() {
  const f = { ...F_DEF, ...S.params };
  const chip = (key, val, inner, color = "var(--lemon)", tip = "") => {
    const on = key === "cats" ? f.cats.split(",").includes(val) : f[key] === val;
    return `<button class="chip ${on ? "on" : ""}" style="--cat:${color}" data-f="${key}" data-v="${esc(val)}" ${tip ? `data-tip="${esc(tip)}"` : ""}>${inner}</button>`;
  };
  return `<div class="page">
    ${pageHead("ti-search", "さがす")}
    <div class="sbar rv in">${ic("ti-search")}<input type="search" id="sq" value="${esc(f.q)}" placeholder="シェーダー、Godot、インターン…" autofocus></div>
    <div class="filters rv in">
      <div class="frow"><span class="fl" data-tip="カテゴリ">${ic("ti-category")}</span>
        ${S.cats.map(c => chip("cats", c.id, `${ic(CAT_ICON[c.id] || "ti-point")}${esc(c.name)}`, "#" + c.color)).join("")}</div>
      <div class="frow"><span class="fl" data-tip="難易度・原文の言語">${ic("ti-adjustments")}</span>
        ${["入門", "中級", "上級"].map(l => chip("lvl", l, `${level(l).replace(/data-tip="[^"]*"/, "")}${l}`)).join("")}
        <span class="sep"></span>${chip("lang", "ja", "日本語")}${chip("lang", "en", `${ic("ti-language")}英語`)}</div>
      <div class="frow"><span class="fl" data-tip="期間・条件">${ic("ti-calendar")}</span>
        ${chip("period", "1", "今日")}${chip("period", "7", "1週間")}${chip("period", "30", "1か月")}
        <span class="sep"></span>${chip("dl", "1", `${ic("ti-hourglass")}締め切り`, "var(--hot)")}${chip("min", "4", `${ic("ti-star-filled")}4+`)}${chip("min", "5", `${ic("ti-star-filled")}5`)}</div>
      <div class="frow"><span class="fl" data-tip="並び順">${ic("ti-arrows-sort")}</span>
        ${chip("sort", "new", `${ic("ti-clock")}新しい順`, "var(--peach)")}${chip("sort", "imp", `${ic("ti-star")}おすすめ順`, "var(--peach)")}
        <button class="ib sm ghost" id="freset" data-tip="リセット" style="margin-left:auto">${ic("ti-refresh")}</button></div>
    </div>
    <div id="results"></div>
  </div>`;
}

function runSearch() {
  const f = { ...F_DEF, ...S.params };
  const terms = norm(f.q).split(/\s+/).filter(Boolean);
  const cats = f.cats ? f.cats.split(",") : [];
  const since = f.period ? new Date(Date.now() - (Number(f.period) - 1) * 864e5).toLocaleDateString("sv-SE") : "";
  const list = S.items.filter(it => {
    if (cats.length && !cats.includes(it.category)) return false;
    if (f.lvl && it.level !== f.lvl) return false;
    if (f.lang && it.lang !== f.lang) return false;
    if (since && it.date < since) return false;
    if (f.dl && !it.deadline) return false;
    if (f.min && it.importance < Number(f.min)) return false;
    if (terms.length) { const t = itemText(it); return terms.every(w => t.includes(w)); }
    return true;
  }).sort(f.sort === "imp" ? (a, b) => b.importance - a.importance || sortNew(a, b) : sortNew);
  const raw = f.q.split(/\s+/).filter(Boolean);
  $("#results").innerHTML = `<p class="count"><b>${list.length}</b>件</p>` +
    (list.length ? `<div class="rows" style="padding:0">${list.slice(0, 120).map((it, i) => rowHTML(it, Math.min(i, 10), raw)).join("")}</div>`
                 : emptyHTML("見つかりませんでした", "キーワードを短くするか、条件を減らしてみてください"));
  revealIn($("#results"));
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
  const all = S.items.filter(it => it.deadline).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const cnt = { all: all.filter(it => daysUntil(it.deadline) >= 0).length, want: all.filter(it => P.chance[it.id] === "want").length,
                done: all.filter(it => P.chance[it.id] === "done").length, past: all.filter(it => daysUntil(it.deadline) < 0).length };
  let list = all;
  if (f === "want") list = all.filter(it => P.chance[it.id] === "want");
  else if (f === "done") list = all.filter(it => P.chance[it.id] === "done");
  else if (f === "past") list = all.filter(it => daysUntil(it.deadline) < 0).reverse();
  else list = all.filter(it => daysUntil(it.deadline) >= 0);
  const groups = [["今週まで", "ti-flame", d => d >= 0 && d <= 7], ["今月中", "ti-calendar-week", d => d > 7 && d <= 31], ["それ以降", "ti-calendar", d => d > 31], ["終了", "ti-archive", d => d < 0]];
  let i = 0;
  const body = groups.map(([name, icon, fn]) => {
    const g = list.filter(it => fn(daysUntil(it.deadline)));
    if (!g.length) return "";
    return `<div class="tl-g rv" style="--i:${i++}">${ic(icon)}${name}</div>` + g.map(it => {
      const st = P.chance[it.id];
      const extra = `<div style="display:flex;gap:6px;margin-top:10px">
        <button class="ib sm ${st === "want" ? "on" : ""}" data-chance="${esc(it.id)}" data-st="want" data-tip="気になる">${ic(st === "want" ? "ti-heart-filled" : "ti-heart")}</button>
        <button class="ib sm ${st === "done" ? "on" : ""}" data-chance="${esc(it.id)}" data-st="done" data-tip="応募済み">${ic("ti-send")}</button></div>`;
      return `<div class="tl-item"><span class="tl-dot" style="--cat:${catColor(it.category)}"></span>${rowHTML(it, i++, [], extra)}</div>`;
    }).join("");
  }).join("");
  const tab = (k, icon, l) => `<a class="${f === k ? "on" : ""}" href="#/chance${k === "all" ? "" : "?f=" + k}">${ic(icon)}${l}<span class="n">${cnt[k]}</span></a>`;
  return `<div class="page">
    ${pageHead("ti-trophy", "チャンス")}
    <div class="seg rv" style="--i:1">${tab("all", "ti-door-enter", "受付中")}${tab("want", "ti-heart", "気になる")}${tab("done", "ti-send", "応募済み")}${tab("past", "ti-archive", "終了")}</div>
    <div class="tl">${body || emptyHTML("該当なし", "チャンス情報は毎週 月・木 の 22:00 便で届きます")}</div>
  </div>`;
}

/* ----------------------------------------------------------------- saved */
function viewSaved() {
  const tab = S.params.t || "later";
  const st = readStats();
  const list = tab === "read"
    ? S.items.filter(it => P.read.has(it.id)).sort((a, b) => P.read.get(b.id) - P.read.get(a.id))
    : S.items.filter(it => P.bookmarks.has(it.id)).sort(sortNew);
  const byCat = S.cats.map(c => ({ c, n: S.items.filter(it => it.category === c.id && P.read.has(it.id)).length }));
  const max = Math.max(1, ...byCat.map(x => x.n));
  const t = (k, icon, l, n) => `<a class="${tab === k ? "on" : ""}" href="#/saved${k === "later" ? "" : "?t=" + k}">${ic(icon)}${l}<span class="n">${n}</span></a>`;
  return `<div class="page">
    ${pageHead("ti-bookmarks", "マイページ")}
    <div class="grid2">
      <div>
        <div class="seg rv" style="--i:1">${t("later", "ti-bookmark", "あとで読む", P.bookmarks.size)}${t("read", "ti-circle-check", "読んだ", P.read.size)}</div>
        ${list.length ? `<div class="rows" style="padding:0">${list.map((it, i) => rowHTML(it, i)).join("")}</div>`
          : emptyHTML(tab === "read" ? "まだありません" : "保存した記事はありません", tab === "read" ? "記事を開くと記録されます" : "しおりのアイコンで保存できます")}
      </div>
      <aside class="side-col">
        <div class="box rv" style="--i:2"><div class="box-h"><span class="hi">${ic("ti-chart-bar")}</span>学習ログ</div>
          <div class="stat"><div data-tip="累計">${ic("ti-books")}<b data-count="${st.total}">0</b></div><div data-tip="今週">${ic("ti-book")}<b data-count="${st.week}">0</b></div><div data-tip="連続日数">${ic("ti-flame")}<b data-count="${st.streak}">0</b></div></div></div>
        <div class="box rv" style="--i:3"><div class="box-h"><span class="hi p">${ic("ti-chart-pie")}</span>ジャンル</div>
          ${byCat.map(({ c, n }) => `<div style="display:flex;align-items:center;gap:10px;margin:10px 0">${catIc(c.id)}
            <div style="flex:1;height:10px;background:var(--ink-4);border-radius:5px;overflow:hidden"><div class="bar" style="height:100%;width:0;background:#${c.color};border-radius:5px;transition:width .9s var(--out)" data-w="${(n / max) * 100}"></div></div>
            <b style="font:700 14px var(--f-num);width:20px;text-align:right">${n}</b></div>`).join("")}</div>
      </aside>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- admin */
function viewAdmin() {
  if (!S.adminApi) return `<div class="page">${emptyHTML("管理", "デモモードでは使えません")}</div>`;
  return `<div class="page">${pageHead("ti-shield-check", "管理")}<div id="admin-list" class="loader">${logoSVG({ full: false })}</div></div>`;
}
async function renderAdminList() {
  const g = await S.adminApi.list();
  const row = (u, acts) => `<div class="user rv in"><div class="who"><b>${esc(u.name)}</b><small>${esc(u.email)}</small><small>${esc(u.note)}</small></div>
    ${acts.map(([a, icon, tip, cls]) => `<button class="ib ${cls}" data-act="${a}" data-uid="${esc(u.uid)}" data-tip="${tip}">${ic(icon)}</button>`).join("")}</div>`;
  const sec = (icon, title, list, acts) => `<div class="adm-h">${ic(icon)}${title}<span class="n" style="color:var(--muted)">${list.length}</span></div>` +
    (list.map(u => row(u, acts)).join("") || `<p style="color:var(--muted)">なし</p>`);
  const el = $("#admin-list"); el.className = "";
  el.innerHTML = sec("ti-user-question", "承認待ち", g.pending, [["approved", "ti-check", "承認", "on"], ["rejected", "ti-x", "拒否", ""]]) +
    sec("ti-user-check", "承認済み", g.approved, [["rejected", "ti-user-off", "承認を取り消す", ""]]) +
    sec("ti-user-x", "拒否", g.rejected, [["approved", "ti-check", "承認", "on"], ["delete", "ti-trash", "削除（再申請可能に）", ""]]);
  updateAdminBadge(g.pending.length);
}
function updateAdminBadge(n) { const b = $("#admin-badge"); b.hidden = !n; b.textContent = n; }

/* ============================================================ gate views */
const gate = inner => `<div class="gate"><div class="orbs">${[[12, 20], [80, 14], [70, 78], [20, 72], [48, 8]].map(([x, y], i) =>
  `<i class="ti ti-star-filled" style="left:${x}%;top:${y}%;animation-delay:-${i * 1.7}s"></i>`).join("")}</div><div class="gate-card">${logoSVG()}${inner}</div></div>`;
const GATES = {
  loading: () => `<div class="loader">${logoSVG({ full: false })}</div>`,
  setup: () => gate(`<h2>設定が未完了です</h2><p>public/firebase-config.js を設定してください</p>`),
  login: () => gate(`<h2>HIKARI NEWS</h2><p>ゲーム制作を学ぶ人のための情報を、毎日 3 回。<br>閲覧には管理者の承認が必要です。</p>
    <button class="btn" id="login">${ic("ti-brand-google")}Google でログイン</button><div class="msg" id="login-msg"></div>`),
  apply: name => gate(`<h2>閲覧申請</h2><p>承認されると読めるようになります</p>
    <form id="apply-form"><label for="apply-name">${ic("ti-user")}お名前（ニックネーム可）</label><input type="text" id="apply-name" maxlength="50" required value="${esc(name || "")}">
    <label for="apply-note">${ic("ti-message")}ひとこと（所属など）</label><textarea id="apply-note" maxlength="300"></textarea>
    <p style="margin-top:20px;text-align:center"><button class="btn" id="apply-submit">${ic("ti-send")}申請する</button></p><div class="msg" id="apply-msg"></div></form>`),
  pending: () => gate(`<h2>承認待ち</h2><p>申請を受け付けました</p><button class="btn plain" id="recheck">${ic("ti-refresh")}再確認</button>`),
  rejected: () => gate(`<h2>承認されませんでした</h2><p>心当たりがない場合は管理者に連絡してください</p>`),
  error: msg => gate(`<h2>読み込みに失敗しました</h2><p>${esc(msg)}</p><button class="btn plain" id="recheck">${ic("ti-refresh")}再読み込み</button>`),
};
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
  return { route: VIEWS[path] ? path : "today", params: Object.fromEntries(new URLSearchParams(qs || "")) };
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
    afterDraw();
    moveIndicator();
    if (changed) window.scrollTo({ top: 0, behavior: "instant" });
  };
  if (first || !changed || REDUCED) { first = false; draw(); } else wipe(draw);
}
const redraw = () => { $("#view").innerHTML = VIEWS[S.route](); if (S.route === "search") runSearch(); afterDraw(); };

/* --------------------------------------------------- scroll-in & counters */
// 画面に入った要素から順に表示（IntersectionObserver に頼らず、スクロール時に自前で判定）
let pending = [];
function checkReveal() {
  const h = innerHeight * 0.94;
  pending = pending.filter(el => {
    if (!el.isConnected) return false;
    if (el.getBoundingClientRect().top < h) { el.classList.add("in"); return false; }
    return true;
  });
}
function revealIn(root = document) { pending.push(...$$(".rv:not(.in)", root)); checkReveal(); }
setInterval(() => pending.length && checkReveal(), 700);   // スクロール以外（リサイズ・展開など）でも取りこぼさない
function afterDraw() {
  revealIn($("#view"));
  $$("[data-count]").forEach(el => countUp(el, Number(el.dataset.count)));
  setTimeout(() => $$(".bar[data-w]").forEach(b => { b.style.width = b.dataset.w + "%"; }), 40);
}
function countUp(el, to) {
  if (REDUCED || !to) { el.textContent = to; return; }
  const t0 = performance.now(), dur = 700;
  const step = t => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  setTimeout(() => { el.textContent = to; }, dur + 400);   // rAF が止まっていても最終値は必ず表示
}

/* ----------------------------------------------------------------- wipe */
function wipe(midway) {
  const w = $("#wipe"); w.hidden = false;
  const bands = $$("i", w), mark = $("#wipe-mark");
  const at = x => `translateX(${x}) skewX(-18deg)`;
  const run = (from, to, dur, step, ease) => Promise.race([
    Promise.all(bands.map((b, i) => b.animate([{ transform: at(from) }, { transform: at(to) }], { duration: dur, delay: i * step, easing: ease, fill: "forwards" }).finished)),
    new Promise(r => setTimeout(r, dur + 300)),
  ]);
  mark.animate([{ transform: "translate(-50%,-50%) scale(0) rotate(-120deg)" }, { transform: "translate(-50%,-50%) scale(1) rotate(0)", offset: .55 },
                { transform: "translate(-50%,-50%) scale(1) rotate(0)", offset: .8 }, { transform: "translate(-50%,-50%) scale(0) rotate(60deg)" }],
               { duration: 760, delay: 200, easing: "cubic-bezier(.34,1.56,.64,1)" });
  run("-260vw", "-75vw", 300, 55, "cubic-bezier(.7,0,.2,1)")
    .then(() => { midway(); return new Promise(r => setTimeout(r, 160)); })
    .then(() => run("-75vw", "120vw", 420, -45, "cubic-bezier(.6,0,.15,1)"))
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
  const shared = x => (x.tags || []).filter(t => (it.tags || []).includes(t)).length;
  const related = S.items.filter(x => x.id !== id && (x.category === it.category || shared(x)))
    .sort((a, b) => shared(b) - shared(a) || sortNew(a, b)).slice(0, 4);
  const d = $("#drawer");
  d.style.setProperty("--cat", catColor(it.category));
  d.innerHTML = `<div class="band">
      ${catIc(it.category)}
      <div class="tb">${bmBtn(it.id, "ib")}
        <button class="ib ${P.read.has(it.id) ? "on" : ""}" data-toggle-read="${esc(it.id)}" data-tip="${P.read.has(it.id) ? "読了" : "読了にする"}">${ic("ti-circle-check")}</button>
        <button class="ib" data-copy="${esc(it.url)}" data-tip="リンクをコピー">${ic("ti-link")}</button>
        <button class="ib" data-close data-tip="閉じる">${ic("ti-x")}</button></div>
      <h2>${esc(it.title)}</h2>
      <div class="meta" style="margin-top:12px">${metaLine(it)}${dlBadge(it)}</div>
    </div>
    <div class="in">
      <p class="sum">${esc(it.summary)}</p>
      ${it.note ? `<div class="learn">${ic("ti-bulb")}<span>${esc(it.note)}</span></div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:6px">${(it.tags || []).map(t => `<a class="chip" href="#/search?q=${encodeURIComponent(t)}" data-close>${ic("ti-hash")}${esc(t)}</a>`).join("")}</div>
      <div class="dact"><a class="btn" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" data-read="${esc(it.id)}">${ic("ti-external-link")}原文を読む</a>
        <span style="color:var(--dim);font-size:12px">${ic("ti-calendar")} ${esc(it.date)} ${esc(SLOT_LABEL[it.slot] || "")}</span></div>
      ${related.length ? `<div class="dh">${ic("ti-sparkles")}関連</div>${related.map(x => `<a class="mini" data-open="${esc(x.id)}">${catIc(x.category, false)}<span class="t">${esc(x.title)}</span></a>`).join("")}` : ""}
    </div>`;
  d.scrollTop = 0;
  d.classList.add("on"); d.setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("on");
}
function closeDetail() { $("#drawer").classList.remove("on"); $("#drawer").setAttribute("aria-hidden", "true"); $("#scrim").classList.remove("on"); }

/* =============================================================== palette */
let palSel = 0, palHits = [];
function openPal() { if (!S.ready) return; $("#pal").hidden = false; const q = $("#pal-q"); q.value = ""; palQuery(""); setTimeout(() => q.focus(), 10); }
function closePal() { $("#pal").hidden = true; }
function palQuery(q) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  palHits = (terms.length ? S.items.filter(it => { const t = itemText(it); return terms.every(w => t.includes(w)); })
    .sort((a, b) => (norm(b.title).includes(terms[0]) - norm(a.title).includes(terms[0])) || sortNew(a, b))
    : [...S.items].sort(sortNew)).slice(0, 8);
  palSel = 0;
  const raw = q.split(/\s+/).filter(Boolean);
  $("#pal-list").innerHTML = palHits.map((it, i) => `<li class="${i === 0 ? "sel" : ""}" data-i="${i}">${catIc(it.category, false)}
    <span class="t">${hl(it.title, raw)}<small>${esc(it.source)} ・ ${esc(it.date)}</small></span>${ic("ti-corner-down-left")}</li>`).join("")
    || `<li><span class="t" style="color:var(--muted)">見つかりませんでした</span></li>`;
}
function palMove(d) {
  if (!palHits.length) return;
  palSel = (palSel + d + palHits.length) % palHits.length;
  $$("#pal-list li").forEach((li, i) => li.classList.toggle("sel", i === palSel));
  $$("#pal-list li")[palSel]?.scrollIntoView({ block: "nearest" });
}

/* ================================================================ effects */
function toast(icon, msg) {
  $$(".toast").forEach(t => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.innerHTML = `${ic(icon)}${esc(msg)}`;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2300);
}
function burst(el) {
  if (REDUCED) return;
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < 8; i++) {
    const s = document.createElement("i");
    s.className = "ti ti-star-filled burst";
    s.style.left = cx - 7 + "px"; s.style.top = cy - 7 + "px";
    if (i % 2) s.style.color = "var(--peach)";
    document.body.appendChild(s);
    const a = (i / 8) * Math.PI * 2 + Math.random() * .4, dist = 28 + Math.random() * 22;
    s.animate([{ transform: "translate(0,0) scale(.4) rotate(0)", opacity: 1 },
               { transform: `translate(${Math.cos(a) * dist}px,${Math.sin(a) * dist}px) scale(1) rotate(${(Math.random() - .5) * 180}deg)`, opacity: 0 }],
              { duration: 600, easing: "cubic-bezier(.16,1,.3,1)" }).finished.then(() => s.remove());
  }
  el.animate([{ transform: "scale(1)" }, { transform: "scale(1.35) rotate(-12deg)" }, { transform: "scale(1)" }], { duration: 420, easing: "cubic-bezier(.34,1.56,.64,1)" });
}
function markRead(id) {
  if (!P.read.has(id)) { P.read.set(id, Date.now()); P.save(); }
  $$(`.row[data-open="${CSS.escape(id)}"]`).forEach(r => r.classList.add("read"));
}

/* ================================================================ events */
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-bm],[data-read],[data-toggle-read],[data-copy],[data-rmkw],[data-kw],[data-chance],[data-open-btn],[data-open],[data-close],[data-close-pal],[data-batch],[data-f],[data-act],#freset,#older,#pal-list li,#pal-all,#totop");
  if (!t) return;
  if (t.dataset.bm) {
    e.preventDefault();
    const id = t.dataset.bm, on = !P.bookmarks.has(id);
    on ? P.bookmarks.add(id) : P.bookmarks.delete(id); P.save();
    $$(`[data-bm="${CSS.escape(id)}"]`).forEach(b => { b.classList.toggle("on", on); b.dataset.tip = on ? "保存済み" : "あとで読む"; b.innerHTML = ic(on ? "ti-bookmark-filled" : "ti-bookmark"); });
    if (on) burst(t);
    toast(on ? "ti-bookmark-filled" : "ti-bookmark-off", on ? "あとで読む に追加" : "保存を解除");
  } else if (t.dataset.read) {
    markRead(t.dataset.read);
  } else if (t.dataset.toggleRead) {
    const id = t.dataset.toggleRead;
    P.read.has(id) ? P.read.delete(id) : P.read.set(id, Date.now()); P.save();
    openDetail(id); toast("ti-circle-check", P.read.has(id) ? "読了にしました" : "未読に戻しました");
    $$(`.row[data-open="${CSS.escape(id)}"]`).forEach(r => r.classList.toggle("read", P.read.has(id)));
  } else if (t.dataset.copy) {
    try { await navigator.clipboard.writeText(t.dataset.copy); toast("ti-link", "リンクをコピーしました"); } catch { toast("ti-alert-triangle", "コピーできませんでした"); }
  } else if (t.dataset.rmkw) {
    e.stopPropagation(); P.myKw = P.myKw.filter(k => k !== t.dataset.rmkw); P.save(); redraw();
  } else if (t.dataset.kw) {
    location.hash = `#/search?q=${encodeURIComponent(t.dataset.kw)}`;
  } else if (t.dataset.chance) {
    const id = t.dataset.chance, st = t.dataset.st;
    P.chance[id] = P.chance[id] === st ? undefined : st; P.save();
    if (P.chance[id]) burst(t);
    redraw(); toast(st === "done" ? "ti-send" : "ti-heart-filled", !P.chance[id] ? "解除しました" : st === "done" ? "応募済みにしました" : "気になるに追加");
  } else if (t.dataset.openBtn) {
    openDetail(t.dataset.openBtn);
  } else if (t.dataset.open) {
    openDetail(t.dataset.open);
  } else if (t.matches("[data-close]")) {
    closeDetail();
  } else if (t.matches("[data-close-pal]")) {
    closePal();
  } else if (t.dataset.batch) {
    const key = t.dataset.batch, open = !t.classList.contains("open");
    t.classList.toggle("open", open); t.setAttribute("aria-expanded", open);
    if (open) { P.open.add(key); P.open.delete("closed:" + key);
      $$(".row", t.nextElementSibling).forEach((r, i) => { r.style.setProperty("--i", i); r.classList.remove("in"); void r.offsetWidth; r.classList.add("in"); }); }
    else { P.open.delete(key); P.open.add("closed:" + key); }
    P.save();
  } else if (t.dataset.f) {
    const k = t.dataset.f, v = t.dataset.v, cur = { ...F_DEF, ...S.params };
    if (k === "cats") { const s = new Set(cur.cats.split(",").filter(Boolean)); s.has(v) ? s.delete(v) : s.add(v); setParams({ cats: [...s].join(",") }); }
    else setParams({ [k]: cur[k] === v && k !== "sort" ? "" : v });
    const c = { ...F_DEF, ...S.params };
    $$("[data-f]").forEach(b => b.classList.toggle("on", b.dataset.f === "cats" ? c.cats.split(",").includes(b.dataset.v) : c[b.dataset.f] === b.dataset.v));
  } else if (t.id === "freset") {
    S.params = {}; history.replaceState(null, "", "#/search"); redraw();
  } else if (t.id === "older" && S.loadMore) {
    t.disabled = true; await S.loadMore(); redraw();
  } else if (t.matches("#pal-list li") && palHits[t.dataset.i]) {
    closePal(); openDetail(palHits[t.dataset.i].id);
  } else if (t.id === "pal-all") {
    const q = $("#pal-q").value; closePal(); location.hash = `#/search${q ? "?q=" + encodeURIComponent(q) : ""}`;
  } else if (t.id === "totop") {
    window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
  } else if (t.dataset.act && S.adminApi) {
    t.disabled = true; await S.adminApi.setStatus(t.dataset.uid, t.dataset.act); await renderAdminList(); toast("ti-check", "更新しました");
  }
});

document.addEventListener("submit", e => {
  if (e.target.id !== "kwform") return;
  e.preventDefault();
  const v = $("#kwinput").value.trim();
  if (v && !P.myKw.includes(v)) { P.myKw.push(v); P.save(); toast("ti-bell-ringing", `「${v}」を追加`); }
  redraw();
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
  if (e.key === "Enter" && e.target.dataset?.batch) e.target.click();
});

// ヒーローのカーソル追従の光
document.addEventListener("pointermove", e => {
  const h = e.target.closest?.(".hero");
  if (!h) return;
  const r = h.getBoundingClientRect();
  h.style.setProperty("--mx", `${e.clientX - r.left}px`); h.style.setProperty("--my", `${e.clientY - r.top}px`);
});

// スクロール：ヘッダーの縮小・進捗バー・トップへ戻るボタン
let ticking = false;
function onScroll() {
  ticking = false;
  const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
  $("#hdr").classList.toggle("small", y > 40);
  $("#prog").style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
  $("#totop").classList.toggle("on", y > 700);
  checkReveal();
}
// rAF はタブが裏にあると止まるので、setTimeout で間引いて処理する
window.addEventListener("scroll", () => { if (!ticking) { ticking = true; setTimeout(onScroll, 40); } }, { passive: true });

$("#scrim").addEventListener("click", closeDetail);
$("#open-pal").addEventListener("click", openPal);
$("#theme").addEventListener("click", e => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  const apply = () => { document.documentElement.dataset.theme = next; try { localStorage.setItem("theme", next); } catch {}
    $("#theme").innerHTML = ic(next === "light" ? "ti-sun" : "ti-moon-stars"); };
  if (document.startViewTransition && !REDUCED) {   // 押した位置から円形に広がるテーマ切替
    document.documentElement.style.setProperty("--tx", e.clientX + "px");
    document.documentElement.style.setProperty("--ty", e.clientY + "px");
    document.startViewTransition(apply);
  } else apply();
});
window.addEventListener("hashchange", () => { closeDetail(); render(); });
window.addEventListener("resize", moveIndicator);

/* ================================================================== boot */
function intro() {
  if (REDUCED || sessionStorage.getItem("introDone")) return Promise.resolve();
  sessionStorage.setItem("introDone", "1");
  const el = document.createElement("div");
  el.className = "intro"; el.innerHTML = `${logoSVG()}<span class="tag">GAME DEV RADAR</span>`;
  document.body.appendChild(el);
  return new Promise(r => setTimeout(() => { el.classList.add("out"); setTimeout(() => { el.remove(); r(); }, 560); }, 1650));
}

function enterApp() {
  S.ready = true;
  $("#nav").hidden = $("#bnav").hidden = $("#open-pal").hidden = false;
  $("#nav-admin").hidden = !S.isAdmin;
  render();
  requestAnimationFrame(moveIndicator);
  document.fonts?.ready.then(moveIndicator);
}

function setData(items, meta = {}) {
  S.items = items.map(it => ({ ...it, slot: String(it.slot || "") }));
  if (meta.categories?.length) S.cats = meta.categories.map(c => ({ ...DEFAULT_CATS.find(d => d.id === c.id), ...c, color: DEFAULT_CATS.find(d => d.id === c.id)?.color || c.color || "F2F56A" }));
  S.keywords = meta.keywords || []; S.updated = meta.updated || null;
}

async function startDemo() {
  const tag = document.createElement("div"); tag.className = "demo"; tag.textContent = "DEMO"; document.body.appendChild(tag);
  showGate("loading");
  const [d] = await Promise.all([fetch("../samples/demo_site.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({})), intro()]);
  setData(d.items || [], d.meta || {});
  enterApp();
}

async function startFirebase() {
  showGate("loading");
  const introDone = intro();
  const { initializeApp } = await import(`${SDK}/firebase-app.js`);
  const A = await import(`${SDK}/firebase-auth.js`);
  const F = await import(`${SDK}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  $("#logout").onclick = () => A.signOut(auth).then(() => location.reload());

  const adminApi = {
    async list() {
      const snap = await F.getDocs(F.query(F.collection(db, "users"), F.orderBy("createdAt", "desc")));
      const g = { pending: [], approved: [], rejected: [] };
      snap.forEach(d => (g[d.data().status] || g.pending).push({ uid: d.id, ...d.data() }));
      return g;
    },
    async setStatus(uid, act) {
      const ref = F.doc(db, "users", uid);
      if (act === "delete") await F.deleteDoc(ref); else await F.updateDoc(ref, { status: act, reviewedAt: F.serverTimestamp() });
    },
  };

  async function loadItems() {
    const meta = await F.getDoc(F.doc(db, "meta", "site"));
    let last = null; const items = [];
    async function page() {
      const base = [F.collection(db, "items"), F.orderBy("createdAt", "desc")];
      const snap = await F.getDocs(last ? F.query(...base, F.startAfter(last), F.limit(PAGE_SIZE)) : F.query(...base, F.limit(PAGE_SIZE)));
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      last = snap.docs[snap.docs.length - 1] || last;
      S.loadMore = snap.size === PAGE_SIZE ? page : null;
      setData(items, meta.exists() ? meta.data() : {});
    }
    await page();
  }

  A.onAuthStateChanged(auth, async user => {
    await introDone;
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
        S.adminApi = S.isAdmin ? adminApi : null;
        enterApp();
        if (S.isAdmin) adminApi.list().then(g => updateAdminBadge(g.pending.length)).catch(() => {});
      } else if (status === "pending") showGate("pending");
      else if (status === "rejected") showGate("rejected");
      else {
        showGate("apply", user.displayName);
        $("#apply-form").onsubmit = async e => {
          e.preventDefault(); $("#apply-submit").disabled = true;
          try {
            await F.setDoc(F.doc(db, "users", user.uid), { name: $("#apply-name").value.trim(), note: $("#apply-note").value.trim(),
              email: user.email, photoURL: user.photoURL || "", status: "pending", createdAt: F.serverTimestamp() });
            showGate("pending");
          } catch (err) { $("#apply-msg").textContent = "送信できませんでした（" + err.code + "）"; $("#apply-submit").disabled = false; }
        };
      }
    } catch (err) { console.error(err); showGate("error", err.code || err.message); }
  });
}

$("#brand-logo").innerHTML = logoSVG({ full: false });
$("#open-pal kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
$("#wipe-mark").innerHTML = logoSVG({ full: false });
$("#theme").innerHTML = ic(document.documentElement.dataset.theme === "light" ? "ti-sun" : "ti-moon-stars");
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (isLocal && (new URLSearchParams(location.search).has("demo") || !firebaseConfig.apiKey)) startDemo();
else if (firebaseConfig.apiKey) startFirebase();
else showGate("setup");
