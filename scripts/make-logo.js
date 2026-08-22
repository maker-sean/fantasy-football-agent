/**
 * The mark, with the real brand C.
 *
 * The wordmark in website/logo.svg is outlined to paths and uses only M, H, L
 * and Z — every glyph is a POLYGON. So the C can be filled exactly with an
 * even-odd scanline test rather than approximated with arcs, which means the
 * contact photo carries the actual typeface rather than something that merely
 * resembles it.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512, SS = 4;
const TURF = [0x21, 0xa3, 0x66];
const INK  = [0x06, 0x13, 0x0c];

const C_PATH = 'M33 -124 116 -593 241 -700H582L683 -579L665 -480H529L539 -537L501 -584H301L241 -533L176 -167L218 -116H418L473 -163L484 -220H620L599 -105L476 0H135Z';

/** M/L/H/Z only — the wordmark has no curves, so this is all that is needed. */
function parsePolygon(d) {
  const pts = [];
  let x = 0, y = 0, i = 0;
  const num = () => {
    const m = /^[\s,]*(-?\d*\.?\d+)/.exec(d.slice(i));
    i += m[0].length; return parseFloat(m[1]);
  };
  while (i < d.length) {
    const ch = d[i];
    if (ch === 'M' || ch === 'L') {
      i++;
      // An M with several coordinate pairs is an implicit polyline.
      while (/^[\s,]*-?\d/.test(d.slice(i))) { x = num(); y = num(); pts.push([x, y]); }
    } else if (ch === 'H') { i++; x = num(); pts.push([x, y]); }
    else if (ch === 'V') { i++; y = num(); pts.push([x, y]); }
    else if (ch === 'Z' || ch === 'z') { i++; }
    else i++;
  }
  return pts;
}

const poly = parsePolygon(C_PATH);
const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
const bb = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };

/** Even-odd ray cast. */
function inPoly(px, py) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b];
    if ((ya > py) !== (yb > py) && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

// Layout in 64-unit space: bubble as before, C in the upper body, dots beneath.
const R = { x0: 4, y0: 10, x1: 60, y1: 54 };
const rTL = 16, rTR = 16, rBL = 16, rBR = 5;
const inRounded = (x, y) => {
  if (x < R.x0 || x > R.x1 || y < R.y0 || y > R.y1) return false;
  const corners = [
    [R.x0 + rTL, R.y0 + rTL, rTL, x < R.x0 + rTL && y < R.y0 + rTL],
    [R.x1 - rTR, R.y0 + rTR, rTR, x > R.x1 - rTR && y < R.y0 + rTR],
    [R.x0 + rBL, R.y1 - rBL, rBL, x < R.x0 + rBL && y > R.y1 - rBL],
    [R.x1 - rBR, R.y1 - rBR, rBR, x > R.x1 - rBR && y > R.y1 - rBR],
  ];
  for (const [cx, cy, r, active] of corners) if (active) return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  return true;
};

const C_BOX = { x: 20.5, y: 14.5, w: 23, h: 23 };   // the C, upper body
const DOT_Y = 45.5, DOT_R = 3.1, DOT_X = [24, 32, 40];

const inC = (x, y) => {
  if (x < C_BOX.x || x > C_BOX.x + C_BOX.w || y < C_BOX.y || y > C_BOX.y + C_BOX.h) return false;
  const u = bb.x0 + ((x - C_BOX.x) / C_BOX.w) * (bb.x1 - bb.x0);
  const v = bb.y0 + ((y - C_BOX.y) / C_BOX.h) * (bb.y1 - bb.y0);
  return inPoly(u, v);
};
const inDot = (x, y) => DOT_X.some(cx => (x - cx) ** 2 + (y - DOT_Y) ** 2 <= DOT_R * DOT_R);

const U = S / 64;
const raw = Buffer.alloc(S * (S * 4 + 1));
let p = 0;
for (let py = 0; py < S; py++) {
  raw[p++] = 0;
  for (let px = 0; px < S; px++) {
    let bub = 0, ink = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const ux = (px + (sx + 0.5) / SS) / U, uy = (py + (sy + 0.5) / SS) / U;
      if (inRounded(ux, uy)) { bub++; if (inC(ux, uy) || inDot(ux, uy)) ink++; }
    }
    const n = SS * SS, a = bub / n, k = ink / n;
    const mix = i => Math.round((TURF[i] * (a - k) + INK[i] * k) / (a || 1));
    raw[p++] = a ? mix(0) : 0; raw[p++] = a ? mix(1) : 0; raw[p++] = a ? mix(2) : 0;
    raw[p++] = Math.round(a * 255);
  }
}

const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const OUT = process.argv[2] || path.join(__dirname, '..', 'website', 'logo-512.png');
fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log(OUT + '  ' + S + 'x' + S + '  points in C: ' + poly.length);
