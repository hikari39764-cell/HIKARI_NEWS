// =========================================================================
// HIKARI NEWS — 演出
//  ・星屑の背景（マウスで押しのけられる・星座線・クリックで波紋・流れ星）
//  ・詳細パネルの出入り
//  ・正解・ランクアップのお祝い
// どれも「動きを減らす」設定ではオフになる
// =========================================================================

import { REDUCED, COARSE, $ } from "./core.js";

/* =============================================================== 星屑 */
export function initStarfield() {
  if (REDUCED) return;
  const cv = document.createElement("canvas");
  cv.id = "starfield"; cv.setAttribute("aria-hidden", "true");
  document.body.prepend(cv);
  const ctx = cv.getContext("2d");
  const scrimEl = document.getElementById("scrim");
  let W = 0, H = 0, dpr = 1, stars = [], ripples = [], shoot = null, nextShoot = performance.now() + 4000, last = performance.now();
  const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, on: false };
  const PAL = {
    dark: [[242, 245, 106], [255, 184, 116], [236, 235, 230]],
    light: [[160, 130, 0], [205, 110, 40], [70, 72, 86]],
  };

  const mk = () => {
    const d = .3 + Math.random() * .7;
    return { hx: Math.random() * W, hy: Math.random() * H, ox: 0, oy: 0, vx: (Math.random() - .5) * .07, vy: (Math.random() - .5) * .05,
             r: .5 + d * 1.5, d, ph: Math.random() * 6.28, c: Math.random() < .5 ? 0 : Math.random() < .6 ? 1 : 2, px: 0, py: 0 };
  };
  function resize() {
    dpr = 1; W = innerWidth; H = innerHeight;   // 小さな点なので等倍で十分（高解像度画面での負荷を抑える）
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(160, Math.max(50, (W * H) / 11000)));
    while (stars.length < n) stars.push(mk());
    stars.length = n;
  }
  resize();
  addEventListener("resize", resize);

  addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse") return;
    mouse.tx = e.clientX; mouse.ty = e.clientY;
    if (!mouse.on) { mouse.x = mouse.tx; mouse.y = mouse.ty; mouse.on = true; }
  }, { passive: true });
  document.addEventListener("pointerleave", () => { mouse.on = false; });
  addEventListener("blur", () => { mouse.on = false; });
  addEventListener("pointerdown", e => {   // 何もない所（余白）をクリックしたときだけ波紋
    const t = e.target;
    if (!(t === document.body || t === document.documentElement || t.matches?.("main,.page,.grid2,.side-col,.gate,.rows,.topics,.tl,.timer-page,.gacha-page,.bs-grid"))) return;
    ripples.push({ x: e.clientX, y: e.clientY, t0: performance.now() });
  }, { passive: true });

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden || scrimEl?.classList.contains("on")) { last = t; return; }   // 詳細パネル表示中は止める（ぼかしの再計算を減らす）
    const dt = Math.min(3, (t - last) / 16.67); last = t;
    const light = document.documentElement.dataset.theme === "light";
    const pal = light ? PAL.light : PAL.dark;
    ctx.clearRect(0, 0, W, H);

    mouse.x += (mouse.tx - mouse.x) * .18 * dt; mouse.y += (mouse.ty - mouse.y) * .18 * dt;
    if (mouse.on && !COARSE) {   // カーソルの光
      const g = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 240);
      g.addColorStop(0, light ? "rgba(255,190,60,.10)" : "rgba(242,245,106,.07)"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(mouse.x - 240, mouse.y - 240, 480, 480);
    }

    const sy = scrollY, R = 150, near = [];
    for (const s of stars) {
      s.hx += s.vx * dt; s.hy += s.vy * dt;
      if (s.hx < -10) s.hx += W + 20; else if (s.hx > W + 10) s.hx -= W + 20;
      if (s.hy < -10) s.hy += H + 20; else if (s.hy > H + 10) s.hy -= H + 20;
      let bx = s.hx, by = ((s.hy - sy * .06 * s.d) % H + H) % H;
      let tx = 0, ty = 0, glow = 0;
      if (mouse.on) {
        const dx = bx - mouse.x, dy = by - mouse.y, dist = Math.hypot(dx, dy) || 1;
        if (dist < R) { const f = (1 - dist / R) ** 2; tx = dx / dist * f * 46 * s.d; ty = dy / dist * f * 46 * s.d; glow = f; }
      }
      for (const rp of ripples) {
        const age = (t - rp.t0) / 900, rad = age * 320, dx = bx - rp.x, dy = by - rp.y, dist = Math.hypot(dx, dy) || 1;
        const band = 1 - Math.min(1, Math.abs(dist - rad) / 40);
        if (band > 0) { tx += dx / dist * band * 26 * (1 - age); ty += dy / dist * band * 26 * (1 - age); glow = Math.max(glow, band * (1 - age)); }
      }
      s.ox += (tx - s.ox) * .09 * dt; s.oy += (ty - s.oy) * .09 * dt;
      s.px = bx + s.ox; s.py = by + s.oy;
      const tw = .45 + .4 * Math.sin(t * .0018 + s.ph);
      const a = Math.min(1, (tw * (light ? .5 : .75)) * s.d + glow * .9);
      const [r, g, b] = pal[s.c];
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      const rr = s.r * (1 + glow * .8);
      if (rr > 1.7) {   // 大きい星は十字のきらめき
        ctx.fillRect(s.px - rr * 2, s.py - .5, rr * 4, 1); ctx.fillRect(s.px - .5, s.py - rr * 2, 1, rr * 4);
      }
      ctx.beginPath(); ctx.arc(s.px, s.py, rr, 0, 6.283); ctx.fill();
      if (glow > .05) near.push(s);
    }
    if (near.length > 1) {   // 星座線
      ctx.lineWidth = 1;
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
        const a = near[i], b = near[j], d = Math.hypot(a.px - b.px, a.py - b.py);
        if (d < 95) {
          ctx.strokeStyle = light ? `rgba(160,120,0,${(1 - d / 95) * .35})` : `rgba(242,245,106,${(1 - d / 95) * .28})`;
          ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
        }
      }
    }
    ripples = ripples.filter(rp => {
      const age = (t - rp.t0) / 900;
      if (age >= 1) return false;
      ctx.strokeStyle = light ? `rgba(200,120,30,${(1 - age) * .35})` : `rgba(255,184,116,${(1 - age) * .35})`;
      ctx.lineWidth = 2 * (1 - age) + .5;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, age * 320, 0, 6.283); ctx.stroke();
      return true;
    });
    if (!shoot && t > nextShoot) {   // 流れ星
      shoot = { x: Math.random() * W * .7 + W * .2, y: Math.random() * H * .3, t0: t, len: 140 + Math.random() * 80 };
    }
    if (shoot) {
      const p = (t - shoot.t0) / 900;
      if (p >= 1) { shoot = null; nextShoot = t + 6000 + Math.random() * 9000; }
      else {
        const x = shoot.x - p * 420, y = shoot.y + p * 220;
        const g = ctx.createLinearGradient(x, y, x + shoot.len, y - shoot.len * .52);
        g.addColorStop(0, light ? "rgba(160,120,0,.7)" : "rgba(255,255,230,.85)"); g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = g; ctx.lineWidth = 1.6 * (1 - p) + .4;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + shoot.len, y - shoot.len * .52); ctx.stroke();
      }
    }
  }
  requestAnimationFrame(frame);
}

/* ============================================================ 詳細パネル */
// 開く：暗幕がフェード → パネルが右から少し斜めに滑り込む → 中身が上から順に浮かぶ。
// 動かすのは transform と opacity だけ（GPU だけで処理でき、カクつき・ちらつきが出にくい）。
// 位置や大きさ・影・ぼかしはアニメーションさせない。

function replay(d) {   // 中身（.dz）を順番に出す
  if (REDUCED) return;
  d.classList.remove("reveal");
  void d.offsetWidth;
  d.classList.add("reveal");
  clearTimeout(d._rv);
  d._rv = setTimeout(() => d.classList.remove("reveal"), 1400);
}

// 詳細パネルを開く（すでに開いていれば中身だけ入れ替える）
export function showDrawer(html, color, fromEl, point) {
  const d = $("#drawer"), scrim = $("#scrim"), plate = $("#plate");
  d.style.setProperty("--cat", color);
  plate?.style.setProperty("--cat", color);
  d.innerHTML = html;
  d.scrollTop = 0;
  d.setAttribute("aria-hidden", "false");
  if (d.classList.contains("on")) { replay(d); return; }
  if (point) { scrim.style.setProperty("--cx", point.x + "px"); scrim.style.setProperty("--cy", point.y + "px"); }
  scrim.classList.add("on");
  const slash = $("#slash");      // 黒い斜めの帯が画面を横切る（P シリーズ風の転換）
  if (slash && !REDUCED) {
    slash.style.setProperty("--cat", color);
    slash.classList.remove("go"); void slash.offsetWidth; slash.classList.add("go");
    clearTimeout(slash._t); slash._t = setTimeout(() => slash.classList.remove("go"), 900);
  }
  plate?.classList.add("on");   // 斜めの色板が先に飛び込み、カードがその上に着地する
  d.classList.add("on");
  replay(d);
}

export function closeDrawer() {
  const d = $("#drawer");
  d.setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("on");
  $("#plate")?.classList.remove("on");
  d.classList.remove("on", "reveal");
}

/* =============================================================== お祝い */
const CONF = ["var(--lemon)", "var(--peach)", "var(--hot)", "#43d6ff", "#5ee6a0"];
export function celebrate(x, y, n = 26) {
  if (REDUCED) return;
  for (let i = 0; i < n; i++) {
    const star = i % 3 === 0;
    const el = document.createElement(star ? "i" : "span");
    el.className = star ? "ti ti-star-filled confetti" : "confetti";
    el.style.left = x + "px"; el.style.top = y + "px";
    el.style.color = el.style.background = star ? "" : CONF[i % CONF.length];
    if (star) el.style.color = CONF[i % 2];
    document.body.appendChild(el);
    const a = -Math.PI / 2 + (Math.random() - .5) * Math.PI * 1.3, v = 120 + Math.random() * 200;
    const dx = Math.cos(a) * v, dy = Math.sin(a) * v;
    el.animate([
      { transform: "translate(0,0) rotate(0) scale(.6)", opacity: 1 },
      { transform: `translate(${dx * .7}px,${dy * .7}px) rotate(${Math.random() * 360}deg) scale(1)`, opacity: 1, offset: .45 },
      { transform: `translate(${dx}px,${dy + 160}px) rotate(${Math.random() * 720}deg) scale(.8)`, opacity: 0 },
    ], { duration: 1000 + Math.random() * 500, easing: "cubic-bezier(.2,.7,.4,1)" }).finished.then(() => el.remove(), () => {});
    setTimeout(() => el.remove(), 1700);
  }
}

export function floatText(x, y, text, cls = "") {
  const el = document.createElement("div");
  el.className = `float-text ${cls}`; el.textContent = text;
  el.style.left = x + "px"; el.style.top = y + "px";
  document.body.appendChild(el);
  if (REDUCED) { setTimeout(() => el.remove(), 900); return; }
  el.animate([{ transform: "translate(-50%,0) scale(.6)", opacity: 0 }, { transform: "translate(-50%,-26px) scale(1.1)", opacity: 1, offset: .3 },
              { transform: "translate(-50%,-70px) scale(1)", opacity: 0 }], { duration: 1100, easing: "cubic-bezier(.16,1,.3,1)" })
    .finished.then(() => el.remove(), () => {});
  setTimeout(() => el.remove(), 1300);
}

export function shake(el) {
  if (REDUCED || !el) return;
  el.animate([{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(7px)" },
              { transform: "translateX(-5px)" }, { transform: "translateX(3px)" }, { transform: "translateX(0)" }], { duration: 420, easing: "ease-out" });
}
