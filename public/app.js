import { firebaseConfig } from "./firebase-config.js";
import { logoSVG } from "./logo.js";
import { SDK, REDUCED, $, $$, esc, safeUrl, todayStr, daysUntil, norm, ic, hash, AREAS, CAT_ICON, SLOT_LABEL, WEEK,
         P, S, setData, setLearn, catOf, catColor, catIc, isSection, byId, itemText, kwOf, sortNew, level, dlBadge, hl,
         metaLine, bmBtn, rowHTML, heroHTML, emptyHTML, pageHead, toast, burst, countUp, copyText, paraHTML } from "./core.js";
import { initStarfield, showDrawer, closeDrawer } from "./fx.js";
import { viewProg, viewPlan, afterLearn, todayLearnSide, ladders, ladderHTML, kwHits, openKw, rankBox } from "./learn.js";

/* =========================================================================
   HIKARI NEWS — front-end v3
   ・アイコン中心の UI、斜めワイプ転換、カード → 詳細パネルの変形、星屑の背景
   ・今日／さがす／プログラマー／プランナー／チャンス／マイページ／管理
   ・Firebase（本番）/ ローカルのデモデータ（localhost?demo）
   ========================================================================= */

const PAGE_SIZE = 300;

/* ================================================================== views */
function viewToday() {
  const items = S.items.filter(it => !isSection(it));          // 分区のニュースは各分区に表示
  const lads = ladders().filter(g => ["10", "17", "22"].includes(g.slot));
  if (!items.length && !lads.length) return `<div class="page">${emptyHTML("まだ記事がありません", "次の便（10:00 / 17:00 / 22:00）をお待ちください")}</div>`;
  const dates = [...new Set([...items.map(it => it.date), ...lads.map(g => g.date)])].sort().reverse().slice(0, 4);
  const latest = items.filter(it => it.date === dates[0]);
  const top = [...(latest.length ? latest : items)].sort((a, b) => b.importance - a.importance || kwOf(b).length - kwOf(a).length)[0];

  const groups = [];
  for (const d of dates) for (const slot of ["22", "17", "10"]) {
    const its = items.filter(it => it.date === d && String(it.slot) === slot && it !== top).sort((a, b) => b.importance - a.importance);
    const kws = lads.filter(g => g.date === d && g.slot === slot);
    if (its.length || kws.length) groups.push({ key: `${d}-${slot}`, d, slot, its, kws });
  }
  const batches = groups.map((g, gi) => {
    const open = P.open.has(g.key) || (gi === 0 && !P.open.has("closed:" + g.key));
    const day = new Date(g.d + "T00:00:00");
    const dayLbl = g.d === todayStr() ? "今日" : `${day.getMonth() + 1}/${day.getDate()}（${WEEK[day.getDay()]}）`;
    const cats = [...new Set(g.its.map(it => it.category))];
    return `<section class="batch rv" style="--i:${gi + 1}">
      <div class="batch-h ${open ? "open" : ""}" data-batch="${g.key}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="time">${SLOT_LABEL[g.slot]}</span>
        <span class="day"><b>${dayLbl}</b><span class="cats">${cats.map(c => catIc(c)).join("")}${g.kws.length ? `<span class="cat-ic" style="--cat:var(--lemon)" data-tip="技術キーワード">${ic("ti-key")}</span>` : ""}</span></span>
        <span class="rule"></span><span class="cnt">${g.its.length}</span>${ic("ti-chevron-down chev")}
      </div>
      <div class="batch-body"><div>
        ${g.its.length ? `<div class="rows">${g.its.map((it, i) => rowHTML(it, i)).join("")}</div>` : ""}
        ${g.kws.map((k, i) => ladderHTML(k, g.its.length + i)).join("")}
      </div></div>
    </section>`;
  }).join("");

  const d0 = new Date(dates[0] + "T00:00:00");
  return `<div class="page">
    ${pageHead("ti-sun", "今日のヒカリ", `<span class="when">${ic("ti-calendar")}${d0.getMonth() + 1}/${d0.getDate()} ${WEEK[d0.getDay()]}${S.updated ? ` ・ ${ic("ti-refresh")}${esc(String(S.updated).slice(11, 16))}` : ""}</span>`)}
    <div class="grid2">
      <div>${top ? heroHTML(top) : ""}${batches}${S.loadMore ? `<p style="text-align:center;margin-top:48px"><button class="btn plain" id="older">${ic("ti-history")}もっと前</button></p>` : ""}</div>
      ${sideHTML(items)}
    </div>
  </div>`;
}

function sideHTML(items) {
  const up = items.filter(it => it.deadline && daysUntil(it.deadline) >= 0).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 4);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toLocaleDateString("sv-SE");
  const top = items.filter(it => it.date >= weekAgo).sort((a, b) => b.importance - a.importance || sortNew(a, b)).slice(0, 5);
  const allKw = [...new Set([...S.keywords, ...P.myKw])];
  const st = readStats();
  return `<aside class="side-col">
    ${todayLearnSide(1)}
    <div class="box rv" style="--i:2"><div class="box-h"><span class="hi h">${ic("ti-hourglass")}</span>締め切り<a class="ib sm ghost more" href="#/chance" data-tip="チャンス一覧">${ic("ti-arrow-right")}</a></div>
      ${up.length ? up.map(it => `<a class="mini" data-open="${esc(it.id)}">${dlBadge(it)}<span class="t">${esc(it.title)}</span></a>`).join("") : `<p class="muted-s">なし</p>`}</div>
    <div class="box rv" style="--i:3"><div class="box-h"><span class="hi">${ic("ti-flame")}</span>今週の人気</div>
      ${top.map((it, i) => `<a class="mini" data-open="${esc(it.id)}"><span class="rank">${i + 1}</span><span class="t">${esc(it.title)}</span></a>`).join("")}</div>
    <div class="box rv" style="--i:4"><div class="box-h"><span class="hi p">${ic("ti-bell-ringing")}</span>キーワード</div>
      <div class="kw-list">${allKw.map(k => {
        const n = S.items.filter(it => itemText(it).includes(norm(k))).length;
        const mine = P.myKw.includes(k);
        return `<span class="chip" style="--cat:var(--peach)" data-kw="${esc(k)}">${esc(k)}<span class="n">${n}</span>${mine ? `<i class="ti ti-x" data-rmkw="${esc(k)}" data-tip="削除"></i>` : ""}</span>`;
      }).join("")}</div>
      <form class="kwin" id="kwform"><input type="text" id="kwinput" maxlength="20" placeholder="追加…"><button class="ib sm" data-tip="追加">${ic("ti-plus")}</button></form></div>
    <div class="box rv" style="--i:5"><div class="box-h"><span class="hi">${ic("ti-chart-bar")}</span>読書ログ<a class="ib sm ghost more" href="#/saved" data-tip="マイページ">${ic("ti-arrow-right")}</a></div>
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
        ${rankBox(2)}
        <div class="box rv" style="--i:3"><div class="box-h"><span class="hi">${ic("ti-chart-bar")}</span>読書ログ</div>
          <div class="stat"><div data-tip="累計">${ic("ti-books")}<b data-count="${st.total}">0</b></div><div data-tip="今週">${ic("ti-book")}<b data-count="${st.week}">0</b></div><div data-tip="連続日数">${ic("ti-flame")}<b data-count="${st.streak}">0</b></div></div></div>
        <div class="box rv" style="--i:4"><div class="box-h"><span class="hi p">${ic("ti-chart-pie")}</span>ジャンル</div>
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
const REP_ST = { new: "未確認", queued: "確認待ち", done: "対応済み" };
async function renderAdminList() {
  const g = await S.adminApi.list();
  let reps = [];
  try { reps = await S.adminApi.reports(); } catch (err) { console.warn("reports", err); }
  const row = (u, acts) => `<div class="user rv in"><div class="who"><b>${esc(u.name)}</b><small>${esc(u.email)}</small><small>${esc(u.note)}</small></div>
    ${acts.map(([a, icon, tip, cls]) => `<button class="ib ${cls}" data-act="${a}" data-uid="${esc(u.uid)}" data-tip="${tip}">${ic(icon)}</button>`).join("")}</div>`;
  const sec = (icon, title, list, acts) => `<div class="adm-h">${ic(icon)}${title}<span class="n" style="color:var(--muted)">${list.length}</span></div>` +
    (list.map(u => row(u, acts)).join("") || `<p class="muted-s">なし</p>`);
  const repHTML = `<div class="adm-h">${ic("ti-flag")}問題の報告<span class="n" style="color:var(--muted)">${reps.length}</span></div>` +
    (reps.map(r => `<div class="user rv in"><div class="who"><b>${esc(r.q)}</b><small>${esc(r.reason)}</small><small>${esc(r.track)} / ${esc(r.topic)} ・ ${esc(REP_ST[r.status] || r.status)}</small></div>
      <button class="ib" data-rep-del="${esc(r.id)}" data-tip="削除">${ic("ti-trash")}</button></div>`).join("") || `<p class="muted-s">なし</p>`);
  const el = $("#admin-list");
  if (!el) return;
  el.className = "";
  el.innerHTML = sec("ti-user-question", "承認待ち", g.pending, [["approved", "ti-check", "承認", "on"], ["rejected", "ti-x", "拒否", ""]]) +
    sec("ti-user-check", "承認済み", g.approved, [["rejected", "ti-user-off", "承認を取り消す", ""]]) +
    sec("ti-user-x", "拒否", g.rejected, [["approved", "ti-check", "承認", "on"], ["delete", "ti-trash", "削除（再申請可能に）", ""]]) + repHTML;
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
const VIEWS = { today: viewToday, search: viewSearch, prog: viewProg, plan: viewPlan, chance: viewChance, saved: viewSaved, admin: viewAdmin };
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
  const moved = changed || params.t !== S.params.t || params.run !== S.params.run || params.id !== S.params.id;
  S.route = route; S.params = params;
  const draw = () => {
    $("#view").innerHTML = VIEWS[route]();
    if (route === "search") runSearch();
    if (route === "admin" && S.adminApi) renderAdminList();
    afterDraw();
    moveIndicator();
    if (moved) window.scrollTo({ top: 0, behavior: "instant" });
  };
  if (first || !changed || REDUCED) { first = false; draw(); } else wipe(draw);
}
const redraw = () => { $("#view").innerHTML = VIEWS[S.route](); if (S.route === "search") runSearch(); afterDraw(); };
S.api.redraw = redraw;

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
setInterval(() => {
  if (pending.length) checkReveal();   // スクロール以外（リサイズ・展開など）でも取りこぼさない
  // アニメーションが進まない環境（裏のタブ・非表示のプレビューなど）でも、時間がたてば必ず表示する
  const now = Date.now();
  $$(".rv.in:not(.done)").forEach(el => { if (!el._seen) el._seen = now; else if (now - el._seen > 1500) el.classList.add("done"); });
}, 700);
function afterDraw() {
  revealIn($("#view"));
  $$("#view [data-count]").forEach(el => countUp(el, Number(el.dataset.count)));
  setTimeout(() => $$(".bar[data-w]").forEach(b => { b.style.width = b.dataset.w + "%"; }), 40);
  afterLearn();
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
function openDetail(id, fromEl, point) {
  const it = byId(id);
  if (!it) return;
  const shared = x => (x.tags || []).filter(t => (it.tags || []).includes(t)).length;
  const related = S.items.filter(x => x.id !== id && (x.category === it.category || shared(x)))
    .sort((a, b) => shared(b) - shared(a) || sortNew(a, b)).slice(0, 4);
  const pts = it.points || [], terms = it.terms || [];
  const html = `<div class="band">
      <div class="tb dz" style="--d:1">${bmBtn(it.id, "ib")}
        <button class="ib ${P.read.has(it.id) ? "on" : ""}" data-toggle-read="${esc(it.id)}" data-tip="${P.read.has(it.id) ? "読了" : "読了にする"}">${ic("ti-circle-check")}</button>
        <button class="ib" data-copy="${esc(it.url)}" data-tip="リンクをコピー">${ic("ti-link")}</button>
        <button class="ib" data-close data-tip="閉じる">${ic("ti-x")}</button></div>
      <div class="b-top dz" style="--d:0">${catIc(it.category, false)}<span class="b-cat">${esc(catOf(it.category).name)}</span>
        <span class="b-date">${ic("ti-calendar")}${esc(it.date)} ${esc(SLOT_LABEL[it.slot] || "")}</span></div>
      <h2 class="dz" style="--d:1">${esc(it.title)}</h2>
      <div class="meta dz" style="--d:2">${metaLine(it)}${dlBadge(it)}</div>
    </div>
    <div class="dgrid">
      <div class="dmain">
        <p class="lead dz" style="--d:3">${esc(it.summary)}</p>
        ${pts.length ? `<section class="dsec dz" style="--d:4"><h3 class="sh">${ic("ti-list-check")}要点</h3>
          <ol class="pts">${pts.map((p, k) => `<li style="--k:${k}">${esc(p)}</li>`).join("")}</ol></section>` : ""}
        ${it.detail ? `<section class="dsec"><h3 class="sh dz" style="--d:5">${ic("ti-file-description")}解説</h3>${paraHTML(it.detail, 6)}</section>` : ""}
        ${it.note ? `<div class="learn dz" style="--d:9">${ic("ti-bulb")}<span>${esc(it.note)}</span></div>` : ""}
      </div>
      <aside class="dside">
        <a class="btn big wide dz" style="--d:3" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" data-read="${esc(it.id)}">${ic("ti-external-link")}原文を読む${it.lang === "en" ? `<small>英語</small>` : ""}</a>
        ${terms.length ? `<section class="dsec dz" style="--d:4"><h3 class="sh">${ic("ti-abc")}用語</h3>
          <dl class="terms">${terms.map(t => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.explain)}</dd></div>`).join("")}</dl></section>` : ""}
        ${(it.tags || []).length ? `<div class="dtags dz" style="--d:5">${it.tags.map(t => `<a class="chip" href="#/search?q=${encodeURIComponent(t)}" data-close>${ic("ti-hash")}${esc(t)}</a>`).join("")}</div>` : ""}
        ${related.length ? `<section class="dsec dz" style="--d:6"><h3 class="sh">${ic("ti-sparkles")}関連</h3>${related.map(x => `<a class="mini" data-open="${esc(x.id)}">${catIc(x.category, false)}<span class="t">${esc(x.title)}</span></a>`).join("")}</section>` : ""}
      </aside>
    </div>`;
  showDrawer(html, catColor(it.category), fromEl, point);
}
const closeDetail = () => closeDrawer();

/* =============================================================== palette */
let palSel = 0, palHits = [];
function openPal() { if (!S.ready) return; $("#pal").hidden = false; const q = $("#pal-q"); q.value = ""; palQuery(""); setTimeout(() => q.focus(), 10); }
function closePal() { $("#pal").hidden = true; }
function palQuery(q) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const its = (terms.length ? S.items.filter(it => { const t = itemText(it); return terms.every(w => t.includes(w)); })
    .sort((a, b) => (norm(b.title).includes(terms[0]) - norm(a.title).includes(terms[0])) || sortNew(a, b))
    : [...S.items].sort(sortNew)).slice(0, 8);
  palHits = [...kwHits(terms).map(k => ({ k })), ...its.map(it => ({ it }))];
  palSel = 0;
  const raw = q.split(/\s+/).filter(Boolean);
  $("#pal-list").innerHTML = palHits.map((h, i) => h.k
    ? `<li class="${i === 0 ? "sel" : ""}" data-i="${i}"><span class="cat-ic" style="--cat:${AREAS[h.k.area]?.color || "#F2F56A"}">${ic("ti-key")}</span>
        <span class="t">${hl(h.k.term, raw)}<small>技術キーワード ・ ${esc(h.k.theme || AREAS[h.k.area]?.name || "")}</small></span>${ic("ti-corner-down-left")}</li>`
    : `<li class="${i === 0 ? "sel" : ""}" data-i="${i}">${catIc(h.it.category, false)}
        <span class="t">${hl(h.it.title, raw)}<small>${esc(h.it.source)} ・ ${esc(h.it.date)}</small></span>${ic("ti-corner-down-left")}</li>`).join("")
    || `<li><span class="t" style="color:var(--muted)">見つかりませんでした</span></li>`;
}
function palMove(d) {
  if (!palHits.length) return;
  palSel = (palSel + d + palHits.length) % palHits.length;
  $$("#pal-list li").forEach((li, i) => li.classList.toggle("sel", i === palSel));
  $$("#pal-list li")[palSel]?.scrollIntoView({ block: "nearest" });
}
function palGo(h) { closePal(); if (!h) return; if (h.k) openKw(h.k.key); else openDetail(h.it.id); }

/* ================================================================ effects */
function markRead(id) {
  if (!P.read.has(id)) { P.read.set(id, Date.now()); P.save(); }
  $$(`.row[data-open="${CSS.escape(id)}"]`).forEach(r => r.classList.add("read"));
}

/* ================================================================ events */
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-bm],[data-read],[data-toggle-read],[data-copy],[data-rmkw],[data-kw],[data-chance],[data-open-btn],[data-open],[data-close],[data-close-pal],[data-batch],[data-f],[data-act],[data-rep-del],#freset,#older,#pal-list li,#pal-all,#totop");
  if (!t) return;
  const point = { x: e.clientX, y: e.clientY };
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
    copyText(t.dataset.copy, "リンクをコピーしました");
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
    openDetail(t.dataset.openBtn, t.closest(".hero"), point);
  } else if (t.dataset.open) {
    openDetail(t.dataset.open, t, point);
  } else if (t.matches("[data-close]")) {
    closeDetail();
  } else if (t.matches("[data-close-pal]")) {
    closePal();
  } else if (t.dataset.batch) {
    const key = t.dataset.batch, open = !t.classList.contains("open");
    t.classList.toggle("open", open); t.setAttribute("aria-expanded", open);
    if (open) {
      P.open.add(key); P.open.delete("closed:" + key);
      $$(".row, .ladder", t.nextElementSibling).forEach((r, i) => { r.style.setProperty("--i", i); r.classList.remove("in", "done"); r._seen = 0; void r.offsetWidth; r.classList.add("in"); });
    } else { P.open.delete(key); P.open.add("closed:" + key); }
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
    palGo(palHits[t.dataset.i]);
  } else if (t.id === "pal-all") {
    const q = $("#pal-q").value; closePal(); location.hash = `#/search${q ? "?q=" + encodeURIComponent(q) : ""}`;
  } else if (t.id === "totop") {
    window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
  } else if (t.dataset.act && S.adminApi) {
    t.disabled = true; await S.adminApi.setStatus(t.dataset.uid, t.dataset.act); await renderAdminList(); toast("ti-check", "更新しました");
  } else if (t.dataset.repDel && S.adminApi) {
    t.disabled = true; await S.adminApi.delReport(t.dataset.repDel); await renderAdminList(); toast("ti-trash", "削除しました");
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
    if (e.key === "Enter" && palHits[palSel]) { e.preventDefault(); palGo(palHits[palSel]); }
  }
  if (e.key === "Enter" && e.target.dataset?.batch) e.target.click();
});

// ヒーローのカーソル追従の光
document.addEventListener("pointermove", e => {
  const h = e.target.closest?.(".hero");
  if (!h) return;
  const r = h.getBoundingClientRect();
  h.style.setProperty("--mx", `${e.clientX - r.left}px`); h.style.setProperty("--my", `${e.clientY - r.top}px`);
}, { passive: true });

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
  setTimeout(moveIndicator, 300);
  document.fonts?.ready.then(moveIndicator);
}

// デモ：分区の学習データ（題・キーワード・お題・ガチャの言葉）を Firestore と同じ形にする
function demoLearn(seed, sec) {
  const docs = {}, day = todayStr();
  const add = (id, x) => { (docs[id] ||= { items: [] }).items.push(x); };
  (seed.quiz || []).forEach(q => add("quiz_" + q.topic, { ...q, id: "d" + hash(q.q + "|" + q.choices[q.answer]), date: day }));
  [...(sec.keywords || []), ...(seed.keywords || []).map(k => ({ date: day, slot: "learn", ...k }))].forEach(k => add("kw_" + k.area, k));
  docs.ideas = seed.ideas || {};
  if (seed.theme) docs.daily = { date: day, theme: seed.theme };
  docs.themes = { items: [...(sec.themes || []), ...(seed.theme ? [{ date: day, ...seed.theme }] : [])] };
  return docs;
}

async function startDemo() {
  const tag = document.createElement("div"); tag.className = "demo"; tag.textContent = "DEMO"; document.body.appendChild(tag);
  showGate("loading");
  const get = u => fetch(u, { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const [d, seed, sec] = await Promise.all([get("../samples/demo_site.json"), get("../samples/seed_learn.json"), get("../samples/demo_sections.json"), intro()]);
  setData([...(d.items || []), ...(sec.items || [])], d.meta || {});
  setLearn(demoLearn(seed, sec));
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
    async reports() {
      const snap = await F.getDocs(F.query(F.collection(db, "reports"), F.orderBy("createdAt", "desc"), F.limit(50)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    delReport: id => F.deleteDoc(F.doc(db, "reports", id)),
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

  async function loadLearn() {   // 分区の学習データ（learn コレクションの数個の文書）
    try {
      const snap = await F.getDocs(F.collection(db, "learn"));
      const docs = {};
      snap.forEach(d => { docs[d.id] = d.data(); });
      setLearn(docs);
    } catch (err) { console.warn("learn", err); }
  }

  async function syncProgress(uid) {   // ドリルの記録・ノートなどを端末間で同期
    const ref = F.doc(db, "users", uid, "progress", "main");
    try { const s = await F.getDoc(ref); if (s.exists()) P.merge(s.data()); } catch (err) { console.warn("progress", err); }
    let t = 0;
    P.onSave = () => {
      clearTimeout(t);
      t = setTimeout(() => F.setDoc(ref, JSON.parse(JSON.stringify(P.snapshot()))).catch(err => console.warn("progress save", err)), 1500);
    };
    P.save();
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
        await Promise.all([loadItems(), loadLearn(), syncProgress(user.uid)]);
        S.adminApi = S.isAdmin ? adminApi : null;
        S.api.report = r => F.addDoc(F.collection(db, "reports"), { ...r, uid: user.uid, status: "new", createdAt: F.serverTimestamp() });
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
initStarfield();
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (isLocal && (new URLSearchParams(location.search).has("demo") || !firebaseConfig.apiKey)) startDemo();
else if (firebaseConfig.apiKey) startFirebase();
else showGate("setup");
