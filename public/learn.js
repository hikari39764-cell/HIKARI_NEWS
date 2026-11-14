// =========================================================================
// HIKARI NEWS — プログラマー／プランナー の分区
//  ・ドリル（4択・3段階・間隔反復で復習）・技術キーワード図鑑
//  ・今日のお題・ひらめきガチャ・ブレストタイマー・企画ノート
// 中身はすべて毎朝の定時タスクが用意する（ブラウザで AI は使わない）
// =========================================================================

import { $, $$, esc, safeUrl, todayStr, norm, ic, shuffle, pick, hash, AREAS, KW_LV, TOPICS, RANKS, rankOf, SLOT_LABEL,
         P, S, store, rowHTML, heroHTML, emptyHTML, sortNew, pageHead, toast, burst, countUp, kwLevel, copyText, REDUCED } from "./core.js";
import { celebrate, floatText, shake, showDrawer } from "./fx.js";

export const TRACK = {
  programmer: { route: "prog", name: "プログラマー", icon: "ti-terminal-2", color: "#43D6FF", daily: 10 },
  planner: { route: "plan", name: "プランナー", icon: "ti-notebook", color: "#FFB874", daily: 5 },
};
const LEVELS = ["基礎", "発展", "応用"];
const XP_GAIN = { "基礎": 10, "発展": 15, "応用": 20 };
const IV = [1, 1, 3, 7, 16, 35];   // 箱ごとの「次の復習まで」の日数
const RANK_IC = ["ti-seeding", "ti-plant-2", "ti-sword", "ti-shield-check", "ti-crown", "ti-sparkles"];
const C_RING = 326.7;   // 円周（r=52）
const C_SM = 113.1;     // 円周（r=18）
const JA = /[぀-ヿ一-鿿]/;

const md = d => { const [, m, dd] = String(d || "").split("-"); return m ? `${+m}/${+dd}` : ""; };
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const go = h => { if (location.hash === h) S.api.redraw?.(); else location.hash = h; };
const looksCode = s => !JA.test(s) && /[(){};=<>\[\]:*&]/.test(s);
const area = id => AREAS[id] || { name: id, icon: "ti-key", color: "#F2F56A" };

function setQS(route, patch) {
  S.params = { ...S.params, ...patch };
  const qs = new URLSearchParams(Object.entries(S.params).filter(([, v]) => v)).toString();
  history.replaceState(null, "", `#/${route}${qs ? "?" + qs : ""}`);
}

function confirmTwice(btn, msg, fn) {
  if (btn.classList.contains("warn")) { btn.classList.remove("warn"); fn(); return; }
  const old = btn.dataset.tip;
  btn.classList.add("warn"); btn.dataset.tip = msg;
  setTimeout(() => { btn.classList.remove("warn"); btn.dataset.tip = old; }, 2600);
}

/* ================================================================ 題庫 */
let QB = {}, QBsrc = null;
function quizIndex() {
  if (QBsrc === S.learn.quiz) return QB;
  QBsrc = S.learn.quiz; QB = {};
  for (const [topic, list] of Object.entries(S.learn.quiz || {})) {
    const m = new Map();
    for (const q of list || []) {
      if (q && q.id && Array.isArray(q.choices) && q.choices.length === 4 && Number.isInteger(q.answer)) m.set(q.id, { ...q, topic });
    }
    QB[topic] = [...m.values()];
  }
  return QB;
}
const topicBank = id => quizIndex()[id] || [];
const bank = track => TOPICS[track].flatMap(t => topicBank(t.id));
const topicOf = (track, id) => TOPICS[track].find(t => t.id === id) || { id, name: id, icon: "ti-point" };
const lvIdx = q => LEVELS.indexOf(q.level);

function trackStats(track) {
  const today = todayStr(), qs = bank(track);
  let seen = 0, mastered = 0, due = 0, weak = 0, n = 0, c = 0;
  for (const q of qs) {
    const r = P.qp[q.id];
    if (!r) continue;
    seen++; n += r.n || 0; c += r.c || 0;
    if ((r.b || 0) >= 4) mastered++;
    if (r.d && r.d <= today) due++;
    if (r.l === 0) weak++;
  }
  return { total: qs.length, seen, mastered, due, weak, answered: n, acc: n ? Math.round(c / n * 100) : 0 };
}
const mastery = qs => qs.length ? qs.reduce((s, q) => s + Math.min(4, P.qp[q.id]?.b || 0) / 4, 0) / qs.length : 0;
const dayKey = (track, d = todayStr()) => `${d}:${track}`;
export const todayCount = track => P.daily[dayKey(track)] || 0;
export function streak() {
  const d = new Date();
  if (!P.daily[d.toLocaleDateString("sv-SE")]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (P.daily[d.toLocaleDateString("sv-SE")]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// 1問ぶんの記録（ライトナー方式：正解で箱が上がり、まちがえると最初の箱へ）
function record(q, ok, track) {
  const today = todayStr();
  const r = { b: 0, n: 0, c: 0, ...(P.qp[q.id] || {}) };
  r.n++;
  if (ok) { r.c++; r.b = Math.min(5, r.b + 1); } else r.b = 0;
  r.l = ok ? 1 : 0; r.d = addDays(IV[r.b]); r.t = Date.now();
  P.qp[q.id] = r;
  P.daily[today] = (P.daily[today] || 0) + 1;
  const k = dayKey(track), before = P.daily[k] || 0;
  P.daily[k] = before + 1;
  const gain = ok ? (XP_GAIN[q.level] || 10) : 2;
  const bonus = before + 1 === TRACK[track].daily ? 30 : 0;   // 今日の目標を達成した瞬間だけ
  const r0 = rankOf(P.xp);
  P.xp += gain + bonus;
  const r1 = rankOf(P.xp);
  P.save();
  return { gain, bonus, rankUp: r1 > r0 ? r1 : -1 };
}

// 出題：復習の期限が来た問題 → まだ解いていない問題（やさしい順）→ そのほか
function buildSet(track, { mode = "topic", topics = [], lv = "mix", n = 10 } = {}) {
  const today = todayStr();
  let pool = bank(track);
  if (topics.length) pool = pool.filter(q => topics.includes(q.topic));
  if (lv !== "mix") pool = pool.filter(q => q.level === lv);
  const rec = q => P.qp[q.id];
  const byBox = (a, b) => (rec(a)?.b ?? 0) - (rec(b)?.b ?? 0);
  const due = shuffle(pool.filter(q => rec(q)?.d && rec(q).d <= today)).sort(byBox);
  const fresh = shuffle(pool.filter(q => !rec(q))).sort((a, b) => lvIdx(a) - lvIdx(b));
  const rest = shuffle(pool.filter(q => rec(q) && !(rec(q).d <= today))).sort(byBox);
  let list;
  if (mode === "review") list = [...shuffle(pool.filter(q => rec(q)?.l === 0)), ...due];
  else if (mode === "daily") { const h = Math.ceil(n / 2); list = [...due.slice(0, h), ...fresh, ...due.slice(h), ...rest]; }
  else list = [...due, ...fresh, ...rest];
  const seen = new Set();
  return list.filter(q => !seen.has(q.id) && seen.add(q.id)).slice(0, n).sort((a, b) => lvIdx(a) - lvIdx(b));
}

/* ============================================================== ドリル */
let DR = null, SET = null, REP = null;
const REPORTED = new Set();

function startDrill(track, cfg = {}, list = null) {
  const qs = list || buildSet(track, cfg);
  if (!qs.length) { toast("ti-mood-empty", "条件に合う問題がありません"); return; }
  DR = { track, cfg, run: Date.now().toString(36), qs: qs.map(q => ({ q, order: shuffle([0, 1, 2, 3]) })),
         i: 0, res: [], picked: null, xp: 0, combo: 0, done: false };
  go(`#/${TRACK[track].route}?t=drill&run=${DR.run}`);
}
const drillActive = track => DR && DR.track === track && S.params.run === DR.run;

function drillTab(track) {
  if (drillActive(track)) return `<div id="drill" class="drill">${DR.done ? resultHTML() : questionHTML()}</div>`;
  if (!bank(track).length) return emptyHTML("問題を準備中です", "毎朝 7 時ごろに新しい問題が届きます");
  return setupHTML(track);
}

const poolSize = c => bank(c.track).filter(q => (!c.topics.size || c.topics.has(q.topic)) && (c.lv === "mix" || q.level === c.lv)).length;

function setupHTML(track) {
  const T = TRACK[track];
  const pre = TOPICS[track].some(t => t.id === S.params.topic) ? S.params.topic : "";
  SET = { track, topics: new Set(pre ? [pre] : []), lv: "mix", n: track === "planner" ? 5 : 10 };
  const review = buildSet(track, { mode: "review", n: 99 }).length;
  const chip = (la, v, on, inner) => `<button class="chip ${on ? "on" : ""}" style="--cat:${T.color}" data-la="${la}" data-v="${v}">${inner}</button>`;
  return `<div class="su-quick rv" style="--i:2">
      <button class="qk" data-la="start" data-track="${track}" data-mode="daily">${ic("ti-target-arrow")}<span><b>今日のドリル</b><small>${T.daily}問 ・ 復習＋新しい問題</small></span><em>${Math.min(todayCount(track), T.daily)}/${T.daily}</em></button>
      <button class="qk" data-la="start" data-track="${track}" data-mode="review" ${review ? "" : "disabled"}>${ic("ti-repeat")}<span><b>復習</b><small>まちがえた・忘れかけの問題</small></span><em>${review}</em></button>
    </div>
    <section class="setup rv" style="--i:3;--cat:${T.color}">
      <div class="su-h">${ic("ti-adjustments")}条件を選んで解く</div>
      <div class="su-row"><span class="su-l">${ic("ti-category")}トピック</span><div class="su-opts" id="su-topics">
        ${chip("su-topic", "", !pre, `${ic("ti-layout-grid")}すべて`)}
        ${TOPICS[track].map(t => chip("su-topic", t.id, pre === t.id, `${ic(t.icon)}${esc(t.name)}<span class="n">${topicBank(t.id).length}</span>`)).join("")}</div></div>
      <div class="su-row"><span class="su-l">${ic("ti-stairs")}レベル</span><div class="su-opts" id="su-lv">
        ${chip("su-lv", "mix", true, `${ic("ti-arrows-shuffle")}ミックス`)}
        ${LEVELS.map(l => chip("su-lv", l, false, kwLevel(l))).join("")}</div></div>
      <div class="su-row"><span class="su-l">${ic("ti-list-numbers")}問題数</span><div class="su-opts" id="su-n">
        ${[5, 10, 20].map(n => chip("su-n", n, n === SET.n, `${n}問`)).join("")}</div></div>
      <div class="su-go"><span class="su-cnt">対象 <b id="su-cnt">${poolSize(SET)}</b> 問</span>
        <button class="btn big" data-la="su-start">${ic("ti-player-play-filled")}スタート</button></div>
    </section>`;
}

function suToggle(kind, v) {
  if (!SET) return;
  if (kind === "topic") {
    if (!v) SET.topics.clear(); else if (SET.topics.has(v)) SET.topics.delete(v); else SET.topics.add(v);
    $$("#su-topics .chip").forEach(c => c.classList.toggle("on", c.dataset.v ? SET.topics.has(c.dataset.v) : !SET.topics.size));
  } else if (kind === "lv") {
    SET.lv = v; $$("#su-lv .chip").forEach(c => c.classList.toggle("on", c.dataset.v === v));
  } else if (kind === "n") {
    SET.n = Number(v); $$("#su-n .chip").forEach(c => c.classList.toggle("on", c.dataset.v === String(v)));
  }
  const el = $("#su-cnt");
  if (el) el.textContent = poolSize(SET);
}

function questionHTML() {
  const T = TRACK[DR.track], { q, order } = DR.qs[DR.i], tp = topicOf(DR.track, q.topic);
  return `<div class="dr-top">
      <button class="ib sm ghost" data-la="quit" data-tip="やめる">${ic("ti-x")}</button>
      <div class="dr-prog">${DR.qs.map((_, k) => `<i class="${k < DR.i ? (DR.res[k] ? "ok" : "ng") : k === DR.i ? "cur" : ""}"></i>`).join("")}</div>
      <span class="dr-n"><b>${DR.i + 1}</b>/${DR.qs.length}</span>
    </div>
    <article class="q-card" style="--cat:${T.color}">
      <div class="q-meta"><span class="cat-ic" style="--cat:${T.color}">${ic(tp.icon)}</span><b>${esc(tp.name)}</b>${kwLevel(q.level)}${DR.combo >= 2 ? `<span class="combo">${ic("ti-flame")}${DR.combo} 連続</span>` : ""}</div>
      <h2 class="q-text">${esc(q.q)}</h2>
      ${q.code ? codeHTML(q.code, q.code_lang) : ""}
      <div class="choices">${order.map((ci, k) => `<button class="choice" data-la="pick" data-k="${k}" style="--k:${k}"><span class="key">${"ABCD"[k]}</span><span class="ct ${looksCode(q.choices[ci]) ? "mono" : ""}">${esc(q.choices[ci])}</span><span class="mk">${ic("ti-check")}${ic("ti-x")}</span></button>`).join("")}</div>
      <div class="explain" id="explain" hidden></div>
    </article>
    <p class="dr-keys">${ic("ti-keyboard")}<kbd>1</kbd>〜<kbd>4</kbd> で答える ・ <kbd>Enter</kbd> で次へ</p>`;
}

function explainHTML(ok, cur) {
  const q = cur.q, last = DR.i + 1 >= DR.qs.length, rep = REPORTED.has(q.id);
  return `<div class="ex-h ${ok ? "ok" : "ng"}">${ic(ok ? "ti-circle-check-filled" : "ti-circle-x-filled")}<b>${ok ? "正解！" : "ざんねん…"}</b>${ok ? "" : `<span>正解は <b>${"ABCD"[cur.order.indexOf(q.answer)]}</b></span>`}</div>
    <p>${esc(q.explain)}</p>
    <div class="ex-acts">
      ${q.link ? `<a class="ib sm" href="${esc(safeUrl(q.link))}" target="_blank" rel="noopener noreferrer" data-tip="公式ドキュメント">${ic("ti-book-2")}</a>` : ""}
      <button class="ib sm ghost" data-la="report" data-tip="${rep ? "報告済み" : "問題を報告"}" ${rep ? "disabled" : ""}>${ic("ti-flag")}</button>
      <button class="btn" data-la="next">${last ? "結果を見る" : "次へ"}${ic(last ? "ti-trophy" : "ti-arrow-right")}</button>
    </div>`;
}

function pickChoice(k) {
  if (!DR || DR.done || DR.picked != null) return;
  const cur = DR.qs[DR.i], ok = cur.order[k] === cur.q.answer;
  DR.picked = k; DR.res[DR.i] = ok;
  DR.combo = ok ? DR.combo + 1 : 0;
  const r = record(cur.q, ok, DR.track);
  DR.xp += r.gain + r.bonus;
  const chip = $(".rank-chip");
  if (chip) chip.outerHTML = rankChip();   // 右上の XP をその場で更新
  const btns = $$("#drill .choice");
  btns.forEach((b, j) => { b.disabled = true; b.classList.add(cur.order[j] === cur.q.answer ? "ok" : j === k ? "ng" : "dim"); });
  const seg = $$("#drill .dr-prog i")[DR.i];
  if (seg) { seg.classList.remove("cur"); seg.classList.add(ok ? "ok" : "ng"); }
  const ex = $("#explain");
  if (ex) { ex.innerHTML = explainHTML(ok, cur); ex.hidden = false; }
  const b = btns[k];
  if (b) {
    const rc = b.getBoundingClientRect();
    if (ok) {
      celebrate(rc.left + Math.min(rc.width * .3, 160), rc.top + rc.height / 2, 16);
      floatText(rc.right - 60, rc.top, `+${r.gain} XP`, "xp");
      if (DR.combo >= 3) setTimeout(() => floatText(rc.left + 90, rc.top - 6, `${DR.combo} COMBO!`, "combo"), 260);
    } else shake($("#drill .q-card"));
  }
  if (r.bonus) setTimeout(() => toast("ti-target-arrow", `今日の目標クリア！ +${r.bonus} XP`), 600);
  if (r.rankUp >= 0) setTimeout(() => rankUpFx(r.rankUp), 900);
  setTimeout(() => ex?.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" }), 80);
}

function nextQ() {
  if (!DR || DR.done || DR.picked == null) return;
  DR.i++; DR.picked = null;
  if (DR.i >= DR.qs.length) DR.done = true;
  const box = $("#drill");
  if (!box) return;
  const swap = () => {
    box.innerHTML = DR.done ? resultHTML() : questionHTML();
    box.classList.remove("out");
    animateIn(box);
    const top = box.getBoundingClientRect().top + scrollY - 90;
    if (scrollY > top) window.scrollTo({ top, behavior: REDUCED ? "auto" : "smooth" });
    if (DR.done) finishFx();
  };
  if (REDUCED) swap(); else { box.classList.add("out"); setTimeout(swap, 190); }
}

function resultHTML() {
  const T = TRACK[DR.track];
  const ok = DR.res.filter(Boolean).length, tot = DR.res.length, pct = tot ? Math.round(ok / tot * 100) : 0;
  const wrong = DR.qs.filter((_, k) => DR.res[k] === false);
  const msg = pct === 100 ? "パーフェクト！" : pct >= 80 ? "すばらしい！" : pct >= 50 ? "いい調子！" : "復習でのびる！";
  return `<section class="res rv in">
      <div class="res-ring" data-p="${pct}"><div><b data-count="${ok}">0</b><small>/ ${tot}</small></div></div>
      <h2>${msg}</h2>
      <div class="res-stats">
        <span>${ic("ti-bolt")}<b>+<span data-count="${DR.xp}">0</span></b> XP</span>
        <span>${ic("ti-flame")}<b>${streak()}</b> 日連続</span>
        <span>${ic("ti-target-arrow")}<b>${Math.min(todayCount(DR.track), T.daily)}</b>/${T.daily}</span>
      </div>
      <div class="res-acts">
        ${wrong.length ? `<button class="btn" data-la="retry">${ic("ti-rotate")}まちがえた ${wrong.length} 問</button>` : ""}
        <button class="btn ${wrong.length ? "plain" : ""}" data-la="again">${ic("ti-refresh")}もう一回</button>
        <a class="ib" href="#/${T.route}" data-tip="ホームへ">${ic("ti-home")}</a>
      </div>
    </section>
    ${wrong.length ? `<div class="sec-h">${ic("ti-eye-check")}見直し</div>${wrong.map(({ q }, i) => reviewCard(q, i)).join("")}` : ""}`;
}

const reviewCard = (q, i) => `<details class="rv-card rv in" style="--i:${i + 2}">
    <summary>${kwLevel(q.level)}<span>${esc(q.q)}</span>${ic("ti-chevron-down")}</summary>
    ${q.code ? codeHTML(q.code, q.code_lang) : ""}
    <p class="rv-ans">${ic("ti-circle-check-filled")}<span>${esc(q.choices[q.answer])}</span></p>
    <p>${esc(q.explain)}</p>
    ${q.link ? `<a class="kc-link" href="${esc(safeUrl(q.link))}" target="_blank" rel="noopener noreferrer">${ic("ti-book-2")}ドキュメント</a>` : ""}
  </details>`;

function finishFx() {
  const ok = DR.res.filter(Boolean).length, tot = DR.res.length;
  if (!tot || ok / tot < .8) return;
  setTimeout(() => {
    const r = $(".res-ring")?.getBoundingClientRect();
    if (r) celebrate(r.left + r.width / 2, r.top + r.height / 2, ok === tot ? 50 : 30);
  }, 500);
}

function rankUpFx(r) {
  celebrate(innerWidth / 2, innerHeight * .42, 60);
  const el = document.createElement("div");
  el.className = "rankup";
  el.innerHTML = `<span class="ru-ic">${ic(RANK_IC[r])}</span><small>RANK UP</small><b>${esc(RANKS[r].name)}</b>`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("out"), 2200);
  setTimeout(() => el.remove(), 2800);
}

// 数字のカウントアップ・リングの伸び
function animateIn(root = document, counts = true) {
  if (!root) return;
  if (counts) $$("[data-count]", root).forEach(el => countUp(el, Number(el.dataset.count)));
  setTimeout(() => {
    $$("[data-p]", root).forEach(el => el.style.setProperty("--p", el.dataset.p));
    $$("[data-off]", root).forEach(el => { el.style.strokeDashoffset = el.dataset.off; });
  }, 60);
}

/* ------------------------------------------------------------ 問題の報告 */
const REASONS = ["答えがまちがっている", "問題文がわかりにくい", "選択肢がおかしい", "その他"];
function openReport() {
  const cur = DR?.qs[DR.i];
  if (!cur) return;
  REP = cur.q;
  closeModal();
  const m = document.createElement("div");
  m.className = "modal-wrap"; m.id = "modal";
  m.innerHTML = `<div class="scrim on" data-la="m-close"></div>
    <div class="modal" role="dialog" aria-label="問題を報告">
      <div class="m-h"><span class="hi h">${ic("ti-flag")}</span><b>問題を報告</b><button class="ib sm ghost" data-la="m-close" data-tip="閉じる">${ic("ti-x")}</button></div>
      <p class="m-q">${esc(REP.q)}</p>
      <div class="reasons">${REASONS.map((r, i) => `<button class="chip ${i ? "" : "on"}" style="--cat:var(--hot)" data-la="m-reason" data-v="${esc(r)}">${esc(r)}</button>`).join("")}</div>
      <textarea id="rep-text" maxlength="200" placeholder="どこがおかしいか（任意）"></textarea>
      <div class="m-acts"><small>${ic("ti-info-circle")}次の朝の更新で確認・修正されます</small><button class="btn" data-la="m-send">${ic("ti-send")}送る</button></div>
    </div>`;
  document.body.appendChild(m);
}
function closeModal() { $("#modal")?.remove(); }
async function sendReport(btn) {
  const q = REP;
  if (!q) return;
  const extra = $("#rep-text")?.value.trim();
  const reason = ($(".reasons .chip.on")?.dataset.v || "その他") + (extra ? "：" + extra : "");
  if (!S.api.report && S.api.login) {   // 本番でログインしていない：ログインしてからもう一度押してもらう
    toast("ti-login", "報告にはログインが必要です（ログイン後にもう一度送ってください）");
    S.api.login();
    return;
  }
  btn.disabled = true;
  try {
    if (S.api.report) await S.api.report({ qid: String(q.id).slice(0, 40), topic: q.topic || "", track: q.track || "", q: q.q.slice(0, 300), reason: reason.slice(0, 300) });
    REPORTED.add(q.id);
    closeModal();
    toast("ti-flag", S.api.report ? "報告しました。ありがとうございます" : "（デモ）報告しました");
    $$('[data-la="report"]').forEach(b => { b.disabled = true; b.dataset.tip = "報告済み"; });
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    toast("ti-alert-triangle", "送れませんでした");
  }
}

/* =========================================================== コード表示 */
const KWS = {
  cpp: new Set(("alignas alignof auto bool break case catch char class const constexpr consteval constinit continue co_await co_return co_yield " +
    "decltype default delete do double else enum explicit export extern false final float for friend if inline int long mutable namespace new " +
    "noexcept nullptr operator override private protected public return short signed sizeof static static_assert static_cast dynamic_cast " +
    "reinterpret_cast const_cast struct switch template this thread_local throw true try typedef typename union unsigned using virtual void " +
    "volatile while std size_t uint8_t uint16_t uint32_t uint64_t int32_t int64_t").split(" ")),
  hlsl: new Set(("cbuffer tbuffer struct return if else for while do break continue discard switch case default float float2 float3 float4 " +
    "float2x2 float3x3 float4x4 half half2 half3 half4 double int int2 int3 int4 uint uint2 uint3 uint4 bool void in out inout uniform static " +
    "const groupshared numthreads Texture2D Texture2DArray TextureCube RWTexture2D StructuredBuffer RWStructuredBuffer ByteAddressBuffer " +
    "RWByteAddressBuffer ConstantBuffer SamplerState SamplerComparisonState register packoffset row_major column_major true false matrix vector " +
    "SV_Position SV_Target SV_Depth SV_DispatchThreadID SV_GroupThreadID SV_GroupID SV_GroupIndex SV_VertexID SV_InstanceID SV_IsFrontFace").split(" ")),
};
function hlCode(code, lang) {
  const kw = KWS[lang] || KWS.cpp;
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n]){1,4}')|(\b\d[\d.]*(?:e[+-]?\d+)?[fFuUlLhH]*\b)|(^[ \t]*#[ \t]*\w+)|([A-Za-z_]\w*)/gm;
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const t = m[0];
    out += m[1] ? `<span class="c">${esc(t)}</span>` : m[2] ? `<span class="s">${esc(t)}</span>` : m[3] ? `<span class="n">${esc(t)}</span>`
      : m[4] ? `<span class="p">${esc(t)}</span>` : kw.has(t) ? `<span class="k">${esc(t)}</span>` : /^[A-Z]/.test(t) ? `<span class="t">${esc(t)}</span>` : esc(t);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}
export function codeHTML(code, lang) {
  return `<div class="code"><div class="code-h"><span>${esc(String(lang || "code").toUpperCase())}</span><button class="ib sm ghost" data-la="copy-code" data-tip="コピー">${ic("ti-copy")}</button></div><pre><code>${lang === "text" ? esc(code) : hlCode(code, lang)}</code></pre></div>`;
}

/* ======================================================= 技術キーワード */
let KWC = [], KWsrc = null;
function kwAll() {
  if (KWsrc === S.learn.kw) return KWC;
  KWsrc = S.learn.kw;
  const m = new Map();
  for (const [a, list] of Object.entries(S.learn.kw || {})) for (const k of list || []) {
    if (!k?.term || !k.explain) continue;
    const key = `${a}|${norm(k.term)}`;
    const prev = m.get(key);
    if (!prev || String(k.date || "") >= String(prev.date || "")) m.set(key, { ...k, area: a, key });
  }
  KWC = [...m.values()];
  return KWC;
}

// 3つ1組（基礎 → 発展 → 応用）のまとまり。新しい順
export function ladders(a = "") {
  const g = new Map();
  for (const k of kwAll()) {
    if (a && k.area !== a) continue;
    const id = `${k.area}|${k.date || ""}|${k.slot || ""}|${k.theme || ""}`;
    if (!g.has(id)) g.set(id, { id, area: k.area, date: String(k.date || ""), slot: String(k.slot || ""), theme: k.theme || "", items: [] });
    g.get(id).items.push(k);
  }
  const L = [...g.values()];
  L.forEach(x => x.items.sort((p, q) => (KW_LV[p.level]?.n || 9) - (KW_LV[q.level]?.n || 9)));
  const so = s => ({ "10": "1", "17": "2", "22": "3" }[s] || "0");
  return L.sort((p, q) => q.date.localeCompare(p.date) || so(q.slot).localeCompare(so(p.slot)));
}
const latestLadders = () => { const seen = new Set(); return ladders().filter(g => !seen.has(g.area) && seen.add(g.area)); };

export function ladderHTML(g, i = 0) {
  const A = area(g.area);
  return `<div class="ladder rv" style="--i:${i};--ac:${A.color}">
    <div class="ld-h"><span class="ld-ic">${ic(A.icon)}</span><span class="ld-t"><small>${ic("ti-key")}技術キーワード ・ ${esc(A.name)}</small><b>${esc(g.theme || "今日のキーワード")}</b></span></div>
    <div class="ld-steps">${g.items.map((k, j) => `${j ? `<span class="ld-arrow">${ic("ti-chevron-right")}</span>` : ""}<button class="kw-step ${P.kwKnown.has(k.key) ? "known" : ""}" style="--cat:${KW_LV[k.level]?.color || A.color};--j:${j}" data-la="kw" data-key="${esc(k.key)}">${kwLevel(k.level)}<b>${esc(k.term)}</b>${k.en ? `<small>${esc(k.en)}</small>` : ""}<i class="ti ti-circle-check-filled kn"></i></button>`).join("")}</div>
  </div>`;
}

export function openKw(key, fromEl, point) {
  const k = kwAll().find(x => x.key === key);
  if (!k) return;
  const A = area(k.area), on = P.kwKnown.has(key);
  const g = ladders(k.area).find(x => x.items.some(y => y.key === key));
  const html = `<div class="band">
      <div class="tb dz" style="--d:1">
        <button class="ib ${on ? "on" : ""}" data-la="known" data-key="${esc(key)}" data-tip="${on ? "覚えた" : "覚えたにする"}">${ic("ti-circle-check")}</button>
        <button class="ib" data-close data-tip="閉じる">${ic("ti-x")}</button></div>
      <div class="b-top dz" style="--d:0"><span class="cat-ic" style="--cat:${A.color}">${ic(A.icon)}</span><span class="b-cat">${esc(A.name)}</span>${kwLevel(k.level)}</div>
      <h2 class="dz" style="--d:1">${esc(k.term)}</h2>
      ${k.en ? `<p class="kd-en dz" style="--d:2">${esc(k.en)}</p>` : ""}
    </div>
    <div class="dgrid">
      <div class="dmain">
        <p class="lead dz" style="--d:3">${esc(k.explain)}</p>
        <section class="dsec dz" style="--d:4"><h3 class="sh">${ic("ti-tool")}なにに使う？</h3><p class="para">${esc(k.use)}</p></section>
        ${k.example ? `<section class="dsec dz" style="--d:5"><h3 class="sh">${ic("ti-code")}コード例</h3>${codeHTML(k.example, k.example_lang)}</section>` : ""}
      </div>
      <aside class="dside">
        ${k.link ? `<a class="btn big wide dz" style="--d:3" href="${esc(safeUrl(k.link))}" target="_blank" rel="noopener noreferrer">${ic("ti-book-2")}ドキュメント</a>` : ""}
        <a class="btn plain wide dz" style="--d:4" href="#/prog?t=kw&area=${esc(k.area)}&k=${encodeURIComponent(key)}" data-close>${ic("ti-books")}図鑑で見る</a>
        ${g && g.items.length > 1 ? `<section class="dsec dz" style="--d:5"><h3 class="sh">${ic("ti-stairs")}${esc(g.theme || "ステップで覚える")}</h3>
          ${g.items.map(x => `<a class="mini ${x.key === key ? "cur" : ""}" data-la="kw" data-key="${esc(x.key)}">${kwLevel(x.level)}<span class="t">${esc(x.term)}</span></a>`).join("")}</section>` : ""}
      </aside>
    </div>`;
  showDrawer(html, A.color, fromEl, point);
}

function toggleKnown(key, btn) {
  const on = !P.kwKnown.has(key);
  if (on) P.kwKnown.add(key); else P.kwKnown.delete(key);
  P.save();
  $$("[data-key]").filter(el => el.dataset.key === key).forEach(el => {
    if (el.dataset.la === "known") { el.classList.toggle("on", on); el.dataset.tip = on ? "覚えた" : "覚えたにする"; }
    if (el.matches(".kw-step, .kw-card")) el.classList.toggle("known", on);
  });
  if (on) { burst(btn); toast("ti-circle-check", "覚えたにしました"); }
}

export function kwHits(terms) {
  if (!terms.length) return [];
  return kwAll().filter(k => { const t = norm([k.term, k.en, k.theme].join(" ")); return terms.every(w => t.includes(w)); }).slice(0, 3);
}

function kwTab() {
  const cur = AREAS[S.params.area] ? S.params.area : "";
  const all = kwAll(), inArea = all.filter(k => !cur || k.area === cur);
  const known = inArea.filter(k => P.kwKnown.has(k.key)).length, p = inArea.length ? known / inArea.length : 0;
  const tab = (id, icon, name, n) => `<a class="${cur === id ? "on" : ""}" href="#/prog?t=kw${id ? "&area=" + id : ""}">${ic(icon)}<span>${esc(name)}</span><span class="n">${n}</span></a>`;
  return `<div class="kw-top rv" style="--i:2">
      <div class="kw-prog" data-tip="覚えたキーワード"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="bg"/><circle cx="22" cy="22" r="18" class="fg" style="stroke-dashoffset:${C_SM}" data-off="${(C_SM * (1 - p)).toFixed(1)}"/></svg><span><b>${known}</b><small>/${inArea.length}</small></span></div>
      <nav class="seg">${tab("", "ti-layout-grid", "すべて", all.length)}${Object.entries(AREAS).map(([id, A]) => tab(id, A.icon, A.name, all.filter(k => k.area === id).length)).join("")}</nav>
    </div>
    <div class="kw-tools rv" style="--i:3">
      <div class="sbar sm">${ic("ti-search")}<input type="search" id="kwq" value="${esc(S.params.q || "")}" placeholder="用語・英語名で探す" autocomplete="off"></div>
      <div class="seg">${[["", "ti-list", "すべて"], ["todo", "ti-circle-dashed", "まだ"], ["known", "ti-circle-check", "覚えた"]].map(([v, icon, l]) =>
        `<button class="${(S.params.f || "") === v ? "on" : ""}" data-la="kw-f" data-v="${v}">${ic(icon)}${l}</button>`).join("")}</div>
    </div>
    <div id="kw-list">${kwListHTML()}</div>`;
}

function kwListHTML() {
  const cur = AREAS[S.params.area] ? S.params.area : "", f = S.params.f || "";
  const terms = norm(S.params.q || "").split(/\s+/).filter(Boolean);
  const groups = ladders(cur).map(g => ({ ...g, items: g.items.filter(k => {
    if (f === "known" && !P.kwKnown.has(k.key)) return false;
    if (f === "todo" && P.kwKnown.has(k.key)) return false;
    return !terms.length || terms.every(w => norm([k.term, k.en, k.explain, k.use, g.theme].join(" ")).includes(w));
  }) })).filter(g => g.items.length);
  if (!groups.length) {
    return kwAll().length ? emptyHTML("見つかりませんでした", "ことばを短くしてみてください")
      : emptyHTML("キーワードはまだありません", "毎回の配信（10:00 / 17:00 / 22:00）で 3 つずつ増えます");
  }
  return groups.map((g, gi) => {
    const A = area(g.area), when = [md(g.date), SLOT_LABEL[g.slot] && g.slot !== "learn" ? SLOT_LABEL[g.slot] : ""].filter(Boolean).join(" ");
    return `<section class="kw-group rv in" style="--i:${Math.min(gi, 8)};--ac:${A.color}">
      <div class="kg-h"><span class="ld-ic">${ic(A.icon)}</span><div><small>${esc(A.name)}${when ? ` ・ ${esc(when)}` : ""}</small><b>${esc(g.theme || "キーワード")}</b></div></div>
      <div class="kw-cards">${g.items.map(kwCard).join("")}</div>
    </section>`;
  }).join("");
}

const kwCard = k => {
  const on = P.kwKnown.has(k.key);
  return `<article class="kw-card ${on ? "known" : ""}" id="k${hash(k.key)}" data-key="${esc(k.key)}" style="--lc:${KW_LV[k.level]?.color || "#999"}">
    <div class="kc-top">${kwLevel(k.level)}<button class="ib sm ghost ${on ? "on" : ""}" data-la="known" data-key="${esc(k.key)}" data-tip="${on ? "覚えた" : "覚えたにする"}">${ic("ti-circle-check")}</button></div>
    <h3>${esc(k.term)}</h3>${k.en ? `<p class="kc-en">${esc(k.en)}</p>` : ""}
    <p class="kc-ex">${esc(k.explain)}</p>
    <p class="kc-use">${ic("ti-tool")}<span>${esc(k.use)}</span></p>
    ${k.example ? `<details class="kc-code"><summary>${ic("ti-code")}コード例</summary>${codeHTML(k.example, k.example_lang)}</details>` : ""}
    ${k.link ? `<a class="kc-link" href="${esc(safeUrl(k.link))}" target="_blank" rel="noopener noreferrer">${ic("ti-book-2")}ドキュメント</a>` : ""}
  </article>`;
};
const paintKwList = () => { const el = $("#kw-list"); if (el) el.innerHTML = kwListHTML(); };

/* ============================================================== 部品 */
function sectionPage(track, tabs, body) {
  const T = TRACK[track], cur = tabs.some(([k]) => k === S.params.t) ? S.params.t : "home";
  return `<div class="page sec-page" style="--sec:${T.color}">
    ${pageHead(T.icon, T.name, rankChip())}
    <nav class="seg tabs rv" style="--i:1">${tabs.map(([k, icon, l]) => `<a class="${cur === k ? "on" : ""}" href="#/${T.route}${k === "home" ? "" : "?t=" + k}">${ic(icon)}<span>${l}</span></a>`).join("")}</nav>
    ${body}
  </div>`;
}

function rankChip() {
  const r = rankOf(P.xp), cur = RANKS[r], next = RANKS[r + 1];
  const pct = next ? (P.xp - cur.xp) / (next.xp - cur.xp) * 100 : 100;
  return `<a class="rank-chip" href="#/saved" data-tip="${next ? `次のランクまで ${next.xp - P.xp} XP` : "最高ランク"}" data-tip-pos="bottom">${ic(RANK_IC[r])}<b>${esc(cur.name)}</b><span class="xpbar"><i style="width:${pct.toFixed(0)}%"></i></span><small>${P.xp} XP</small></a>`;
}

export function rankBox(i = 2) {
  const r = rankOf(P.xp), cur = RANKS[r], next = RANKS[r + 1];
  const pct = next ? (P.xp - cur.xp) / (next.xp - cur.xp) * 100 : 100;
  return `<div class="box rank-box rv" style="--i:${i}"><div class="box-h"><span class="hi">${ic("ti-award")}</span>ランク</div>
    <div class="rk"><span class="rk-ic">${ic(RANK_IC[r])}</span><div><b>${esc(cur.name)}</b><small><span data-count="${P.xp}">0</span> XP</small></div></div>
    <div class="xpbar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <small class="rk-next">${next ? `「${esc(next.name)}」まであと ${next.xp - P.xp} XP` : "最高ランクに到達！"}</small>
  </div>`;
}

function statBox(track, st, i) {
  return `<div class="box rv" style="--i:${i}"><div class="box-h"><span class="hi p">${ic("ti-chart-dots")}</span>記録</div>
    <div class="stat">
      <div data-tip="解いた回数">${ic("ti-pencil")}<b data-count="${st.answered}">0</b></div>
      <div data-tip="正答率（%）">${ic("ti-percentage")}<b data-count="${st.acc}">0</b></div>
      <div data-tip="マスターした問題">${ic("ti-crown")}<b data-count="${st.mastered}">0</b></div>
    </div></div>`;
}

function zukanBox(i) {
  const all = kwAll();
  if (!all.length) return "";
  return `<div class="box rv" style="--i:${i}"><div class="box-h"><span class="hi">${ic("ti-books")}</span>キーワード図鑑<a class="ib sm ghost more" href="#/prog?t=kw" data-tip="図鑑へ">${ic("ti-arrow-right")}</a></div>
    ${Object.entries(AREAS).map(([id, A]) => {
      const L = all.filter(k => k.area === id), n = L.filter(k => P.kwKnown.has(k.key)).length;
      return `<a class="zk" href="#/prog?t=kw&area=${id}" style="--ac:${A.color}"><span class="zk-ic">${ic(A.icon)}</span><span class="zk-b"><b>${esc(A.name)}</b><span class="t-bar"><i style="width:${L.length ? (n / L.length * 100).toFixed(0) : 0}%"></i></span></span><small>${n}/${L.length}</small></a>`;
    }).join("")}
  </div>`;
}

function dailyHero(track, st, i) {
  const T = TRACK[track], tc = todayCount(track), done = tc >= T.daily, p = Math.min(1, tc / T.daily);
  if (!st.total) {
    return `<section class="dhero rv" style="--i:${i};--cat:${T.color}"><div class="dh-body"><small class="dh-k">${ic("ti-target-arrow")}今日のドリル</small>
      <h2>問題を準備中です</h2><p class="muted-s">毎朝 7 時ごろに新しい問題が届きます</p></div><span class="dh-deco">${ic(T.icon)}</span></section>`;
  }
  return `<section class="dhero rv" style="--i:${i};--cat:${T.color}">
    <div class="dh-ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="bg"/><circle cx="60" cy="60" r="52" class="fg" style="stroke-dashoffset:${C_RING}" data-off="${(C_RING * (1 - p)).toFixed(1)}"/></svg><div><b>${Math.min(tc, T.daily)}</b><small>/${T.daily}</small></div></div>
    <div class="dh-body">
      <small class="dh-k">${ic("ti-target-arrow")}今日のドリル</small>
      <h2>${done ? "今日の目標クリア！" : `${T.daily}問チャレンジ`}</h2>
      <div class="dh-stats">
        <span data-tip="連続日数">${ic("ti-flame")}<b>${streak()}</b></span>
        <span data-tip="復習待ち">${ic("ti-repeat")}<b>${st.due}</b></span>
        <span data-tip="正答率（%）">${ic("ti-percentage")}<b>${st.acc}</b></span>
        <span data-tip="ぜんぶの問題">${ic("ti-stack-2")}<b>${st.total}</b></span>
      </div>
      <div class="dh-acts">
        <button class="btn big" data-la="start" data-track="${track}" data-mode="daily">${ic("ti-player-play-filled")}${done ? "もう一回" : "スタート"}</button>
        ${st.weak ? `<button class="btn plain" data-la="start" data-track="${track}" data-mode="review">${ic("ti-repeat")}苦手 ${st.weak}</button>` : ""}
        <a class="ib" href="#/${T.route}?t=drill" data-tip="条件を選ぶ">${ic("ti-adjustments")}</a>
      </div>
    </div>
    <span class="dh-deco">${ic(T.icon)}</span>
  </section>`;
}

function topicTile(track, t, i) {
  const qs = topicBank(t.id), m = Math.round(mastery(qs) * 100), seen = qs.filter(q => P.qp[q.id]).length;
  return `<a class="tile rv" style="--i:${i}" href="#/${TRACK[track].route}?t=drill&topic=${t.id}">
    <span class="t-ic">${ic(t.icon)}</span><b>${esc(t.name)}</b>
    <span class="t-meta"><span data-tip="問題数">${ic("ti-stack-2")}${qs.length}</span><span data-tip="解いた">${ic("ti-check")}${seen}</span><span class="m" data-tip="習熟度">${m}%</span></span>
    <span class="t-bar"><i style="width:${m}%"></i></span>
  </a>`;
}

const sectionNews = track => S.items.filter(it => (it.section || it.category) === track).sort(sortNew);
function olderNews(track, news) {
  const rest = news.slice(1, 6);
  if (!rest.length) return "";
  return `<div class="sec-h rv">${ic("ti-news")}これまでのニュース<a class="ib sm ghost more" href="#/search?cats=${track}" data-tip="すべて">${ic("ti-arrow-right")}</a></div>
    <div class="rows" style="padding:0">${rest.map((it, i) => rowHTML(it, i)).join("")}</div>`;
}
const newsHero = (news, i) => news[0] ? heroHTML(news[0], news[0].date === todayStr() ? "TODAY" : "NEW", i) : "";

/* ============================================================ ホーム */
function progHome() {
  const st = trackStats("programmer"), news = sectionNews("programmer"), lads = latestLadders();
  return `<div class="grid2"><div>
      ${newsHero(news, 2)}
      ${dailyHero("programmer", st, 3)}
      <div class="sec-h rv" style="--i:4">${ic("ti-category")}トピック</div>
      <div class="topics">${TOPICS.programmer.map((t, i) => topicTile("programmer", t, i + 4)).join("")}</div>
      ${lads.length ? `<div class="sec-h rv">${ic("ti-key")}最新の技術キーワード<a class="ib sm ghost more" href="#/prog?t=kw" data-tip="図鑑へ">${ic("ti-arrow-right")}</a></div>${lads.map((g, i) => ladderHTML(g, i)).join("")}` : ""}
      ${olderNews("programmer", news)}
    </div>
    <aside class="side-col">${rankBox(3)}${statBox("programmer", st, 4)}${zukanBox(5)}</aside>
  </div>`;
}

function planHome() {
  const st = trackStats("planner"), news = sectionNews("planner");
  return `<div class="grid2"><div>
      ${themeCard(todayTheme(), 2)}
      ${newsHero(news, 3)}
      <div class="sec-h rv" style="--i:4">${ic("ti-dice-5")}ひらめきガチャ<a class="ib sm ghost more" href="#/plan?t=gacha" data-tip="5つの言葉で回す">${ic("ti-arrow-right")}</a></div>
      ${miniGacha(5)}
      ${dailyHero("planner", st, 6)}
      <div class="topics" style="margin-top:var(--s4)">${TOPICS.planner.map((t, i) => topicTile("planner", t, i + 7)).join("")}</div>
      ${olderNews("planner", news)}
    </div>
    <aside class="side-col">${rankBox(3)}${notesBox(4)}${themeHistBox(5)}</aside>
  </div>`;
}

export function viewProg() {
  const tabs = [["home", "ti-home", "ホーム"], ["drill", "ti-target-arrow", "ドリル"], ["kw", "ti-books", "キーワード図鑑"]];
  const t = S.params.t;
  return sectionPage("programmer", tabs, t === "drill" ? drillTab("programmer") : t === "kw" ? kwTab() : progHome());
}

export function viewPlan() {
  const tabs = [["home", "ti-home", "ホーム"], ["theme", "ti-flag-3", "お題"], ["gacha", "ti-dice-5", "ガチャ"],
                ["timer", "ti-hourglass", "ブレスト"], ["drill", "ti-target-arrow", "用語ドリル"], ["notes", "ti-notes", "ノート"]];
  const V = { theme: themeTab, gacha: gachaTab, timer: timerTab, drill: () => drillTab("planner"), notes: notesTab };
  return sectionPage("planner", tabs, (V[S.params.t] || planHome)());
}

/* ============================================================== お題 */
export function todayTheme() {
  const d = S.learn.daily;
  if (d?.theme?.title) return { date: d.date, ...d.theme };
  return themeHistory()[0] || null;
}
const themeHistory = () => [...(S.learn.themes || [])].filter(h => h?.title).sort((a, b) => String(b.date).localeCompare(String(a.date)));

function themeCard(th, i = 1) {
  if (!th) {
    return `<section class="theme-card rv" style="--i:${i}"><div class="tc-k">${ic("ti-flag-3")}今日のお題</div>
      <h2 class="tc-title">準備中</h2><p class="tc-note">${ic("ti-clock")}<span>毎朝 7 時ごろに届きます</span></p></section>`;
  }
  return `<section class="theme-card rv" style="--i:${i}">
    <span class="tc-bg" aria-hidden="true">お題</span>
    <div class="tc-k">${ic("ti-flag-3")}${th.date === todayStr() ? "今日のお題" : "お題"}<span class="tc-d">${md(th.date)}</span></div>
    <h2 class="tc-title">${esc(th.title)}</h2>
    ${(th.angles || []).length ? `<ol class="tc-angles">${th.angles.map((a, k) => `<li style="--k:${k}">${esc(a)}</li>`).join("")}</ol>` : ""}
    ${th.note ? `<p class="tc-note">${ic("ti-bulb")}<span>${esc(th.note)}</span></p>` : ""}
    <div class="tc-acts">
      <button class="btn" data-la="th-timer" data-title="${esc(th.title)}">${ic("ti-hourglass")}ブレスト</button>
      <button class="btn alt" data-la="th-note" data-date="${esc(th.date)}">${ic("ti-pencil-plus")}ノート</button>
      <a class="ib" href="#/plan?t=gacha" data-tip="ガチャで発想">${ic("ti-dice-5")}</a>
    </div>
  </section>`;
}

function themeTab() {
  const th = todayTheme(), hist = themeHistory().filter(h => h.date !== th?.date).slice(0, 60);
  return `<div class="grid2"><div>
      ${themeCard(th, 2)}
      ${hist.length ? `<div class="sec-h rv" style="--i:3">${ic("ti-history")}これまでのお題</div>
      <div class="th-list">${hist.map((h, i) => `<details class="th-item rv" style="--i:${Math.min(i + 4, 12)}" id="th-${esc(h.date)}" ${S.params.d === h.date ? "open" : ""}>
        <summary><span class="d">${md(h.date)}</span><b>${esc(h.title)}</b>${ic("ti-chevron-down")}</summary>
        ${(h.angles || []).length ? `<ol>${h.angles.map(a => `<li>${esc(a)}</li>`).join("")}</ol>` : ""}
        ${h.note ? `<p>${esc(h.note)}</p>` : ""}
        <div class="th-acts"><button class="ib sm" data-la="th-timer" data-title="${esc(h.title)}" data-tip="ブレスト">${ic("ti-hourglass")}</button><button class="ib sm" data-la="th-note" data-date="${esc(h.date)}" data-tip="ノートに書く">${ic("ti-pencil-plus")}</button></div>
      </details>`).join("")}</div>` : ""}
    </div>
    <aside class="side-col">${howBox(3)}${notesBox(4)}</aside>
  </div>`;
}

const howBox = i => `<div class="box rv" style="--i:${i}"><div class="box-h"><span class="hi">${ic("ti-route")}</span>使い方</div>
  <ol class="how">
    <li>${ic("ti-hourglass")}<span><b>ブレスト</b>5分で思いつくだけ書く</span></li>
    <li>${ic("ti-dice-5")}<span><b>ガチャ</b>言葉を組み合わせて広げる</span></li>
    <li>${ic("ti-file-text")}<span><b>ノート</b>1枚の企画にまとめる</span></li>
  </ol></div>`;

function themeHistBox(i) {
  const th = todayTheme(), hist = themeHistory().filter(h => h.date !== th?.date).slice(0, 5);
  if (!hist.length) return "";
  return `<div class="box rv" style="--i:${i}"><div class="box-h"><span class="hi p">${ic("ti-history")}</span>これまでのお題<a class="ib sm ghost more" href="#/plan?t=theme" data-tip="すべて">${ic("ti-arrow-right")}</a></div>
    ${hist.map(h => `<a class="mini" href="#/plan?t=theme&d=${esc(h.date)}"><span class="md">${md(h.date)}</span><span class="t">${esc(h.title)}</span></a>`).join("")}</div>`;
}

function themeToNote(date) {
  const th = [todayTheme(), ...themeHistory()].find(h => h && h.date === date) || todayTheme();
  if (!th) return;
  newNote({ title: th.title, f: { memo: [...(th.angles || []).map(a => "・" + a), th.note ? "\n" + th.note : ""].join("\n").trim() },
            src: `お題「${th.title}」（${md(th.date)}）` });
}

/* ============================================================ ガチャ */
const POOLS = [
  { id: "genre", name: "ジャンル", icon: "ti-device-gamepad-2" },
  { id: "mechanic", name: "しくみ", icon: "ti-settings" },
  { id: "theme", name: "舞台・題材", icon: "ti-world" },
  { id: "constraint", name: "しばり", icon: "ti-hand-stop" },
  { id: "feeling", name: "感じてほしいこと", icon: "ti-heart" },
];
const MINI = ["genre", "mechanic", "theme"];
const G = (() => { const g = store.get("gacha", {}); return { cur: g.cur || {}, lock: g.lock || [], hist: g.hist || [] }; })();
const saveG = () => store.set("gacha", G);
const words = id => (S.learn.ideas?.[id] || []).filter(w => typeof w === "string" && w);
function pickOther(list, cur) {
  if (list.length < 2) return list[0] || "";
  let w;
  do { w = pick(list); } while (w === cur);
  return w;
}
function fillGacha() {
  let ch = false;
  [...POOLS.map(p => p.id), "prompt"].forEach(id => { if (!G.cur[id] && words(id).length) { G.cur[id] = pick(words(id)); ch = true; } });
  if (ch) saveG();
}
const comboText = (c = G.cur) => `${c.genre} × ${c.mechanic}｜舞台：${c.theme}｜しばり：${c.constraint}｜感じてほしいこと：${c.feeling}`;

function reelHTML(p, i, mini) {
  const locked = G.lock.includes(p.id);
  return `<div class="reel ${locked ? "locked" : ""}" data-pool="${p.id}" style="--i:${i}">
    <span class="r-l" ${mini ? `data-tip="${esc(p.name)}"` : ""}>${ic(p.icon)}${mini ? "" : `<small>${esc(p.name)}</small>`}</span>
    <div class="win"><span>${esc(G.cur[p.id] || "—")}</span></div>
    ${mini ? "" : `<button class="ib sm ${locked ? "on" : ""}" data-la="lock" data-pool="${p.id}" data-tip="${locked ? "固定中" : "固定する"}">${ic(locked ? "ti-lock" : "ti-lock-open")}</button>`}
  </div>`;
}

function miniGacha(i) {
  fillGacha();
  if (!words("genre").length) return `<p class="muted-s rv" style="--i:${i}">言葉を準備中です</p>`;
  return `<section class="gacha mini rv" style="--i:${i}">
    <div class="reels">${POOLS.filter(p => MINI.includes(p.id)).map((p, k) => reelHTML(p, k, true)).join("")}</div>
    <div class="g-acts"><button class="btn" data-la="spin" data-scope="mini">${ic("ti-dice-5")}回す</button><span class="sp"></span>
      <button class="ib" data-la="g-note" data-scope="mini" data-tip="ノートにする">${ic("ti-pencil-plus")}</button>
      <a class="ib" href="#/plan?t=gacha" data-tip="5つで回す">${ic("ti-arrows-maximize")}</a></div>
  </section>`;
}

function gachaTab() {
  fillGacha();
  if (!words("genre").length) return emptyHTML("ガチャの言葉を準備中です", "毎朝の更新で追加されます");
  return `<div class="gacha-page">
    <section class="gacha rv" style="--i:2">
      <div class="reels">${POOLS.map((p, i) => reelHTML(p, i, false)).join("")}</div>
      <div class="g-prompt">${ic("ti-message-question")}<span id="g-prompt">${esc(G.cur.prompt || "")}</span></div>
      <div class="g-acts">
        <button class="btn big" data-la="spin" data-scope="full">${ic("ti-dice-5")}回す<kbd>Space</kbd></button>
        <span class="sp"></span>
        <button class="ib" data-la="g-copy" data-tip="コピー">${ic("ti-copy")}</button>
        <button class="ib" data-la="g-timer" data-tip="この組み合わせでブレスト">${ic("ti-hourglass")}</button>
        <button class="ib" data-la="g-note" data-scope="full" data-tip="ノートにする">${ic("ti-pencil-plus")}</button>
      </div>
    </section>
    <div class="sec-h rv" style="--i:3">${ic("ti-history")}履歴</div>
    <div class="g-hist rv" style="--i:4" id="g-hist">${histHTML()}</div>
  </div>`;
}
const histHTML = () => G.hist.slice(0, 8).map((h, i) => `<button class="g-h" data-la="g-hist" data-i="${i}"><b>${esc(h.genre || "")} × ${esc(h.mechanic || "")}</b><small>${esc(h.theme || "")}</small></button>`).join("")
  || `<p class="muted-s">まだありません</p>`;

let spinning = false;
function spin(scope, btn) {
  if (spinning) return;
  const ids = (scope === "mini" ? MINI : POOLS.map(p => p.id)).filter(id => !G.lock.includes(id) && words(id).length);
  if (!ids.length) { toast("ti-lock", "すべて固定されています"); return; }
  spinning = true;
  const next = { ...G.cur };
  ids.forEach(id => { next[id] = pickOther(words(id), G.cur[id]); });
  if (scope !== "mini" && words("prompt").length) next.prompt = pickOther(words("prompt"), G.cur.prompt);
  G.cur = next;
  G.hist = [{ genre: next.genre, mechanic: next.mechanic, theme: next.theme, constraint: next.constraint, feeling: next.feeling, prompt: next.prompt }, ...G.hist].slice(0, 12);
  saveG();
  const root = btn?.closest(".gacha") || document;
  const jobs = ids.map((id, i) => rollReel($(`.reel[data-pool="${id}"] .win`, root), id, next[id], i));
  const pr = $("#g-prompt", root);
  if (pr && scope !== "mini") { pr.classList.remove("swap"); void pr.offsetWidth; pr.textContent = next.prompt || ""; pr.classList.add("swap"); }
  Promise.all(jobs).then(() => {
    spinning = false;
    if (btn) burst(btn, 10);
    const h = $("#g-hist"); if (h) h.innerHTML = histHTML();
  });
  setTimeout(() => { spinning = false; }, 2800);
}

function rollReel(win, id, word, i) {
  if (!win) return Promise.resolve();
  const reel = win.closest(".reel");
  if (REDUCED) { win.innerHTML = `<span>${esc(word)}</span>`; return Promise.resolve(); }
  const H = win.clientHeight || 56;
  const seq = Array.from({ length: 7 + i * 3 }, () => pick(words(id)));
  const strip = document.createElement("div");
  strip.className = "strip";
  strip.innerHTML = [win.textContent.trim(), ...seq, word].map(w => `<span>${esc(w)}</span>`).join("");
  win.replaceChildren(strip);
  reel.classList.add("rolling");
  const dur = 700 + i * 240;
  const anim = strip.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-(seq.length + 1) * H}px)` }],
                             { duration: dur, easing: "cubic-bezier(.12,.8,.24,1.06)", fill: "forwards" });
  return Promise.race([anim.finished.catch(() => {}), wait(dur + 400)]).then(() => {
    win.innerHTML = `<span>${esc(word)}</span>`;
    reel.classList.remove("rolling"); reel.classList.add("hit");
    setTimeout(() => reel.classList.remove("hit"), 700);
  });
}

function toggleLock(id, btn) {
  const on = !G.lock.includes(id);
  G.lock = on ? [...G.lock, id] : G.lock.filter(x => x !== id);
  saveG();
  btn.classList.toggle("on", on);
  btn.dataset.tip = on ? "固定中" : "固定する";
  btn.innerHTML = ic(on ? "ti-lock" : "ti-lock-open");
  btn.closest(".reel")?.classList.toggle("locked", on);
}

function gachaToNote(scope) {
  const c = G.cur;
  if (!c.genre) return;
  const full = scope !== "mini";
  newNote({
    title: "",
    f: { concept: `${c.genre} × ${c.mechanic}`, ...(full ? { core: c.feeling || "", scope: c.constraint || "" } : {}),
         memo: [`舞台・題材：${c.theme || ""}`, full && c.prompt ? `問い：${c.prompt}` : ""].filter(Boolean).join("\n") },
    src: `ガチャ：${[c.genre, c.mechanic, c.theme].join(" × ")}`,
  });
}

/* ======================================================= ブレスト */
const C_T = 2 * Math.PI * 96;
const T = { dur: store.get("bsDur", 300), left: null, run: false, end: 0, iv: 0, subj: store.get("bsSubj", ""), ideas: store.get("bsIdeas", []) };
const saveT = () => { store.set("bsDur", T.dur); store.set("bsSubj", T.subj); store.set("bsIdeas", T.ideas.slice(0, 100)); };
const fmt = s => { s = Math.max(0, Math.ceil(s)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

function timerTab() {
  if (S.params.s) { T.subj = S.params.s.slice(0, 80); saveT(); }
  if (!T.subj) T.subj = todayTheme()?.title || "";
  const L = T.left ?? T.dur;
  return `<div class="timer-page">
    <label class="bs-subj rv" style="--i:2">${ic("ti-target")}<input type="text" id="bs-subj" value="${esc(T.subj)}" maxlength="80" placeholder="なにについて考える？"></label>
    <div class="bs-grid">
      <section class="bs-clock rv" style="--i:3">
        <div class="ring-wrap ${T.run ? "run" : ""}" id="t-ring">
          <svg viewBox="0 0 220 220"><circle class="tk" cx="110" cy="110" r="104"/><circle class="bg" cx="110" cy="110" r="96"/><circle class="fg" id="t-fg" cx="110" cy="110" r="96" style="stroke-dasharray:${C_T.toFixed(1)};stroke-dashoffset:${(C_T * (1 - L / T.dur)).toFixed(1)}"/></svg>
          <div class="t-mid"><b id="t-left">${fmt(L)}</b><small><span id="t-n">${T.ideas.length}</span> アイデア</small></div>
        </div>
        <div class="seg t-durs">${[3, 5, 10].map(m => `<button class="${T.dur === m * 60 ? "on" : ""}" data-la="t-dur" data-s="${m * 60}">${ic("ti-clock")}${m}分</button>`).join("")}</div>
        <div class="t-ctl">
          <button class="ib" data-la="t-reset" data-tip="リセット">${ic("ti-rotate")}</button>
          <button class="play" data-la="t-play" id="t-play" data-s="${T.run ? "pause" : "play"}" aria-label="スタート／一時停止">${ic(T.run ? "ti-player-pause-filled" : "ti-player-play-filled")}</button>
          <button class="ib" data-la="t-hint" data-tip="ヒントを出す">${ic("ti-bulb")}</button>
        </div>
        <p class="t-hint" id="t-hint" hidden></p>
      </section>
      <section class="bs-ideas rv" style="--i:4">
        <form class="bs-add" id="bs-add"><input type="text" id="bs-in" maxlength="120" autocomplete="off" placeholder="思いついたら書いて Enter"><button class="ib" data-tip="追加">${ic("ti-plus")}</button></form>
        <ul class="bs-list" id="bs-list">${ideasHTML()}</ul>
        <div class="bs-foot"><button class="btn plain" data-la="t-note" ${T.ideas.length ? "" : "disabled"}>${ic("ti-pencil-plus")}ノートに保存</button>
          <button class="ib ghost" data-la="t-clear" data-tip="ぜんぶ消す">${ic("ti-trash")}</button></div>
      </section>
    </div>
  </div>`;
}
const ideasHTML = () => T.ideas.map((w, i) => `<li><span>${esc(w)}</span><button class="ib sm ghost" data-la="t-rm" data-i="${i}" data-tip="消す">${ic("ti-x")}</button></li>`).join("")
  || `<li class="none">${ic("ti-bulb")}<span>質より量。思いついたことを全部書きましょう</span></li>`;

function paintIdeas(fresh = false) {
  const ul = $("#bs-list");
  if (ul) { ul.innerHTML = ideasHTML(); if (fresh) ul.firstElementChild?.classList.add("new"); }
  const n = $("#t-n"); if (n) n.textContent = T.ideas.length;
  const b = $('[data-la="t-note"]'); if (b) b.disabled = !T.ideas.length;
}

function tStart() {
  if (T.left == null || T.left <= 0) T.left = T.dur;
  T.end = Date.now() + T.left * 1000; T.run = true;
  clearInterval(T.iv); T.iv = setInterval(tTick, 250);
  tPaint();
  $("#bs-in")?.focus();
}
function tPause() {
  if (!T.run) return;
  T.left = Math.max(0, (T.end - Date.now()) / 1000); T.run = false;
  clearInterval(T.iv); tPaint();
}
function tReset() { T.run = false; clearInterval(T.iv); T.left = null; tPaint(); }
function tTick() {
  if (!T.run) return;
  T.left = (T.end - Date.now()) / 1000;
  if (T.left <= 0) { T.left = 0; T.run = false; clearInterval(T.iv); tPaint(); tDone(); return; }
  tPaint();
}
function tPaint() {
  const L = T.left ?? T.dur;
  const el = $("#t-left"); if (el) el.textContent = fmt(L);
  const fg = $("#t-fg"); if (fg) fg.style.strokeDashoffset = (C_T * (1 - L / T.dur)).toFixed(1);
  const ring = $("#t-ring");
  if (ring) { ring.classList.toggle("run", T.run); ring.classList.toggle("hurry", T.run && L <= 10); }
  const pl = $("#t-play"), want = T.run ? "pause" : "play";
  if (pl && pl.dataset.s !== want) { pl.dataset.s = want; pl.innerHTML = ic(T.run ? "ti-player-pause-filled" : "ti-player-play-filled"); }
}
function tDone() {
  toast("ti-alarm", `時間です！ アイデア ${T.ideas.length} 個`);
  navigator.vibrate?.([120, 60, 120]);
  const ring = $("#t-ring");
  if (ring) {
    const r = ring.getBoundingClientRect();
    celebrate(r.left + r.width / 2, r.top + r.height / 2, 40);
    ring.classList.remove("done"); void ring.offsetWidth; ring.classList.add("done");
  }
}
function setDur(s) {
  T.dur = s; T.left = null; T.run = false; clearInterval(T.iv); saveT();
  $$('[data-la="t-dur"]').forEach(b => b.classList.toggle("on", Number(b.dataset.s) === s));
  tPaint();
}
function tHint() {
  const el = $("#t-hint"), w = words("prompt");
  if (!el || !w.length) return;
  el.hidden = false;
  el.textContent = pickOther(w, el.textContent);
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
}
function ideasToNote() {
  if (!T.ideas.length) return;
  newNote({ title: T.subj || "ブレストのメモ", f: { memo: [...T.ideas].reverse().map(w => "・" + w).join("\n") }, src: `ブレスト（${md(todayStr())}）` });
}

/* ============================================================ ノート */
const FIELDS = [
  ["concept", "コンセプト", "ひとことで言うと？", "ti-bulb", true],
  ["target", "だれが遊ぶ？", "ターゲット・遊ぶ場面", "ti-users"],
  ["core", "コア体験", "プレイヤーに感じてほしいこと", "ti-heart"],
  ["loop", "遊びの流れ", "くり返す行動（コアループ）", "ti-refresh"],
  ["unique", "ここが新しい", "ほかのゲームとの違い", "ti-sparkles"],
  ["scope", "規模・しばり", "期間・人数・プラットフォーム", "ti-ruler-2", true],
  ["memo", "メモ", "アイデア・参考・やること", "ti-notes", true],
];

function newNote({ title = "", f = {}, src = "" } = {}) {
  const n = { id: "n" + Date.now().toString(36), title: String(title).slice(0, 60), f, src, created: Date.now(), updated: Date.now() };
  P.notes = [n, ...P.notes].slice(0, 60);
  P.save();
  go(`#/plan?t=notes&id=${n.id}`);
  toast("ti-pencil-plus", "ノートを作りました");
}

function notesBox(i) {
  return `<div class="box rv" style="--i:${i}"><div class="box-h"><span class="hi p">${ic("ti-notes")}</span>企画ノート<a class="ib sm ghost more" href="#/plan?t=notes" data-tip="すべて">${ic("ti-arrow-right")}</a></div>
    ${P.notes.slice(0, 4).map(n => `<a class="mini" href="#/plan?t=notes&id=${esc(n.id)}">${ic("ti-file-text")}<span class="t">${esc(n.title || "無題")}</span></a>`).join("") || `<p class="muted-s">まだありません</p>`}
    <button class="btn plain wide" data-la="n-new">${ic("ti-plus")}新しいノート</button></div>`;
}

function notesTab() {
  const id = S.params.id, cur = P.notes.find(n => n.id === id);
  const d = t => { const x = new Date(t || Date.now()); return `${x.getMonth() + 1}/${x.getDate()}`; };
  return `<div class="notes ${cur ? "has" : ""}">
    <div class="n-list rv" style="--i:2">
      <button class="btn" data-la="n-new">${ic("ti-plus")}新しいノート</button>
      ${P.notes.map(n => `<a class="n-item ${n.id === id ? "on" : ""}" href="#/plan?t=notes&id=${esc(n.id)}"><b>${esc(n.title || "無題")}</b><span class="d">${d(n.updated)}</span><small>${esc((n.f?.concept || n.src || "").slice(0, 50))}</small></a>`).join("")
        || `<p class="muted-s" style="text-align:center;padding:16px 0">まだありません</p>`}
    </div>
    <div class="n-edit rv" style="--i:3">${cur ? editorHTML(cur)
      : `<div class="n-empty">${ic("ti-file-text")}<b>1枚企画書のテンプレート</b><p>お題・ガチャ・ブレストの結果からも作れます</p><button class="btn" data-la="n-new">${ic("ti-plus")}新しいノート</button></div>`}</div>
  </div>`;
}

function editorHTML(n) {
  return `<div class="ne-top">
      <input type="text" class="ne-title" data-nf="title" value="${esc(n.title || "")}" placeholder="タイトル" maxlength="60">
      <button class="ib" data-la="n-md" data-tip="Markdown でコピー">${ic("ti-markdown")}</button>
      <button class="ib" data-la="n-del" data-tip="削除">${ic("ti-trash")}</button>
    </div>
    ${n.src ? `<p class="ne-src">${ic("ti-link")}${esc(n.src)}</p>` : ""}
    <div class="ne-fields">${FIELDS.map(([k, label, ph, icon, wide]) => `<label class="nf ${wide ? "wide" : ""}"><span>${ic(icon)}${label}</span>
      <textarea data-nf="${k}" placeholder="${esc(ph)}" rows="${k === "memo" ? 6 : 3}" maxlength="2000">${esc(n.f?.[k] || "")}</textarea></label>`).join("")}</div>
    <p class="ne-saved" id="ne-saved">${ic("ti-cloud-check")}自動で保存されます</p>`;
}

function noteMd() {
  const n = P.notes.find(x => x.id === S.params.id);
  if (!n) return;
  const lines = [`# ${n.title || "無題"}`, ""];
  FIELDS.forEach(([k, label]) => { const v = (n.f?.[k] || "").trim(); if (v) lines.push(`## ${label}`, v, ""); });
  copyText(lines.join("\n").trim() + "\n", "Markdown をコピーしました");
}

function delNote(btn) {
  confirmTwice(btn, "もう一度押すと削除", () => {
    P.notes = P.notes.filter(n => n.id !== S.params.id);
    P.save();
    toast("ti-trash", "削除しました");
    go("#/plan?t=notes");
  });
}

/* ======================================================= 今日のページ用 */
export function todayLearnSide(i = 1) {
  const th = todayTheme(), pb = bank("programmer").length, lb = bank("planner").length, all = kwAll();
  if (!th && !pb && !lb && !all.length) return "";
  const ring = track => {
    const R = TRACK[track], n = Math.min(todayCount(track), R.daily), p = n / R.daily;
    return `<a class="lb-ring" href="#/${R.route}?t=drill" style="--cat:${R.color}" data-tip="${R.name}：今日のドリル"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="bg"/><circle cx="22" cy="22" r="18" class="fg" style="stroke-dashoffset:${C_SM}" data-off="${(C_SM * (1 - p)).toFixed(1)}"/></svg>${ic(R.icon)}<b>${n}/${R.daily}</b></a>`;
  };
  const known = all.filter(k => P.kwKnown.has(k.key)).length;
  return `<div class="box learn-box rv" style="--i:${i}"><div class="box-h"><span class="hi">${ic("ti-school")}</span>今日の学び</div>
    ${th ? `<a class="lb-theme" href="#/plan?t=theme"><small>${ic("ti-flag-3")}${th.date === todayStr() ? "今日のお題" : "お題"}</small><b>${esc(th.title)}</b></a>` : ""}
    <div class="lb-rings">${pb ? ring("programmer") : ""}${lb ? ring("planner") : ""}${all.length ? `<a class="lb-ring kw" href="#/prog?t=kw" data-tip="覚えたキーワード">${ic("ti-key")}<b>${known}/${all.length}</b></a>` : ""}</div>
  </div>`;
}

// ページを描いたあとに呼ばれる
export function afterLearn() {
  animateIn($("#view"), false);
  if (S.route === "prog" && S.params.t === "kw" && S.params.k) {
    const el = document.getElementById("k" + hash(S.params.k));
    if (el) setTimeout(() => { el.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" }); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }, 350);
  }
  if (S.route === "plan" && S.params.t === "timer") tPaint();
  if (S.route === "plan" && S.params.t === "theme" && S.params.d) setTimeout(() => document.getElementById("th-" + S.params.d)?.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" }), 300);
}

/* ============================================================ イベント */
const ACT = {
  kw: (t, e) => openKw(t.dataset.key, t, { x: e.clientX, y: e.clientY }),
  known: t => toggleKnown(t.dataset.key, t),
  "kw-f": t => { setQS("prog", { f: t.dataset.v, k: "" }); $$('[data-la="kw-f"]').forEach(b => b.classList.toggle("on", b.dataset.v === t.dataset.v)); paintKwList(); },
  "copy-code": t => copyText(t.closest(".code")?.querySelector("pre")?.textContent || "", "コードをコピーしました"),
  start: t => { const tr = t.dataset.track; startDrill(tr, { mode: t.dataset.mode, n: t.dataset.mode === "daily" ? TRACK[tr].daily : 10 }); },
  "su-topic": t => suToggle("topic", t.dataset.v),
  "su-lv": t => suToggle("lv", t.dataset.v),
  "su-n": t => suToggle("n", t.dataset.v),
  "su-start": () => SET && startDrill(SET.track, { mode: "topic", topics: [...SET.topics], lv: SET.lv, n: SET.n }),
  pick: t => pickChoice(Number(t.dataset.k)),
  next: () => nextQ(),
  quit: () => { const tr = DR?.track; DR = null; if (tr) go(`#/${TRACK[tr].route}?t=drill`); },
  retry: () => DR && startDrill(DR.track, DR.cfg, DR.qs.filter((_, k) => DR.res[k] === false).map(x => x.q)),
  again: () => DR && startDrill(DR.track, DR.cfg),
  report: () => openReport(),
  "m-close": () => closeModal(),
  "m-reason": t => $$(".reasons .chip").forEach(c => c.classList.toggle("on", c === t)),
  "m-send": t => sendReport(t),
  spin: t => spin(t.dataset.scope || "full", t),
  lock: t => toggleLock(t.dataset.pool, t),
  "g-copy": () => G.cur.genre && copyText(comboText(), "組み合わせをコピーしました"),
  "g-note": t => gachaToNote(t.dataset.scope),
  "g-timer": () => G.cur.genre && go(`#/plan?t=timer&s=${encodeURIComponent(`${G.cur.genre} × ${G.cur.mechanic} × ${G.cur.theme}`)}`),
  "g-hist": t => { const h = G.hist[Number(t.dataset.i)]; if (h) { G.cur = { ...G.cur, ...h }; saveG(); S.api.redraw?.(); } },
  "t-dur": t => setDur(Number(t.dataset.s)),
  "t-play": () => (T.run ? tPause() : tStart()),
  "t-reset": () => tReset(),
  "t-hint": () => tHint(),
  "t-rm": t => { T.ideas.splice(Number(t.dataset.i), 1); saveT(); paintIdeas(); },
  "t-note": () => ideasToNote(),
  "t-clear": t => T.ideas.length && confirmTwice(t, "もう一度押すと全部消す", () => { T.ideas = []; saveT(); paintIdeas(); }),
  "th-timer": t => go(`#/plan?t=timer&s=${encodeURIComponent(t.dataset.title || todayTheme()?.title || "")}`),
  "th-note": t => themeToNote(t.dataset.date),
  "n-new": () => newNote({}),
  "n-del": t => delNote(t),
  "n-md": () => noteMd(),
};

document.addEventListener("click", e => {
  const t = e.target.closest("[data-la]");
  if (!t || t.disabled) return;
  const fn = ACT[t.dataset.la];
  if (!fn) return;
  e.preventDefault();
  fn(t, e);
});

let kwDeb, noteDeb;
document.addEventListener("input", e => {
  const el = e.target;
  if (el.id === "kwq") { clearTimeout(kwDeb); kwDeb = setTimeout(() => { setQS("prog", { q: el.value, k: "" }); paintKwList(); }, 140); return; }
  if (el.id === "bs-subj") { T.subj = el.value.slice(0, 80); saveT(); return; }
  const k = el.dataset?.nf;
  if (!k) return;
  const n = P.notes.find(x => x.id === S.params.id);
  if (!n) return;
  if (k === "title") { n.title = el.value.slice(0, 60); const b = $(".n-item.on b"); if (b) b.textContent = n.title || "無題"; }
  else n.f = { ...(n.f || {}), [k]: el.value.slice(0, 2000) };
  if (k === "concept") { const s = $(".n-item.on small"); if (s) s.textContent = (n.f.concept || n.src || "").slice(0, 50); }
  n.updated = Date.now();
  const s = $("#ne-saved");
  s?.classList.remove("ok"); s?.classList.add("saving");
  clearTimeout(noteDeb);
  noteDeb = setTimeout(() => {
    P.save();
    const s2 = $("#ne-saved");
    if (s2) { s2.classList.remove("saving"); s2.classList.add("ok"); s2.innerHTML = `${ic("ti-cloud-check")}保存しました`; }
  }, 500);
});

document.addEventListener("submit", e => {
  if (e.target.id !== "bs-add") return;
  e.preventDefault();
  const inp = $("#bs-in"), v = inp?.value.trim();
  if (!v) return;
  T.ideas.unshift(v.slice(0, 120)); T.ideas = T.ideas.slice(0, 100); saveT();
  inp.value = "";
  paintIdeas(true);
  if (T.ideas.length % 10 === 0) { const r = inp.getBoundingClientRect(); celebrate(r.left + r.width / 2, r.top, 18); toast("ti-bulb", `${T.ideas.length} 個！ その調子`); }
});

document.addEventListener("keydown", e => {
  if ($("#modal")) { if (e.key === "Escape") { e.stopImmediatePropagation(); closeModal(); } return; }
  if (!S.ready || !$("#pal")?.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const onBtn = e.target.closest?.("button:not(:disabled),a,summary");
  if (DR && !DR.done && S.params.run === DR.run && S.route === TRACK[DR.track].route) {
    const k = /^[1-4]$/.test(e.key) ? +e.key - 1 : /^[a-dA-D]$/.test(e.key) ? "abcd".indexOf(e.key.toLowerCase()) : -1;
    if (DR.picked == null && k >= 0) { e.preventDefault(); pickChoice(k); return; }
    if (DR.picked != null && (e.key === "ArrowRight" || (!onBtn && (e.key === "Enter" || e.key === " ")))) { e.preventDefault(); nextQ(); return; }
  }
  if (S.route === "plan" && e.key === " " && !onBtn) {
    if (S.params.t === "gacha") { e.preventDefault(); spin("full", $('[data-la="spin"][data-scope="full"]')); }
    else if (S.params.t === "timer") { e.preventDefault(); if (T.run) tPause(); else tStart(); }
  }
});
