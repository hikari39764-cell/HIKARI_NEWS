import { firebaseConfig } from "./firebase-config.js";
import { logoSVG } from "./logo.js";
import { SDK, REDUCED, $, $$, esc, safeUrl, todayStr, daysUntil, norm, ic, hash, AREAS, CAT_ICON, SLOT_LABEL, WEEK,
         P, S, setData, setLearn, catOf, catColor, catIc, isSection, byId, itemText, kwOf, sortNew, level, dlBadge, hl,
         metaLine, bmBtn, rowHTML, heroHTML, emptyHTML, pageHead, toast, burst, countUp, copyText, paraHTML, store } from "./core.js";
import { initStarfield, initCursorTrail, showDrawer, closeDrawer } from "./fx.js";
import { viewProg, viewPlan, afterLearn, todayLearnSide, ladders, ladderHTML, kwHits, openKw, rankBox } from "./learn.js";

/* =========================================================================
   HIKARI NEWS — front-end v3
   ・アイコン中心の UI、斜めワイプ転換、カード → 詳細パネルの変形、星屑の背景
   ・今日／さがす／プログラマー／プランナー／チャンス／マイページ／管理
   ・Firebase（本番）/ ローカルのデモデータ（localhost?demo）
   ========================================================================= */

const PAGE_SIZE = 300;
const ITEMS_CACHE = "itemsCache:v1";
const tsMs = v => (v && typeof v.toMillis === "function") ? v.toMillis() : (typeof v === "number" ? v : 0);

/* ================================================================== views */
function viewToday() {
  const items = S.items.filter(it => !isSection(it));          // 分区のニュースは各分区に表示
  const lads = ladders().filter(g => ["10", "17", "22"].includes(g.slot));
  if (!items.length && !lads.length) return `<div class="page">${emptyHTML("まだ記事がありません", "次の便（10:00 / 17:00 / 22:00）をお待ちください")}</div>`;
  const allDates = [...new Set([...items.map(it => it.date), ...lads.map(g => g.date)])].sort().reverse();
  const dates = allDates.slice(0, S.dayLimit || DAYS_SHOWN);
  const latest = items.filter(it => it.date === dates[0]);
  const top = [...(latest.length ? latest : items)].sort((a, b) => b.importance - a.importance || kwOf(b).length - kwOf(a).length)[0];

  // 日付ごとにまとめる（その日の中は 22:00 → 17:00 → 10:00 の便）
  const days = dates.map(d => ({ d, bs: ["22", "17", "10"].map(slot => ({
    slot,
    its: items.filter(it => it.date === d && String(it.slot) === slot && it !== top).sort((a, b) => b.importance - a.importance),
    kws: lads.filter(g => g.date === d && g.slot === slot),
  })).filter(b => b.its.length || b.kws.length) })).filter(x => x.bs.length);

  const dayList = days.map((g, gi) => {
    const key = "day:" + g.d;
    const open = P.open.has(key) || (gi === 0 && !P.open.has("closed:" + key));
    return `<section class="dgroup rv" style="--i:${gi + 1}">${dayHeadHTML(g, key, open)}
      <div class="dg-body">${g.bs.map((b, bi) => {
        const cats = [...new Set(b.its.map(it => it.category))];
        return `<div class="bsub" style="--k:${bi}">
          <div class="bsub-h"><span class="bs-tod t${b.slot}"><b>${TOD[b.slot].ja}</b><small>${TOD[b.slot].en}</small></span><span class="bsub-clock">${SLOT_LABEL[b.slot]}</span>
            <span class="cats">${cats.map(c => catIc(c)).join("")}${b.kws.length ? `<span class="cat-ic" style="--cat:var(--lemon)" data-tip="技術キーワード">${ic("ti-key")}</span>` : ""}</span>
            <span class="rule"></span><span class="cnt">${b.its.length}<small>件</small></span></div>
          ${b.its.length ? `<div class="rows">${b.its.map((it, i) => rowHTML(it, i)).join("")}</div>` : ""}
          ${b.kws.map((k, i) => ladderHTML(k, b.its.length + i)).join("")}
        </div>`;
      }).join("")}</div>
    </section>`;
  }).join("");
  const more = allDates.length > dates.length || S.loadMore;

  const d0 = new Date(dates[0] + "T00:00:00");
  return `<div class="page">
    ${pageHead("ti-sun", "今日のヒカリ", `<span class="when">${ic("ti-calendar")}${d0.getMonth() + 1}/${d0.getDate()} ${WEEK[d0.getDay()]}${S.updated ? ` ・ ${ic("ti-refresh")}${esc(String(S.updated).slice(11, 16))}` : ""}</span>`)}
    <div class="grid2">
      <div>${top ? heroHTML(top) : ""}${sxBanner()}<div class="days">${dayList}</div>${more ? `<p class="more-days"><button class="btn plain" id="older">${ic("ti-history")}もっと前の日</button></p>` : ""}</div>
      ${sideHTML(items)}
    </div>
  </div>`;
}

const DAYS_SHOWN = 4;          // 「今日」に並べる日数（「もっと前の日」で 4 日ずつ増える）
const WEEK_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
// 便の呼び方：ペルソナの「時間帯」のように
const TOD = { "10": { ja: "午前", en: "MORNING" }, "17": { ja: "放課後", en: "AFTER SCHOOL" }, "22": { ja: "夜", en: "EVENING" } };

// 日付の見出し：ペルソナ風のカレンダー（黒いギザギザの札に大きな日付、斜めの曜日、開くと黄色の星形が弾ける）
function dayHeadHTML(g, key, open) {
  const day = new Date(g.d + "T00:00:00"), dow = day.getDay();
  const yest = new Date(Date.now() - 864e5).toLocaleDateString("sv-SE");
  const tag = g.d === todayStr() ? "TODAY" : g.d === yest ? "YESTERDAY" : "";
  const total = g.bs.reduce((n, b) => n + b.its.length, 0);
  return `<div class="dg-h ${open ? "open" : ""}" data-day="${key}" role="button" tabindex="0" aria-expanded="${open}"
      aria-label="${day.getMonth() + 1}月${day.getDate()}日（${WEEK[dow]}） ${total}件">
    <span class="dg-band" aria-hidden="true"></span><span class="dg-fx" aria-hidden="true"></span>
    <span class="dg-cal" aria-hidden="true">
      <span class="dg-burst"></span><span class="dg-plate"></span>
      <span class="dg-mon">${day.getMonth() + 1}<i>/</i></span>
      <span class="dg-numw"><span class="dg-num">${day.getDate()}</span></span>
      <span class="dg-wk w${dow}"><b>${WEEK[dow]}</b><small>${WEEK_EN[dow]}</small></span>
    </span>
    ${tag ? `<span class="dg-tag ${tag === "TODAY" ? "today" : ""}" aria-hidden="true">${tag}</span>` : ""}
    <span class="dg-slots" aria-hidden="true">${g.bs.map((b, i) => `<span class="dg-slot t${b.slot}" style="--k:${i}">${TOD[b.slot].ja}</span>`).join("")}</span>
    <span class="rule"></span><span class="cnt"><b>${total}</b>件</span>${ic("ti-chevron-down chev")}
  </div>`;
}

function toggleDay(h) {
  const key = h.dataset.day, open = !h.classList.contains("open"), body = h.nextElementSibling;
  h.classList.toggle("open", open); h.setAttribute("aria-expanded", open);
  if (open) { P.open.add(key); P.open.delete("closed:" + key); } else { P.open.delete(key); P.open.add("closed:" + key); }
  P.save();
  if (!open || REDUCED) return;
  // 開く演出：札が光って日付がめくれ、その日の時間帯と記事がその場で順に現れる（位置はずらさない）。
  // 記事はスクロール用の「下から浮かぶ」演出を使わない（.in.done にして、.dg-play の演出だけにする）
  const rows = $$(".row, .ladder", body);
  h.classList.remove("dg-flash"); body.classList.remove("dg-play");
  rows.forEach((r, i) => { r.style.setProperty("--i", i); r.classList.add("in", "done"); });
  void h.offsetWidth;   // 1 回だけ読み直して、演出を最初から
  h.classList.add("dg-flash"); body.classList.add("dg-play");
  clearTimeout(h._fx);
  h._fx = setTimeout(() => { h.classList.remove("dg-flash"); body.classList.remove("dg-play"); }, 1600);   // 演出が止まる環境でも必ず見えるように外す
}

/* ============================================================ 19:00 特集 */
function setSpecials(list) {
  S.specials = list.filter(s => s && s.game && s.date).sort((a, b) => b.date.localeCompare(a.date));
  $("#nav-special").hidden = !S.specials.length;
}
const SX_KIND = { official: "公式", store: "ストア", interview: "インタビュー", talk: "講演", postmortem: "開発記録",
                  review: "レビュー", article: "記事", video: "動画" };
const SX_MOVE = { new: ["NEW", "new"], up: ["▲", "up"], down: ["▼", "dn"], same: ["―", "same"] };
const sxPct = v => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(0)}%`;
const sxNum = n => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : Number(n).toLocaleString();
const sxImg = (u, cls, alt = "", w = 460, h = 215) => /^https:\/\/([a-z0-9-]+\.)*(steamstatic\.com|akamaihd\.net)\//.test(u || "")
  ? `<img class="${cls}" src="${esc(u)}" alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : "";
const sxLink = (u, html, cls = "") => `<a class="${cls}" href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${html}</a>`;

// 「今日」のいちばん上に出す入口（今日か昨日の特集があるときだけ）
function sxBanner() {
  const sp = S.specials[0];
  if (!sp || !sp.game || daysUntil(sp.date) < -1) return "";
  return `<a class="sx-banner rv" style="--i:1" href="#/special?d=${esc(sp.date)}">
    <span class="sx-bt">${ic("ti-moon-stars")}19:00 特集${sp.date === todayStr() ? "" : "（昨日）"}</span>
    <b class="sx-bn">${esc(sp.game.title)}</b><span class="sx-bh">${esc(sp.game.hook)}</span>
    <span class="sx-bk">${ic("ti-trending-up")}急上昇 TOP5 ・ ${ic("ti-news")}今日の話題</span>${ic("ti-arrow-right sx-ba")}
    ${sxImg(sp.game.media?.header, "sx-bimg")}
  </a>`;
}

function sxStats(s) {
  if (!s) return "";
  return [
    s.w1 != null && `<span class="sx-sc ${s.w1 >= 0 ? "up" : "dn"}">${ic("ti-trending-up")}7日 ${sxPct(s.w1)}</span>`,
    s.d1 != null && `<span class="sx-sc ${s.d1 >= 0 ? "up" : "dn"}">${ic("ti-clock-hour-4")}24h ${sxPct(s.d1)}</span>`,
    (s.peak24 || s.now) && `<span class="sx-sc">${ic("ti-users")}${s.peak24 ? "ピーク " : ""}${sxNum(s.peak24 || s.now)}人</span>`,
  ].filter(Boolean).join("");
}

function sxGameHTML(g) {
  const chips = [["ti-building", g.developer], ["ti-device-gamepad-2", (g.platforms || []).join(" / ")], ["ti-calendar", g.release],
                 ["ti-category", g.genre], ["ti-coin-yen", g.price_jp || g.price], ["ti-cpu", g.engine]]
    .filter(c => c[1]).map(([i, t]) => `<span class="sx-chip">${ic(i)}${esc(t)}</span>`).join("");
  const view = (cls, en, ja, icn, part, extra = "") => `<section class="sx-view ${cls} rv">
    <div class="sx-vh"><span class="sx-vtag">${en}</span><h3>${ic(icn)}${ja}</h3></div>
    <ol class="sx-pts">${(part.points || []).map((p, i) => `<li><b>${String(i + 1).padStart(2, "0")}</b><span>${esc(p)}</span></li>`).join("")}</ol>
    <div class="sx-body">${paraHTML(part.detail)}</div>${extra}</section>`;
  const pl = g.player || {};
  const fit = (pl.for_whom || pl.caution) ? `<div class="sx-fit">${pl.for_whom ? `<p>${ic("ti-heart")}<b>向いている人</b>${esc(pl.for_whom)}</p>` : ""}${pl.caution ? `<p>${ic("ti-alert-triangle")}<b>気をつけたい点</b>${esc(pl.caution)}</p>` : ""}</div>` : "";
  return `<h2 class="sx-h2 rv"><span class="sx-h2n">01</span>${ic("ti-moon-stars")}今夜の1本</h2>
  <section class="sx-game rv ${g.media?.header ? "has-img" : ""}">
    ${sxImg(g.media?.header, "sx-cover", g.title)}
    <h2 class="sx-title">${esc(g.title)}${g.title_en && g.title_en !== g.title ? `<small>${esc(g.title_en)}</small>` : ""}</h2>
    <p class="sx-hook"><span>${esc(g.hook)}</span></p>
    <div class="sx-chips">${chips}</div>
    <p class="sx-sum">${esc(g.summary)}</p>
    ${g.why_now ? `<p class="sx-why">${ic("ti-sparkles")}<b>なぜ今？</b>${esc(g.why_now)}</p>` : ""}
    <div class="sx-links">${sxLink(g.url, `${ic("ti-external-link")}公式・ストア`, "btn")}</div>
    ${g.steam_appid ? `<iframe class="sx-steam" src="https://store.steampowered.com/widget/${Number(g.steam_appid)}/" loading="lazy" title="Steam ストア" referrerpolicy="no-referrer"></iframe>` : ""}
  </section>
  ${(g.media?.shots || []).length ? `<div class="sx-shots rv">${g.media.shots.map((x, i) =>
    sxLink(x.full, sxImg(x.thumb, "", `${g.title} のスクリーンショット ${i + 1}`, 600, 338), "sx-shot")).join("")}</div>` : ""}
  <div class="sx-views">
    ${view("pl", "PLAYER'S VIEW", "プレイヤー視点", "ti-device-gamepad-2", pl, fit)}
    ${view("mk", "MAKER'S VIEW", "作り手視点", "ti-tools", g.maker || {})}
  </div>
  ${(g.steal || []).length ? `<section class="sx-steal rv"><h3 class="sx-h3">${ic("ti-bulb")}ここを盗め</h3><div class="sx-stg">${g.steal.map((s, i) =>
    `<div class="sx-st"><span class="sx-stn">STEAL ${String(i + 1).padStart(2, "0")}</span><p>${esc(s)}</p></div>`).join("")}</div></section>` : ""}
  ${g.exercise ? `<section class="sx-ex rv">${ic("ti-pencil")}<div><b>やってみよう</b><p>${esc(g.exercise)}</p></div></section>` : ""}
  ${(g.terms || []).length ? `<dl class="terms sx-terms rv">${g.terms.map(t => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.explain)}</dd></div>`).join("")}</dl>` : ""}
  ${(g.sources || []).length ? `<ul class="sx-src rv">${g.sources.map(s => `<li><span class="sx-kind k-${esc(s.kind)}">${SX_KIND[s.kind] || "記事"}</span>${sxLink(s.url, esc(s.title))}</li>`).join("")}</ul>` : ""}`;
}

function sxRankHTML(sp) {
  const items = sp.ranking?.items || [];
  const rows = items.map((it, i) => {
    const mv = SX_MOVE[it.move];
    const img = sxImg(it.img, "sx-rimg", it.title);
    return `<article class="sx-rk rv ${i === 0 ? "top" : ""} ${img ? "has-img" : ""}" style="--i:${i + 1}">
      <span class="sx-rn">${it.rank || i + 1}</span>${img ? sxLink(it.url, img, "sx-rimgw") : ""}
      <div class="sx-rb">
        <div class="sx-rt">${sxLink(it.url, esc(it.title))}<span class="sx-tag">${esc(it.tag || "急上昇")}</span>${mv ? `<span class="sx-mv ${mv[1]}">${mv[0]}</span>` : ""}</div>
        ${it.stats ? `<div class="sx-stats">${sxStats(it.stats)}</div>` : ""}
        <p>${esc(it.why)}</p>
        ${(it.sources || []).length ? `<div class="sx-rs">${it.sources.slice(0, 3).map((u, k) => sxLink(u, `${ic("ti-link")}出典${k + 1}`)).join("")}</div>` : ""}
      </div></article>`;
  }).join("");
  const watch = (sp.watch || []).map((w, i) => `<article class="sx-w rv" style="--i:${i + 1}">
    ${w.img ? sxLink(w.url, sxImg(w.img, "sx-wimg", w.title), "sx-wimgw") : ""}<span class="sx-ws">${esc(w.status)}</span>${sxLink(w.url, esc(w.title), "sx-wt")}<p>${esc(w.why)}</p></article>`).join("");
  return `<h2 class="sx-h2 rv"><span class="sx-h2n">02</span>${ic("ti-trending-up")}急上昇 TOP5</h2>
    ${sp.ranking?.basis ? `<p class="sx-basis rv">${esc(sp.ranking.basis)}</p>` : ""}
    <div class="sx-rks">${rows}</div>
    ${watch ? `<h3 class="sx-h3 rv">${ic("ti-plant-2")}期待の新星</h3><div class="sx-wg">${watch}</div>` : ""}`;
}

function sxNewsHTML(news) {
  if (!news.length) return "";
  return `<h2 class="sx-h2 rv"><span class="sx-h2n">03</span>${ic("ti-news")}今日の話題</h2>
    <div class="sx-news">${news.map((n, i) => {
      const here = byId(n.id);   // サイトに載っている記事なら、その解説を開く
      return `<article class="sx-n rv" style="--i:${i + 1}" ${here ? `data-open="${esc(n.id)}"` : ""}>
        <div class="sx-nt">${here ? `<b>${esc(n.title)}</b>` : sxLink(n.url, esc(n.title))}<small>${esc(n.source)}</small></div>
        <p>${esc(n.summary)}</p><p class="sx-nw">${ic("ti-message-circle")}${esc(n.why)}</p></article>`;
    }).join("")}</div>`;
}

function viewSpecial() {
  const list = S.specials;
  if (!list.length) return `<div class="page">${pageHead("ti-moon-stars", "19:00 特集")}${emptyHTML("まだ特集がありません", "毎日 19:00 に、ゲーム紹介・急上昇ランキング・今日の話題をお届けします")}</div>`;
  const sp = list.find(s => s.date === S.params.d) || list[0];
  const d = new Date(sp.date + "T00:00:00");
  const fetched = String(sp.data?.fetched || "").slice(5, 16).replace("T", " ");
  const dates = list.slice(0, 14).map(s => {
    const x = new Date(s.date + "T00:00:00");
    return `<a class="sx-date ${s === sp ? "on" : ""}" href="#/special?d=${esc(s.date)}"><b>${x.getMonth() + 1}/${x.getDate()}</b><small>${esc(s.game?.title || "")}</small></a>`;
  }).join("");
  return `<div class="page sx">
    ${pageHead("ti-moon-stars", "19:00 特集", `<span class="when">${ic("ti-calendar")}${d.getMonth() + 1}/${d.getDate()} ${WEEK[d.getDay()]}</span>`)}
    ${list.length > 1 ? `<nav class="sx-dates rv" style="--i:1" aria-label="過去の特集">${dates}</nav>` : ""}
    ${sxGameHTML(sp.game || {})}
    ${sxRankHTML(sp)}
    ${sxNewsHTML(sp.news || [])}
    <p class="sx-note rv">${ic("ti-info-circle")}特集の文章は AI が出典をもとに作成しています。正確な情報は各リンク先でご確認ください。${fetched ? `急上昇の数値は Steam・SteamCharts（${esc(fetched)} 時点）をもとにしています。` : ""}画像：Steam ストアページより（© 各権利者）。</p>
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
        ${S.api.login && !S.user ? `<div class="box rv" style="--i:2"><div class="box-h"><span class="hi p">${ic("ti-cloud")}</span>記録の同期</div>
          <p class="muted-s">ログインすると、ドリルの記録・保存した記事・ノートを、ほかの端末でも使えます（読むだけならログイン不要）。</p>
          <button class="btn wide" data-login>${ic("ti-brand-google")}Google でログイン</button></div>` : ""}
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
const CONTACT_KIND = { takedown: "掲載の取り下げ", fix: "内容の訂正", other: "その他" };
async function renderAdminList() {
  let reps = [], contacts = [];
  try { reps = await S.adminApi.reports(); } catch (err) { console.warn("reports", err); }
  try { contacts = await S.adminApi.contacts(); } catch (err) { console.warn("contacts", err); }
  const when = c => { const t = c.createdAt?.toDate?.(); return t ? t.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; };
  const conHTML = `<div class="adm-h">${ic("ti-mail-forward")}フォームからの依頼<span class="n" style="color:var(--muted)">${contacts.length}</span></div>` +
    (contacts.map(c => `<div class="user rv in"><div class="who"><b>【${esc(CONTACT_KIND[c.kind] || c.kind)}】${esc(c.url || "（URLなし）")}</b>
      <small class="pre">${esc(c.message)}</small><small>${c.contact ? `連絡先：${esc(c.contact)} ・ ` : ""}${esc(when(c))}</small></div>
      <button class="ib" data-contact-del="${esc(c.id)}" data-tip="対応済み（削除）">${ic("ti-check")}</button></div>`).join("") || `<p class="muted-s">なし</p>`);
  const repHTML = `<div class="adm-h">${ic("ti-flag")}問題の報告<span class="n" style="color:var(--muted)">${reps.length}</span></div>` +
    (reps.map(r => `<div class="user rv in"><div class="who"><b>${esc(r.q)}</b><small>${esc(r.reason)}</small><small>${esc(r.track)} / ${esc(r.topic)} ・ ${esc(REP_ST[r.status] || r.status)}</small></div>
      <button class="ib" data-rep-del="${esc(r.id)}" data-tip="削除">${ic("ti-trash")}</button></div>`).join("") || `<p class="muted-s">なし</p>`);
  const el = $("#admin-list");
  if (!el) return;
  el.className = "";
  el.innerHTML = conHTML + repHTML;
  updateAdminBadge(contacts.length);
}
function updateAdminBadge(n) { const b = $("#admin-badge"); b.hidden = !n; b.textContent = n; }

/* ============================================================ gate views */
const gate = inner => `<div class="gate"><div class="orbs">${[[12, 20], [80, 14], [70, 78], [20, 72], [48, 8]].map(([x, y], i) =>
  `<i class="ti ti-star-filled" style="left:${x}%;top:${y}%;animation-delay:-${i * 1.7}s"></i>`).join("")}</div><div class="gate-card">${logoSVG()}${inner}</div></div>`;
const GATES = {
  loading: () => `<div class="loader">${logoSVG({ full: false })}</div>`,
  setup: () => gate(`<h2>設定が未完了です</h2><p>public/firebase-config.js を設定してください</p>`),
  error: msg => gate(`<h2>読み込みに失敗しました</h2><p>${esc(msg)}</p><button class="btn plain" id="recheck">${ic("ti-refresh")}再読み込み</button>`),
};
function showGate(name, arg) {
  S.ready = false;
  $("#nav").hidden = $("#bnav").hidden = $("#open-pal").hidden = $("#foot").hidden = true;
  $("#view").innerHTML = GATES[name](arg);
  const re = $("#recheck"); if (re) re.onclick = () => location.reload();
}

/* ================================================================ router */
/* ----------------------------------------------------------------- about */
const contactForm = () => `<form class="cform" id="cform">
    <div class="cf-row"><span class="cf-l">${ic("ti-category")}種類</span><div class="seg" id="cf-kind">
      <button type="button" class="on" data-ck="takedown">掲載の取り下げ</button><button type="button" data-ck="fix">内容の訂正</button><button type="button" data-ck="other">その他</button></div></div>
    <label class="cf-row"><span class="cf-l">${ic("ti-link")}対象の記事</span><input type="text" id="cf-url" maxlength="500" value="${esc(S.params.u || "")}" placeholder="原文の URL、またはこのサイトでの記事のタイトル"></label>
    <label class="cf-row"><span class="cf-l">${ic("ti-message")}ご依頼の内容</span><textarea id="cf-msg" maxlength="2000" placeholder="ご依頼の内容と理由をお書きください"></textarea></label>
    <label class="cf-row"><span class="cf-l">${ic("ti-at")}ご連絡先（任意）</span><input type="text" id="cf-contact" maxlength="200" placeholder="返信が必要な場合は、メールアドレスなど"></label>
    <div class="cf-go"><small>${ic("ti-lock")}送信内容は管理者だけが確認します</small><button class="btn" id="cf-send">${ic("ti-send")}送信する</button></div>
  </form>`;

function viewAbout() {
  const sec = (icon, title, body, i, id = "") => `<section class="ab-sec rv" style="--i:${i}" ${id ? `id="${id}"` : ""}><h2 class="sh">${ic(icon)}${title}</h2>${body}</section>`;
  return `<div class="page about">
    ${pageHead("ti-info-circle", "このサイトについて")}
    <div class="grid2"><div>
      ${sec("ti-star", "HIKARI NEWS とは", `<p class="para">ゲーム制作を学ぶ学生のために、ゲーム業界・技術・AI の情報を毎日 3 回まとめて紹介する、非営利の個人サイトです。広告は掲載していません。</p>`, 1)}
      ${sec("ti-robot", "要約・解説について", `<p class="para">記事のタイトル・要約・要点・解説・用語の説明は、AI（Anthropic の Claude）が原文を読んで作成しています。内容の確認には努めていますが、誤りや古い情報が含まれる場合があります。<b>正確な内容は、必ず原文でご確認ください。</b></p>`, 2)}
      ${sec("ti-copyright", "著作権について", `<ul class="ab-list">
        <li>紹介している記事の著作権は、それぞれの著作者・媒体に帰属します。</li>
        <li>このサイトでは、記事の事実や要点を独自の言葉でまとめ、出典（媒体名）と原文へのリンクを必ず表示しています。</li>
        <li>記事の本文や画像の転載は行っていません。引用が必要な場合は短い範囲にとどめ、出典を明記します。</li></ul>`, 3)}
      ${sec("ti-mail-forward", "掲載の取り下げ・訂正のご依頼", `<p class="para">権利者の方からの掲載の取り下げや、内容の訂正のご依頼は、下のフォームからお送りください。確認のうえ、できるだけ早く対応します（取り下げのご依頼は優先して対応します）。</p>${contactForm()}`, 4, "form")}
      ${sec("ti-alert-circle", "免責事項", `<ul class="ab-list">
        <li>掲載している情報の正確性・完全性は保証できません。</li>
        <li>リンク先のサイトの内容については責任を負いかねます。</li>
        <li>このサイトの情報を利用したことで生じた損害について、責任を負いかねます。</li></ul>`, 5)}
    </div>
    <aside class="side-col">
      <div class="box rv" style="--i:2"><div class="box-h"><span class="hi">${ic("ti-clock")}</span>更新</div>
        <p class="muted-s">毎日 10:00・17:00・22:00（日本時間）に記事を追加します。プログラマー・プランナーの学習コンテンツは毎朝更新します。</p></div>
      <div class="box rv" style="--i:3"><div class="box-h"><span class="hi p">${ic("ti-palette")}</span>使用している素材</div>
        <p class="muted-s">フォント：Noto Sans JP・Dela Gothic One・Oswald（SIL Open Font License）<br>アイコン：Tabler Icons（MIT License）</p></div>
    </aside></div>
  </div>`;
}

/* ---------------------------------------------------------------- notify */
// 受け取り設定：メール（ログイン中の Google アカウント宛て）・自分の Discord チャンネル（Webhook）
const WEBHOOK_RE = /^https:\/\/((ptb|canary)\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const subNow = () => ({ email_on: false, email_mode: "each", webhook: "", webhook_on: false, ...(S.sub || {}) });

function viewNotify() {
  const live = !!S.api.login, sub = subNow();
  const needLogin = live && !S.user;
  const sw = (key, on) => `<button type="button" class="switch ${on ? "on" : ""}" data-sub="${key}" role="switch" aria-checked="${on}" ${needLogin ? "disabled" : ""}><i></i></button>`;
  return `<div class="page notify">
    ${pageHead("ti-bell-ringing", "受け取り設定")}
    <p class="lead-s rv" style="--i:1">新しい記事が届いたら、メールや自分の Discord でお知らせします。このサイトの Discord サーバーに参加していなくても使えます。</p>
    ${needLogin ? `<div class="nt-login rv" style="--i:2">${ic("ti-lock")}<span>設定には Google でのログインが必要です（メールはログインしたアカウントのアドレスに届きます）。</span>
      <button class="btn" data-login>${ic("ti-brand-google")}Google でログイン</button></div>` : ""}
    <div class="grid2"><div>
      <section class="nt-card rv" style="--i:3;--cat:var(--peach)">
        <div class="nt-h"><span class="nt-ic">${ic("ti-mail")}</span><div><b>メールで受け取る</b><small>Gmail などのメールアプリに届きます</small></div>${sw("email_on", sub.email_on)}</div>
        <div class="nt-row"><span class="cf-l">${ic("ti-at")}送信先</span><b class="nt-mail">${esc(S.user?.email || (live ? "（ログインすると表示されます）" : "demo@example.com"))}</b></div>
        <div class="nt-row"><span class="cf-l">${ic("ti-clock")}頻度</span><div class="seg" id="nt-mode">
          <button type="button" class="${sub.email_mode !== "daily" ? "on" : ""}" data-mode="each" ${needLogin ? "disabled" : ""}>配信ごと（1日3通）</button>
          <button type="button" class="${sub.email_mode === "daily" ? "on" : ""}" data-mode="daily" ${needLogin ? "disabled" : ""}>1日1回まとめ（22時ごろ）</button></div></div>
        <p class="nt-note">${ic("ti-info-circle")}届かないときは、迷惑メールフォルダも確認してください。最初の1通を「迷惑メールではない」にすると、次から普通に届きます。</p>
      </section>
      <section class="nt-card rv" style="--i:4;--cat:#7b8cff">
        <div class="nt-h"><span class="nt-ic">${ic("ti-brand-discord")}</span><div><b>自分の Discord に届ける</b><small>自分のサーバーのチャンネルに、配信と同じ内容が届きます</small></div>${sw("webhook_on", sub.webhook_on && !!sub.webhook)}</div>
        <ol class="nt-steps">
          <li>Discord で自分専用のサーバーを作ります（すでにあれば、それで OK）。</li>
          <li>受け取りたいチャンネルの「チャンネルの編集」→「連携サービス」→「ウェブフック」→「新しいウェブフック」を開きます。</li>
          <li>「ウェブフック URL をコピー」して、下に貼り付けます。「テスト送信」で届くか確かめてから「保存」してください。</li>
        </ol>
        <div class="nt-wh"><input type="text" id="wh-url" value="${esc(sub.webhook)}" placeholder="https://discord.com/api/webhooks/..." autocomplete="off" ${needLogin ? "disabled" : ""}>
          <button type="button" class="btn plain" data-wh="test" ${needLogin ? "disabled" : ""}>${ic("ti-send")}テスト送信</button>
          <button type="button" class="btn" data-wh="save" ${needLogin ? "disabled" : ""}>${ic("ti-device-floppy")}保存</button>
          ${sub.webhook ? `<button type="button" class="ib" data-wh="del" data-tip="削除">${ic("ti-trash")}</button>` : ""}</div>
        <p class="nt-note">${ic("ti-lock")}この URL はあなたにしか見えません。Discord 側でウェブフックを削除すると、配信は自動で止まります。</p>
      </section>
    </div>
    <aside class="side-col">
      <div class="box rv" style="--i:3"><div class="box-h"><span class="hi">${ic("ti-clock")}</span>届くタイミング</div>
        <p class="muted-s">毎日 10:00・17:00・22:00 の配信のあと、すぐに届きます。「1日1回まとめ」は 22 時の配信のあとに、その日の記事をまとめて 1 通で届けます。</p></div>
      <div class="box rv" style="--i:4"><div class="box-h"><span class="hi p">${ic("ti-bell-off")}</span>止めるとき</div>
        <p class="muted-s">このページのスイッチをオフにするだけで止まります。メールの最後にも、このページへのリンクがあります。</p></div>
    </aside></div>
  </div>`;
}

async function saveSub(patch, msg) {
  const next = { ...subNow(), ...patch };
  if (!S.api.saveSub) {   // デモ／未ログイン
    if (S.api.login) { S.api.login(); return false; }
    S.sub = next; toast("ti-check", `（デモ）${msg}`); return true;
  }
  try { await S.api.saveSub(next); S.sub = next; toast("ti-check", msg); return true; }
  catch (err) { console.error(err); toast("ti-alert-triangle", "保存できませんでした"); return false; }
}

async function webhookAction(kind) {
  const url = $("#wh-url")?.value.trim() || "";
  if (kind === "del") {
    if (await saveSub({ webhook: "", webhook_on: false }, "Discord への配信を止めて、URL を削除しました")) redraw();
    return;
  }
  if (!WEBHOOK_RE.test(url)) { toast("ti-alert-triangle", "Discord のウェブフック URL を貼り付けてください"); $("#wh-url")?.focus(); return; }
  if (kind === "test") {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "✅ HIKARI NEWS からのテスト送信です。保存すると、これからの配信がこのチャンネルに届きます。", allowed_mentions: { parse: [] } }) });
      toast(r.ok ? "ti-send" : "ti-alert-triangle", r.ok ? "テスト送信しました。Discord を確認してください" : `送れませんでした（${r.status}）。URL を確認してください`);
    } catch { toast("ti-alert-triangle", "送れませんでした。URL を確認してください"); }
    return;
  }
  if (await saveSub({ webhook: url, webhook_on: true }, "保存しました。次の配信から届きます")) redraw();
}

const VIEWS = { today: viewToday, special: viewSpecial, search: viewSearch, prog: viewProg, plan: viewPlan, chance: viewChance, saved: viewSaved, admin: viewAdmin, about: viewAbout, notify: viewNotify };
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
  const moved = changed || params.t !== S.params.t || params.run !== S.params.run || params.id !== S.params.id || params.d !== S.params.d;
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
  if (S.route === "about" && (S.params.u || S.params.f)) setTimeout(() => $("#form")?.scrollIntoView({ block: "start", behavior: REDUCED ? "auto" : "smooth" }), 350);
  if (S.params.open) {   // メールの「サイトで解説を読む」：#/today?open=記事ID → その記事のカードを開く
    const id = S.params.open, { open, ...rest } = S.params;
    S.params = rest;
    const qs = new URLSearchParams(rest).toString();
    history.replaceState(null, "", `#/${S.route}${qs ? "?" + qs : ""}`);
    if (byId(id)) setTimeout(() => openDetail(id), 500);
    else toast("ti-info-circle", "記事が見つかりませんでした（古い記事は「さがす」から探せます）");
  }
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
  if (ind) ind.style.opacity = on ? 1 : 0;   // ナビにないページ（このサイトについて 等）では消す
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
        <p class="src-note dz" style="--d:3">${ic("ti-info-circle")}<span>出典：<b>${esc(it.source)}</b>。この要約・解説は AI が原文をもとに作成したものです。正確な内容は原文でご確認ください。
          <a href="#/about?u=${encodeURIComponent(it.url)}" data-close>取り下げ・訂正の依頼</a></span></p>
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
  const t = e.target.closest("[data-bm],[data-read],[data-toggle-read],[data-copy],[data-rmkw],[data-kw],[data-chance],[data-open-btn],[data-open],[data-close],[data-close-pal],[data-day],[data-f],[data-act],[data-rep-del],[data-contact-del],[data-ck],[data-sub],[data-mode],[data-wh],[data-login],#freset,#older,#pal-list li,#pal-all,#totop");
  if (t?.disabled) return;
  if (!t) return;
  if (t.matches("[data-login]")) { S.api.login?.(); return; }
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
  } else if (t.dataset.day) {
    toggleDay(t);
  } else if (t.dataset.f) {
    const k = t.dataset.f, v = t.dataset.v, cur = { ...F_DEF, ...S.params };
    if (k === "cats") { const s = new Set(cur.cats.split(",").filter(Boolean)); s.has(v) ? s.delete(v) : s.add(v); setParams({ cats: [...s].join(",") }); }
    else setParams({ [k]: cur[k] === v && k !== "sort" ? "" : v });
    const c = { ...F_DEF, ...S.params };
    $$("[data-f]").forEach(b => b.classList.toggle("on", b.dataset.f === "cats" ? c.cats.split(",").includes(b.dataset.v) : c[b.dataset.f] === b.dataset.v));
  } else if (t.id === "freset") {
    S.params = {}; history.replaceState(null, "", "#/search"); redraw();
  } else if (t.id === "older") {   // 「もっと前の日」：4 日ずつ増やす。手元の記事で足りなければ、もっと古い記事を読む
    t.disabled = true;
    const want = (S.dayLimit || DAYS_SHOWN) + DAYS_SHOWN;
    if (S.loadMore && new Set(S.items.filter(it => !isSection(it)).map(it => it.date)).size < want) await S.loadMore();
    S.dayLimit = want; redraw();
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
  } else if (t.dataset.contactDel && S.adminApi) {
    t.disabled = true; await S.adminApi.delContact(t.dataset.contactDel); await renderAdminList(); toast("ti-check", "対応済みにしました");
  } else if (t.dataset.ck) {
    $$("#cf-kind [data-ck]").forEach(b => b.classList.toggle("on", b === t));
  } else if (t.dataset.sub) {   // 受け取り設定のスイッチ
    const key = t.dataset.sub, on = !t.classList.contains("on");
    if (key === "webhook_on" && on && !subNow().webhook) { toast("ti-info-circle", "先にウェブフック URL を保存してください"); return; }
    if (await saveSub({ [key]: on }, on ? "オンにしました" : "オフにしました")) { t.classList.toggle("on", on); t.setAttribute("aria-checked", on); }
  } else if (t.dataset.mode) {
    const m = t.dataset.mode;
    if (await saveSub({ email_mode: m }, m === "daily" ? "1日1回まとめて届けます" : "配信ごとに届けます")) $$("#nt-mode [data-mode]").forEach(b => b.classList.toggle("on", b === t));
  } else if (t.dataset.wh) {
    webhookAction(t.dataset.wh);
  }
});

// 「このサイトについて」のフォーム（掲載の取り下げ・訂正の依頼）
async function sendContact(form) {
  const msg = $("#cf-msg").value.trim();
  if (!msg) { toast("ti-alert-triangle", "ご依頼の内容を入力してください"); $("#cf-msg").focus(); return; }
  const data = { kind: $("#cf-kind .on")?.dataset.ck || "other", url: $("#cf-url").value.trim().slice(0, 500),
                 message: msg.slice(0, 2000), contact: $("#cf-contact").value.trim().slice(0, 200) };
  const btn = $("#cf-send"); btn.disabled = true;
  try {
    if (S.api.contact) await S.api.contact(data);
    form.outerHTML = `<div class="cf-done">${ic("ti-circle-check-filled")}<b>送信しました</b><span>ご依頼ありがとうございます。確認のうえ、できるだけ早く対応します。</span></div>`;
    toast("ti-send", S.api.contact ? "送信しました" : "（デモ）送信しました");
  } catch (err) {
    console.error(err); btn.disabled = false;
    toast("ti-alert-triangle", "送信できませんでした。時間をおいてもう一度お試しください");
  }
}

document.addEventListener("submit", e => {
  if (e.target.id === "cform") { e.preventDefault(); sendContact(e.target); return; }
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
  if ((e.key === "Enter" || e.key === " ") && e.target.dataset?.day) { e.preventDefault(); e.target.click(); }
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
  $("#nav").hidden = $("#bnav").hidden = $("#open-pal").hidden = $("#foot").hidden = false;
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
  let sp = await get("../out/special_preview.json");
  if (!sp.game) sp = await get("../samples/demo_special.json");
  setSpecials(sp.game ? [sp] : []);
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
  // ログインは任意（記録の同期・問題の報告に使う）。読むだけならログイン不要
  const login = async () => {
    try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); }
    catch (err) {
      if (!["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(err.code)) toast("ti-alert-triangle", "ログインできませんでした");
    }
  };
  S.api.login = login;
  S.api.contact = d => F.addDoc(F.collection(db, "contacts"), { ...d, status: "new", createdAt: F.serverTimestamp() });
  $("#login-btn").onclick = login;
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
    async contacts() {
      const snap = await F.getDocs(F.query(F.collection(db, "contacts"), F.orderBy("createdAt", "desc"), F.limit(50)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    delContact: id => F.deleteDoc(F.doc(db, "contacts", id)),
  };

  // 記事：前回読んだ分はブラウザに保存しておき、新しく増えた分だけを読む（データベースの読み取り回数を減らす）
  async function loadItems() {
    const metaSnap = await F.getDoc(F.doc(db, "meta", "site"));
    const meta = metaSnap.exists() ? metaSnap.data() : {};
    const col = F.collection(db, "items");
    const toItem = d => ({ ...d.data(), id: d.id, createdAt: null, _t: tsMs(d.data().createdAt) });
    const cached = store.get(ITEMS_CACHE, null);
    let items = Array.isArray(cached?.items) ? cached.items.filter(it => it && it.id && it._t) : [];
    const newest = items.reduce((m, it) => Math.max(m, it._t), 0);
    const snap = await F.getDocs(newest
      ? F.query(col, F.where("createdAt", ">", F.Timestamp.fromMillis(newest + 1)), F.orderBy("createdAt", "desc"), F.limit(PAGE_SIZE))
      : F.query(col, F.orderBy("createdAt", "desc"), F.limit(PAGE_SIZE)));
    const fresh = snap.docs.map(toItem);
    if (newest && fresh.length === PAGE_SIZE) items = [];   // 間が空きすぎたときは保存分を捨てて読み直す
    const ids = new Set(fresh.map(it => it.id));
    items = [...fresh, ...items.filter(it => !ids.has(it.id))].sort((a, b) => b._t - a._t);
    store.set(ITEMS_CACHE, { items: items.slice(0, 400) });

    async function older() {   // 「もっと前」：今ある一番古い記事より前を読む
      const oldest = items.reduce((m, it) => Math.min(m, it._t), Infinity);
      const s = await F.getDocs(F.query(col, F.where("createdAt", "<", F.Timestamp.fromMillis(oldest + 1)), F.orderBy("createdAt", "desc"), F.limit(PAGE_SIZE)));
      const have = new Set(items.map(it => it.id));
      items = [...items, ...s.docs.map(toItem).filter(it => !have.has(it.id))];
      S.loadMore = s.size === PAGE_SIZE ? older : null;
      setData(items, meta);
    }
    S.loadMore = items.length >= PAGE_SIZE ? older : null;
    setData(items, meta);
  }

  async function loadLearn() {   // 分区の学習データ（learn コレクションの数個の文書）
    try {
      const snap = await F.getDocs(F.query(F.collection(db, "learn"), F.limit(50)));
      const docs = {};
      snap.forEach(d => { docs[d.id] = d.data(); });
      setLearn(docs);
    } catch (err) { console.warn("learn", err); }
  }

  async function loadSpecials() {   // 19:00 特集（新しい順に 30 日分）
    try {
      const snap = await F.getDocs(F.query(F.collection(db, "specials"), F.orderBy("date", "desc"), F.limit(30)));
      setSpecials(snap.docs.map(d => ({ ...d.data(), createdAt: null })));
    } catch (err) { console.warn("specials", err); }
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

  // ログイン状態が変わったとき（ページを開いた直後にも1回呼ばれる）
  A.onAuthStateChanged(auth, async user => {
    S.user = user || null;
    $("#me").hidden = !user;
    $("#login-btn").hidden = !!user;
    if (user) {
      $("#me-photo").src = user.photoURL || "";
      S.api.report = r => F.addDoc(F.collection(db, "reports"), { ...r, uid: user.uid, status: "new", createdAt: F.serverTimestamp() });
      // 受け取り設定（メール・自分の Discord）。本人だけが読み書きできる
      const subRef = F.doc(db, "subscriptions", user.uid);
      S.api.saveSub = d => F.setDoc(subRef, { email: user.email, email_on: !!d.email_on, email_mode: d.email_mode === "daily" ? "daily" : "each",
                                              webhook: d.webhook || "", webhook_on: !!(d.webhook && d.webhook_on), updated: F.serverTimestamp() });
      try { const s = await F.getDoc(subRef); S.sub = s.exists() ? s.data() : null; } catch { S.sub = null; }
      await syncProgress(user.uid);
      try { S.isAdmin = (await F.getDoc(F.doc(db, "admins", user.uid))).exists(); } catch { S.isAdmin = false; }
      S.adminApi = S.isAdmin ? adminApi : null;
      if (S.isAdmin) adminApi.contacts().then(c => updateAdminBadge(c.length)).catch(() => {});
    } else {
      S.api.report = null; S.api.saveSub = null; S.sub = null; S.isAdmin = false; S.adminApi = null; P.onSave = null;
    }
    $("#nav-admin").hidden = !S.isAdmin;
    if (S.ready) { redraw(); moveIndicator(); }
  });

  // 記事と学習データはログインしていなくても読める
  try {
    await Promise.all([loadItems(), loadLearn(), loadSpecials(), introDone]);
    enterApp();
  } catch (err) { console.error(err); showGate("error", err.code || err.message); }
}

$("#brand-logo").innerHTML = logoSVG({ full: false });
$("#open-pal kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
$("#wipe-mark").innerHTML = logoSVG({ full: false });
$("#theme").innerHTML = ic(document.documentElement.dataset.theme === "light" ? "ti-sun" : "ti-moon-stars");
initStarfield();
initCursorTrail();
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (isLocal && (new URLSearchParams(location.search).has("demo") || !firebaseConfig.apiKey)) startDemo();
else if (firebaseConfig.apiKey) startFirebase();
else showGate("setup");
