// HIKARI のロゴ（オーナー提供のデザインを SVG で再現）
// ・A 字型のアーチ（ピーチ）＋ 星（レモン）＋ 左右の「HIK」「RI」
// ・太い黒フチのステッカー風。class 名でアニメーションを付けられる

const INK = "#0b0b0b";
export const LEMON = "#f2f56a";
export const PEACH = "#ffb874";

function star(cx, cy, R, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r : R;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

const ARCH = "195,120 485,120 470,648 350,648 358,412 258,412 218,648 98,648";

/**
 * @param {object} o
 * @param {boolean} o.full   true なら左右の HIK / RI 文字も描く
 * @param {string}  o.cls    ルート要素のクラス
 */
export function logoSVG({ full = true, cls = "" } = {}) {
  const vb = full ? "-80 -6 730 680" : "66 -6 508 674";
  const text = full ? `
    <g class="lg-hik"><text transform="translate(58 660) rotate(-79.6)" font-size="112">HIK</text></g>
    <g class="lg-ri"><text transform="translate(506 372) rotate(90)" font-size="112">RI</text></g>` : "";
  return `<svg class="logo-svg ${cls}" viewBox="${vb}" role="img" aria-label="HIKARI">
    <g stroke="${INK}" stroke-width="13" stroke-linejoin="round" stroke-linecap="round">
      <polygon class="lg-arch" points="${ARCH}" fill="${PEACH}" pathLength="100"/>
      <g class="lg-star">
        <polygon points="${star(320, 262, 250, 106)}" fill="${PEACH}"/>
        <polygon points="${star(320, 276, 204, 87)}" fill="${LEMON}" stroke-width="10"/>
      </g>
    </g>
    <g fill="${LEMON}" stroke="${INK}" stroke-width="11" stroke-linejoin="round" paint-order="stroke"
       font-family="Dela Gothic One, sans-serif" letter-spacing="-4">${text}</g>
  </svg>`;
}
