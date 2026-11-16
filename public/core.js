// =========================================================================
// HIKARI NEWS — 共通（状態・保存・ヘルパー・部品）
// =========================================================================

import { logoSVG } from "./logo.js";

export const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
// 特効（アニメーション）のオン・オフ。右上のボタンで切り替え、端末に保存する。
// 何も選んでいなければ、OS の「動きを減らす」設定に合わせる。
// REDUCED は let で export しているので、切り替えると読み込んでいる全モジュールの値がその場で変わる
export const SYS_REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FX_PREF = (() => { try { return localStorage.getItem("fx"); } catch { return null; } })();
export let REDUCED = FX_PREF ? FX_PREF === "off" : SYS_REDUCED;
export function setFx(on) {
  REDUCED = !on;
  document.documentElement.dataset.fx = on ? "on" : "off";
  try { localStorage.setItem("fx", on ? "on" : "off"); } catch {}
}
export const COARSE = matchMedia("(pointer: coarse)").matches;

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const safeUrl = u => /^https?:\/\//.test(u || "") ? u : "#";
export const todayStr = () => new Date().toLocaleDateString("sv-SE");
export const daysUntil = d => Math.round((new Date(d + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 864e5);
export const norm = s => String(s || "").normalize("NFKC").toLowerCase()
  .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
export const ic = (name, extra = "") => `<i class="ti ${name}" ${extra}></i>`;
export const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
export const pick = a => a[Math.floor(Math.random() * a.length)];
export const hash = s => { let h = 0x811c9dc5; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };

/* ------------------------------------------------------------- 定数 */
export const DEFAULT_CATS = [
  { id: "ai", name: "AIトレンド", color: "7B8CFF" },
  { id: "industry", name: "ゲーム業界", color: "FF6B6B" },
  { id: "tech", name: "技術・学習", color: "5EE6A0" },
  { id: "ai_howto", name: "AI活用", color: "F2F56A" },
  { id: "classic", name: "定番の一本", color: "C59BFF" },
  { id: "community", name: "SNS・コミュニティ", color: "FF8FC8" },
  { id: "chance", name: "チャンス情報", color: "FFB874" },
  { id: "programmer", name: "プログラマー", color: "43D6FF", section: "programmer" },
  { id: "planner", name: "プランナー", color: "FFB874", section: "planner" },
];
export const CAT_ICON = { ai: "ti-robot", industry: "ti-device-gamepad-2", tech: "ti-code", ai_howto: "ti-wand",
  classic: "ti-pin", community: "ti-messages", chance: "ti-trophy", programmer: "ti-terminal-2", planner: "ti-notebook" };
export const SLOT_LABEL = { "10": "10:00", "17": "17:00", "22": "22:00", learn: "朝" };
export const WEEK = "日月火水木金土";

export const AREAS = {
  cpp: { name: "C++", icon: "ti-brand-cpp", color: "#7B8CFF" },
  dx12: { name: "DX12・エンジン", icon: "ti-cpu", color: "#43D6FF" },
  shader: { name: "シェーダー・HLSL", icon: "ti-sparkles", color: "#C59BFF" },
};
export const KW_LV = {
  "基礎": { n: 1, color: "#5EE6A0" },
  "発展": { n: 2, color: "#F2F56A" },
  "応用": { n: 3, color: "#FF6B6B" },
};
export const TOPICS = {
  programmer: [
    { id: "cpp", name: "C++", icon: "ti-brand-cpp" }, { id: "dx12", name: "DX12", icon: "ti-cpu" },
    { id: "hlsl", name: "HLSL・シェーダー", icon: "ti-sparkles" }, { id: "engine", name: "エンジン設計", icon: "ti-engine" },
    { id: "math", name: "数学", icon: "ti-math-function" }, { id: "opt", name: "最適化", icon: "ti-gauge" },
  ],
  planner: [
    { id: "design", name: "ゲームデザイン", icon: "ti-puzzle" }, { id: "level", name: "レベルデザイン", icon: "ti-map-2" },
    { id: "ux", name: "UX・UI", icon: "ti-hand-click" }, { id: "narrative", name: "シナリオ", icon: "ti-book-2" },
    { id: "biz", name: "ビジネス・運営", icon: "ti-chart-line" },
  ],
};
export const RANKS = [
  { xp: 0, name: "見習い" }, { xp: 100, name: "駆け出し" }, { xp: 300, name: "一人前" },
  { xp: 700, name: "熟練" }, { xp: 1500, name: "達人" }, { xp: 3000, name: "伝説" },
];
export const rankOf = xp => { let i = 0; RANKS.forEach((r, k) => { if (xp >= r.xp) i = k; }); return i; };

/* ------------------------------------------------------------- 保存 */
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// 個人の記録（ブラウザに保存。ログイン中は Firebase にも同期）
export const P = {
  bookmarks: new Set(store.get("bookmarks", [])),
  read: new Map(Object.entries(store.get("readAt", {}))),
  chance: store.get("chance", {}),
  myKw: store.get("myKw", []),
  open: new Set(store.get("openBatches", [])),
  qp: store.get("qp", {}),               // 問題ごとの記録 {id: {b: 箱, d: 次の復習, n: 回答数, c: 正解数, t: 最終}}
  xp: store.get("xp", 0),
  kwKnown: new Set(store.get("kwKnown", [])),
  notes: store.get("notes", []),         // 企画ノート
  daily: store.get("dailyLog", {}),      // 日付 → 解いた問題数
  onSave: null,
  save() {
    store.set("bookmarks", [...this.bookmarks]); store.set("readAt", Object.fromEntries(this.read));
    store.set("chance", this.chance); store.set("myKw", this.myKw); store.set("openBatches", [...this.open].slice(-30));
    store.set("qp", this.qp); store.set("xp", this.xp); store.set("kwKnown", [...this.kwKnown]);
    store.set("notes", this.notes); store.set("dailyLog", this.daily);
    this.onSave?.();
  },
  snapshot() {
    return { bookmarks: [...this.bookmarks], readAt: Object.fromEntries(this.read), chance: this.chance, myKw: this.myKw,
             qp: this.qp, xp: this.xp, kwKnown: [...this.kwKnown], notes: this.notes, dailyLog: this.daily, at: Date.now() };
  },
  merge(r) {   // 別の端末の記録と合流（多い方・新しい方を残す）
    if (!r) return;
    (r.bookmarks || []).forEach(b => this.bookmarks.add(b));
    Object.entries(r.readAt || {}).forEach(([k, v]) => { if (!this.read.has(k) || this.read.get(k) < v) this.read.set(k, v); });
    this.chance = { ...(r.chance || {}), ...this.chance };
    this.myKw = [...new Set([...(r.myKw || []), ...this.myKw])];
    Object.entries(r.qp || {}).forEach(([k, v]) => { if (!this.qp[k] || (this.qp[k].t || 0) < (v.t || 0)) this.qp[k] = v; });
    this.xp = Math.max(this.xp, r.xp || 0);
    (r.kwKnown || []).forEach(k => this.kwKnown.add(k));
    const notes = new Map(this.notes.map(n => [n.id, n]));
    (r.notes || []).forEach(n => { const m = notes.get(n.id); if (!m || (m.updated || 0) < (n.updated || 0)) notes.set(n.id, n); });
    this.notes = [...notes.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    Object.entries(r.dailyLog || {}).forEach(([k, v]) => { this.daily[k] = Math.max(this.daily[k] || 0, v); });
  },
};

/* ------------------------------------------------------------- 状態 */
export const S = {
  items: [], cats: DEFAULT_CATS, keywords: [], updated: null, isAdmin: false, ready: false,
  loadMore: null, adminApi: null, api: {}, route: null, params: {},
  learn: { kw: {}, quiz: {}, ideas: {}, daily: null, themes: [] },
  specials: [],
};

export function setData(items, meta = {}) {
  S.items = items.map(it => ({ ...it, slot: String(it.slot || "") }));
  if (meta.categories?.length) {
    S.cats = meta.categories.map(c => {
      const d = DEFAULT_CATS.find(x => x.id === c.id) || {};
      return { ...d, ...c, color: d.color || c.color || "F2F56A", section: c.section || d.section };
    });
    DEFAULT_CATS.forEach(d => { if (!S.cats.find(c => c.id === d.id)) S.cats.push(d); });
  }
  S.keywords = meta.keywords || []; S.updated = meta.updated || null;
}

export function setLearn(docs) {
  const L = { kw: {}, quiz: {}, ideas: {}, daily: null, themes: [] };
  Object.entries(docs || {}).forEach(([id, d]) => {
    if (id.startsWith("kw_")) L.kw[id.slice(3)] = d.items || [];
    else if (id.startsWith("quiz_")) L.quiz[id.slice(5)] = d.items || [];
    else if (id === "ideas") { const { updated, ...pools } = d; L.ideas = pools; }
    else if (id === "daily") L.daily = d;
    else if (id === "themes") L.themes = d.items || [];
  });
  S.learn = L;
}

/* ------------------------------------------------------------- 分類 */
export const catOf = id => S.cats.find(c => c.id === id) || DEFAULT_CATS.find(c => c.id === id) || { id, name: id, color: "F2F56A" };
export const catColor = id => "#" + (catOf(id).color || "F2F56A");
export const isSection = it => !!(it.section || catOf(it.category).section);
export const catIc = (id, tip = true) => `<span class="cat-ic" style="--cat:${catColor(id)}" ${tip ? `data-tip="${esc(catOf(id).name)}"` : ""}>${ic(CAT_ICON[id] || "ti-point")}</span>`;
export const byId = id => S.items.find(it => it.id === id);
export const itemText = it => norm([it.title, it.summary, it.note, it.source, it.category_name, ...(it.tags || []),
  ...(it.points || []), it.detail || "", ...(it.terms || []).map(t => t.term)].join(" "));
export const kwOf = it => { const t = itemText(it); return [...new Set([...S.keywords, ...P.myKw])].filter(k => t.includes(norm(k))); };
export const sortNew = (a, b) => b.date.localeCompare(a.date) || String(b.slot).localeCompare(String(a.slot)) || b.importance - a.importance;

/* ------------------------------------------------------------- 部品 */
export const stars = n => `<span class="stars" data-tip="おすすめ度 ${n}/5">${[1, 2, 3, 4, 5].map(i =>
  i <= n ? `<i class="ti ti-star-filled" style="--k:${i}"></i>` : `<i class="ti ti-star off"></i>`).join("")}</span>`;
const LV = { "入門": 1, "中級": 2, "上級": 3 };
export const level = l => l ? `<span class="lv" data-tip="難易度：${esc(l)}">${[1, 2, 3].map(i => `<i class="${i <= LV[l] ? "on" : ""}"></i>`).join("")}</span>` : "";
export const kwLevel = l => `<span class="kwlv" style="--lc:${KW_LV[l]?.color || "#999"}">${[1, 2, 3].map(i => `<i class="${i <= (KW_LV[l]?.n || 0) ? "on" : ""}"></i>`).join("")}${esc(l)}</span>`;

export function dlBadge(it) {
  if (!it.deadline) return "";
  const d = daysUntil(it.deadline);
  const cls = d < 0 ? "past" : d <= 3 ? "hot" : d <= 7 ? "warm" : "";
  const txt = d < 0 ? "終了" : d === 0 ? "今日" : `${d}日`;
  return `<span class="dl ${cls}" data-tip="締め切り ${esc(it.deadline.replace(/-/g, "/"))}">${ic("ti-hourglass")}${txt}</span>`;
}

export function hl(text, terms) {
  let s = esc(text);
  for (const t of terms) {
    if (!t) continue;
    s = s.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m => `<mark>${m}</mark>`);
  }
  return s;
}

export function metaLine(it) {
  const kws = kwOf(it);
  return [
    stars(it.importance), level(it.level),
    it.read_minutes ? `<span data-tip="読む時間の目安">${ic("ti-clock")} ${it.read_minutes}分</span>` : "",
    it.lang === "en" ? `<span data-tip="原文は英語">${ic("ti-language")} EN</span>` : "",
    `<span>${esc(it.source)}</span>`,
    it.detail ? `<span class="has-doc" data-tip="くわしい解説つき">${ic("ti-file-description")}</span>` : "",
    kws.length ? `<span class="kw" data-tip="キーワード：${esc(kws.join("・"))}">${ic("ti-bell-ringing")}</span>` : "",
  ].join("");
}

// 解説稿：空行で段落に分け、段落の先頭の【見出し】は小見出しにする
export function paraHTML(text, d0 = 0) {
  return String(text || "").split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).map((p, i) => {
    const m = p.match(/^【([^】]{1,24})】\s*/);
    const body = esc(m ? p.slice(m[0].length) : p).replace(/\n/g, "<br>");
    return `<div class="para-b dz" style="--d:${d0 + i}">${m ? `<h4 class="para-h">${esc(m[1])}</h4>` : ""}${body ? `<p class="para">${body}</p>` : ""}</div>`;
  }).join("");
}

export const bmBtn = (id, cls = "ib sm ghost") => `<button class="${cls} bm ${P.bookmarks.has(id) ? "on" : ""}" data-bm="${esc(id)}" data-tip="${P.bookmarks.has(id) ? "保存済み" : "あとで読む"}">${ic(P.bookmarks.has(id) ? "ti-bookmark-filled" : "ti-bookmark")}</button>`;

export function rowHTML(it, i = 0, terms = [], extra = "") {
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

export function heroHTML(it, rib = "PICK", i = 0) {
  return `<section class="hero rv" style="--i:${i};--cat:${catColor(it.category)}" data-open="${esc(it.id)}">
    <span class="glow"></span>
    <span class="deco">${logoSVG({ full: false })}</span>
    <span class="rib">${ic("ti-star-filled")} ${esc(rib)}</span>
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

export const emptyHTML = (title, body = "") => `<div class="empty rv in">${logoSVG({ full: false })}<b>${esc(title)}</b>${esc(body)}</div>`;
export const pageHead = (icon, title, right = "") => `<div class="ph rv" style="--i:0"><span class="pi">${ic(icon)}</span><h1>${title}</h1>${right}</div>`;

export async function copyText(text, msg = "コピーしました") {
  try { await navigator.clipboard.writeText(text); toast("ti-copy", msg); }
  catch { toast("ti-alert-triangle", "コピーできませんでした"); }
}

/* ------------------------------------------------------------- 演出の小物 */
export function toast(icon, msg) {
  $$(".toast").forEach(t => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.innerHTML = `${ic(icon)}${esc(msg)}`;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2300);
}

export function burst(el, n = 8) {
  if (REDUCED || !el) return;
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("i");
    s.className = "ti ti-star-filled burst";
    s.style.left = cx - 7 + "px"; s.style.top = cy - 7 + "px";
    if (i % 2) s.style.color = "var(--peach)";
    document.body.appendChild(s);
    const a = (i / n) * Math.PI * 2 + Math.random() * .4, dist = 28 + Math.random() * 22;
    s.animate([{ transform: "translate(0,0) scale(.4) rotate(0)", opacity: 1 },
               { transform: `translate(${Math.cos(a) * dist}px,${Math.sin(a) * dist}px) scale(1) rotate(${(Math.random() - .5) * 180}deg)`, opacity: 0 }],
              { duration: 600, easing: "cubic-bezier(.16,1,.3,1)" }).finished.then(() => s.remove(), () => {});
    setTimeout(() => s.remove(), 900);
  }
  el.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.35) rotate(-12deg)" }, { transform: "scale(1)" }], { duration: 420, easing: "cubic-bezier(.34,1.56,.64,1)" });
}

export function countUp(el, to) {
  if (REDUCED || !to) { el.textContent = to; return; }
  const t0 = performance.now(), dur = 700;
  const step = t => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  setTimeout(() => { el.textContent = to; }, dur + 400);
}
