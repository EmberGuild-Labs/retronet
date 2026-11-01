// Throbber sprites (DESIGN §6.1), tab loading sprites, page tiles and skin preview thumbnails.
// All drawn from scratch for RetroNet.
import { Grid, gridToSvgBody, svgDoc, mix } from './lib.mjs'

const crisp = ' shape-rendering="crispEdges"'

// Plot a parametric curve as a connected, "pixel-perfect" 1px line (no L-shaped doubles).
function plotCurve(g, fn, t0, t1, color, n = 400, sym = 0) {
  // sym: mirror-symmetric rounding about the pixel boundary at `sym` (keeps circles even)
  const q = (v) => (sym && v < sym ? 2 * sym - 1 - Math.floor(2 * sym - v) : Math.floor(v))
  const pts = []
  for (let i = 0; i <= n; i++) {
    const [x, y] = fn(t0 + ((t1 - t0) * i) / n)
    const p = [q(x), q(y)]
    const last = pts[pts.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p)
  }
  const keep = []
  pts.forEach((p, i) => {
    const a = keep[keep.length - 1], b = pts[i + 1]
    if (a && b && Math.abs(a[0] - b[0]) === 1 && Math.abs(a[1] - b[1]) === 1) return // L-corner: skip
    keep.push(p)
  })
  for (const [x, y] of keep) g.set(x, y, color)
}

// ---------- y1994: 1-bit wireframe sphere, 9 frames of 32x32 ----------
const HOURGLASS = [
  '##########', '#........#', '.#......#.', '..#....#..', '...#..#...', '....##....',
  '....##....', '...#..#...', '..#.##.#..', '.#.####.#.', '#.######.#', '##########']
// Plot the lower half (y >= c) of a curve once, then mirror it to the top so it is exactly symmetric.
function plotMirrored(g, fn, t0, t1, color, c, mirrorX = false) {
  const h = new Grid(g.w, g.h)
  plotCurve(h, fn, t0, t1, color)
  for (let y = c; y < g.h; y++) for (let x = 0; x < g.w; x++) if (h.get(x, y)) {
    g.set(x, y, color); g.set(x, 2 * c - 1 - y, color)
    if (mirrorX) { g.set(2 * c - 1 - x, y, color); g.set(2 * c - 1 - x, 2 * c - 1 - y, color) }
  }
}
function sphereFrame(phase, hourglass = false) {
  const g = new Grid(32, 32), K = '#000000', R = 13.5, c = 16
  plotMirrored(g, (t) => [c + R * Math.cos(t), c + R * Math.sin(t)], 0, Math.PI / 2, K, c, true)
  plotCurve(g, (t) => [t, c], c - R + 0.5, c + R - 0.5, K) // equator
  for (let k = -3; k <= 3; k++) {
    const phi = ((phase + 45 * k) * Math.PI) / 180
    if (Math.abs(phi) >= Math.PI / 2 - 0.01 || Math.abs(Math.sin(phi)) * R > R - 2.5) continue
    plotMirrored(g, (lam) => [c + R * Math.sin(phi) * Math.cos(lam), c + R * Math.sin(lam)], 0, Math.PI / 2 - 0.12, K, c)
  }
  if (hourglass) {
    g.rect(10, 9, 12, 14, null)
    HOURGLASS.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') g.set(11 + x, 10 + y, K) }))
  }
  return g
}
export function throbber1994() {
  const frames = [...Array(8)].map((_, f) => sphereFrame((f * 45) / 8)).concat([sphereFrame(0, true)])
  const big = new Grid(32 * 9, 32)
  frames.forEach((fr, i) => big.blit(fr, 32 * i, 0))
  return svgDoc(32 * 9, 32, gridToSvgBody(big), crisp)
}

// ---------- y1997: night sky, comet and signal arcs, 17 frames of 48x48 ----------
function skyFrame(f, incognito) {
  const g = new Grid(48, 48)
  const bands = incognito ? ['#160C2E', '#2B1A4E', '#4A2A6E'] : ['#0E1240', '#2B2160', '#5A2A6E']
  g.rect(0, 0, 48, 48, bands[0]); g.rect(0, 30, 48, 8, bands[1]); g.rect(0, 38, 48, 4, bands[2])
  g.rect(0, 42, 48, 6, '#0B0820')
  const stars = incognito
    ? [[4, 5], [11, 14], [19, 3], [29, 10], [35, 20], [44, 4], [6, 24], [41, 28], [15, 26], [24, 18], [2, 33], [46, 13], [31, 2], [9, 31]]
    : [[5, 6], [13, 17], [30, 12], [43, 22], [8, 28], [37, 31]]
  stars.forEach(([x, y], i) => g.set(x, y, i % 3 === 0 ? '#FFFF66' : i % 3 === 1 ? '#FFFFFF' : '#7FA8FF'))
  // twinkle pixel toggles every 2 frames (always on in the parked frame)
  if (f === 16 || Math.floor(f / 2) % 2 === 0) { g.set(39, 7, '#FFFFFF'); g.set(38, 7, '#7FA8FF'); g.set(40, 7, '#7FA8FF'); g.set(39, 6, '#7FA8FF'); g.set(39, 8, '#7FA8FF') }
  // signal arcs over the sun, centre (24,42); arc n lit on frames 4n..4n+3; all lit on frame 16
  ;[9, 13, 17].forEach((r, n) => {
    const lit = f === 16 || (f >= 4 * n && f <= 4 * n + 3)
    for (let y = 20; y < 42; y++) for (let x = 0; x < 48; x++) {
      const mx = x + 0.5 - 24, my = 42 - (y + 0.5), d = Math.hypot(mx, my), a = (Math.atan2(my, mx) * 180) / Math.PI
      if (d >= r && d < r + 2 && a >= 25 && a <= 155) g.set(x, y, lit ? '#F3E6C8' : '#4A4278')
    }
  })
  // stepped sun, centre (24,42) r6
  for (let i = 0; i < 6; i++) {
    const dy = i + 0.5, hw = Math.round(Math.sqrt(36 - dy * dy))
    g.rect(24 - hw, 41 - i, 2 * hw, 1, i < 2 ? '#FFB000' : '#FFD24A')
  }
  // comet: hidden on frame 0, crosses on 1..15, parked at apex on 16
  const comet = (t) => [Math.round(-4 + t * 56), Math.round(11 - 7 * Math.sin(Math.PI * t))]
  let pos = null, dir = [1, 0]
  if (f === 16) { pos = comet(0.5); dir = [1, 0] } else if (f > 0) {
    const t = (f - 1) / 14
    pos = comet(t); const nx = comet(Math.min(1, t + 0.02)), pv = comet(Math.max(0, t - 0.02))
    dir = [nx[0] - pv[0] || 1, nx[1] - pv[1]]
  }
  if (pos) {
    const L = Math.hypot(...dir), ux = dir[0] / L, uy = dir[1] / L
    for (let i = 6; i >= 1; i--) g.set(pos[0] - ux * (i + 0.5), pos[1] - uy * (i + 0.5) + 0.5, mix('#FFFF66', '#F08A24', (i - 1) / 5))
    g.rect(pos[0], pos[1], 2, 2, '#FFFFFF')
  }
  return g
}
export function throbber1997(incognito = false) {
  const big = new Grid(48 * 17, 48)
  for (let f = 0; f < 17; f++) big.blit(skyFrame(f, incognito), 48 * f, 0)
  return svgDoc(48 * 17, 48, gridToSvgBody(big), crisp)
}

// ---------- y2001: glossy orb + halo ring, 2 frames of 28x28 ----------
export function throbber2001() {
  const body = `<defs>
<radialGradient id="o" cx="11" cy="10" r="13" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6FA0F5"/><stop offset="1" stop-color="#1A4FB8"/></radialGradient>
<linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8FD47E"/><stop offset="1" stop-color="#5DBB4C"/></linearGradient>
<clipPath id="oc"><circle cx="14" cy="14" r="10.5"/></clipPath></defs>
<circle cx="14" cy="14.8" r="10.6" fill="#000" fill-opacity=".2"/>
<circle cx="14" cy="14" r="10.5" fill="url(#o)"/>
<g clip-path="url(#oc)"><ellipse cx="15.5" cy="24.5" rx="11" ry="6.5" fill="url(#gr)"/><ellipse cx="15.5" cy="24.5" rx="11" ry="6.5" fill="none" stroke="#2C7F22" stroke-opacity=".5"/></g>
<circle cx="14" cy="14" r="10" fill="none" stroke="#123C91" stroke-width="1"/>
<ellipse cx="10.5" cy="8.6" rx="5" ry="3" transform="rotate(-25 10.5 8.6)" fill="#FFFFFF" fill-opacity=".7"/>
<circle cx="42" cy="14" r="12" fill="none" stroke="#6FA0F5" stroke-width="2"/>`
  return svgDoc(56, 28, body)
}

// ---------- tab loading sprites (16px frames) ----------
export function loading1994() {
  const big = new Grid(64, 16), K = '#000000'
  for (let f = 0; f < 4; f++) {
    const g = new Grid(16, 16)
    g.rect(3, 1, 10, 1, K); g.rect(3, 14, 10, 1, K)
    for (let i = 0; i < 6; i++) { g.set(4 + i * 0.6, 2 + i, K); g.set(11 - i * 0.6, 2 + i, K); g.set(4 + i * 0.6, 13 - i, K); g.set(11 - i * 0.6, 13 - i, K) }
    const top = [[3, 4, 5, 6], [5, 6], [6], []][f], bot = [[], [12], [11, 12], [10, 11, 12]][f]
    const inner = (y) => { let a = 0, b = 15; while (!g.get(a, y) && a < 8) a++; while (!g.get(b, y) && b > 8) b--; return [a + 1, b - 1] }
    top.forEach((y) => { const [a, b] = inner(y); for (let x = a; x <= b; x++) g.set(x, y, K) })
    bot.forEach((y) => { const [a, b] = inner(y); for (let x = a; x <= b; x++) g.set(x, y, K) })
    if (f === 1 || f === 2) { g.set(7, 8, K); g.set(7, 10, K) } // falling grains
    big.blit(g, 16 * f, 0)
  }
  return svgDoc(64, 16, gridToSvgBody(big), crisp)
}
export function loading1997() {
  const big = new Grid(128, 16)
  for (let f = 0; f < 8; f++) {
    const g = new Grid(16, 16)
    for (let a = 0; a < 360; a += 30) g.set(Math.floor(8 + 5.5 * Math.cos((a * Math.PI) / 180)), Math.floor(8 + 5.5 * Math.sin((a * Math.PI) / 180)), '#808080')
    const head = f * 45
    ;[[-45, '#808080'], [-30, '#0000FF'], [-15, '#0000FF']].forEach(([da, c]) => {
      const a = ((head + da) * Math.PI) / 180
      g.set(Math.floor(7.5 + 5.5 * Math.cos(a)), Math.floor(7.5 + 5.5 * Math.sin(a)), c)
    })
    const a = (head * Math.PI) / 180, hx = Math.floor(7 + 5.5 * Math.cos(a)), hy = Math.floor(7 + 5.5 * Math.sin(a))
    g.rect(hx, hy, 2, 2, '#000080')
    big.blit(g, 16 * f, 0)
  }
  return svgDoc(128, 16, gridToSvgBody(big), crisp)
}
export function loading2001() {
  let body = ''
  for (let f = 0; f < 12; f++) for (let j = 0; j < 12; j++) {
    const a = ((j * 30 - 90) * Math.PI) / 180
    const age = (f - j + 12) % 12
    body += `<circle cx="${(16 * f + 8 + 5.4 * Math.cos(a)).toFixed(2)}" cy="${(8 + 5.4 * Math.sin(a)).toFixed(2)}" r="1.35" fill="#1A4FB8" fill-opacity="${(1 - (age / 12) * 0.85).toFixed(2)}"/>`
  }
  return svgDoc(192, 16, body)
}

// ---------- page tiles ----------
export function tileStarfield() {
  const g = new Grid(64, 64)
  g.rect(0, 0, 64, 64, '#0B1A4A')
  for (let i = 0; i < 64; i += 16) { g.rect(i, 0, 1, 64, '#1D2E6B'); g.rect(0, i, 64, 1, '#1D2E6B') }
  g.set(10, 6, '#FFFF66'); g.set(41, 27, '#FFFFFF'); g.rect(25, 49, 2, 2, '#7FA8FF')
  return svgDoc(64, 64, gridToSvgBody(g), crisp)
}
export function tileHorizon() {
  // seamless: flat base + two sine waves whose period equals the tile width
  const wave = (y0, amp, ph) => {
    let d = ''
    for (let x = 0; x <= 128; x += 2) d += `${x ? 'L' : 'M'}${x} ${(y0 + amp * Math.sin(((x / 128) * 2 + ph) * Math.PI)).toFixed(2)}`
    return `<path d="${d}" fill="none" stroke="#C6D3F7" stroke-width="1"/>`
  }
  return svgDoc(128, 128, `<rect width="128" height="128" fill="#EEF1F6"/>${wave(44, 6, 0)}${wave(92, 5, 0.6)}`)
}

// ---------- skin preview thumbnails 160x96 ----------
const raised = (x, y, w, h, lt, dk, face) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${dk}"/><rect x="${x}" y="${y}" width="${w - 1}" height="${h - 1}" fill="${lt}"/><rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" fill="${face}"/>`
const sunken = (x, y, w, h, lt, dk, face) => raised(x, y, w, h, dk, lt, face)
const textBars = (x, y, widths, color, gap = 5) => widths.map((w, i) => `<rect x="${x}" y="${y + i * gap}" width="${w}" height="2" fill="${color}"/>`).join('')

export function thumb1994() {
  const b = `<rect width="160" height="96" fill="#B8BCC4"/>
<rect y="0" width="160" height="14" fill="#9599A2"/>
${raised(3, 2, 52, 13, '#E6E8EC', '#5E636C', '#B8BCC4')}${raised(56, 3, 44, 11, '#E6E8EC', '#5E636C', '#A7ABB4')}
${textBars(8, 7, [30], '#111318')}${textBars(61, 7, [26], '#111318')}
${[4, 20, 36].map((x) => raised(x, 18, 14, 14, '#E6E8EC', '#5E636C', '#B8BCC4')).join('')}
<path d="M8 25l4-4v3h4v2h-4v3z M30 25l-4-4v3h-4v2h4v3z" fill="#111318"/><rect x="40" y="22" width="6" height="6" fill="none" stroke="#111318"/>
${textBars(54, 24, [8], '#111318')}
${sunken(64, 19, 92, 12, '#E6E8EC', '#5E636C', '#E9EBEE')}${textBars(68, 24, [50], '#1A1AA6')}
<rect x="0" y="34" width="160" height="50" fill="#BFC3C9"/>
${textBars(10, 40, [96, 120, 84, 110, 60], '#111318', 6)}${textBars(10, 72, [70], '#1A1AA6')}
${sunken(2, 85, 120, 10, '#E6E8EC', '#5E636C', '#B8BCC4')}${textBars(6, 89, [52], '#111318')}
${sunken(124, 85, 34, 10, '#E6E8EC', '#5E636C', '#B8BCC4')}`
  return svgDoc(160, 96, b, crisp)
}
export function thumb1997() {
  const btn = (x, glyph) => raised(x, 17, 22, 24, '#FFFFFF', '#000000', '#C0C0C0') + glyph
  const b = `<rect width="160" height="96" fill="#C0C0C0"/>
<rect width="160" height="14" fill="#9C9C9C"/>
${raised(3, 2, 52, 13, '#FFFFFF', '#000000', '#C0C0C0')}${raised(56, 3, 44, 11, '#FFFFFF', '#000000', '#B4B4B4')}
${textBars(8, 7, [30], '#000000')}${textBars(61, 7, [26], '#000000')}
${btn(3, '<path d="M7 25l5-5v3h5v4h-5v3z" fill="#0000FF" stroke="#000"/>')}
${btn(26, '<path d="M43 25l-5-5v3h-5v4h5v3z" fill="#0000FF" stroke="#000"/>')}
${btn(49, '<circle cx="60" cy="25" r="5" fill="none" stroke="#008000" stroke-width="2"/>')}
${btn(72, '<path d="M78 25l5-5 5 5z" fill="#800000"/><rect x="79" y="25" width="8" height="5" fill="#C0C0C0" stroke="#000" stroke-width=".8"/>')}
${btn(95, '<path d="M101 21h8l2 2v8h-10z" fill="#FF0000" stroke="#000"/>')}
${[[6, 3], [29, 3], [52, 3], [75, 3], [98, 3]].map(([x]) => `<rect x="${x + 4}" y="35" width="10" height="2" fill="#000"/>`).join('')}
${sunken(132, 15, 26, 26, '#FFFFFF', '#808080', '#0E1240')}<rect x="141" y="31" width="8" height="2" fill="#FFB000"/><rect x="142" y="29" width="6" height="2" fill="#FFD24A"/><rect x="143" y="28" width="4" height="1" fill="#FFD24A"/><path d="M139 27h1v-2h2v-1h6v1h2v2h1v1h-1v-1h-2v-1h-6v1h-2v1h-1z" fill="#F3E6C8"/><rect x="134" y="33" width="22" height="1" fill="#0B0820"/><rect x="141" y="20" width="2" height="2" fill="#FFFFFF"/><rect x="152" y="22" width="1" height="1" fill="#FFFF66"/>
${textBars(3, 47, [22], '#000000')}${sunken(28, 43, 128, 11, '#FFFFFF', '#808080', '#FFFFFF')}${textBars(32, 47, [56], '#000000')}
<rect x="0" y="56" width="160" height="28" fill="#0B1A4A"/><rect x="0" y="56" width="160" height="28" fill="none"/>
<rect x="10" y="62" width="1" height="1" fill="#FFFF66"/><rect x="150" y="70" width="2" height="2" fill="#7FA8FF"/><rect x="5" y="78" width="1" height="1" fill="#FFF"/>
${raised(18, 59, 124, 24, '#FFFFFF', '#000000', '#C0C0C0')}${textBars(24, 64, [80, 100, 64], '#000000', 6)}
${sunken(2, 85, 120, 10, '#FFFFFF', '#808080', '#C0C0C0')}${textBars(6, 89, [52], '#000000')}
${sunken(124, 85, 34, 10, '#FFFFFF', '#808080', '#C0C0C0')}`
  return svgDoc(160, 96, b, crisp)
}
export function thumb2001() {
  const b = `<defs>
<linearGradient id="ts" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3A7BEA"/><stop offset=".15" stop-color="#2259D0"/><stop offset=".6" stop-color="#2259D0"/><stop offset="1" stop-color="#1A4FB8"/></linearGradient>
<linearGradient id="gb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8FD47E"/><stop offset=".5" stop-color="#5DBB4C"/><stop offset="1" stop-color="#2C7F22"/></linearGradient>
<linearGradient id="gg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9C5B2"/></linearGradient></defs>
<rect width="160" height="96" fill="#EEEBDD"/>
<rect width="160" height="18" fill="url(#ts)"/>
<path d="M4 18v-10a5 5 0 0 1 5-5h44a5 5 0 0 1 5 5v10z" fill="#EEEBDD"/>
<path d="M60 18v-9a4 4 0 0 1 4-4h38a4 4 0 0 1 4 4v9z" fill="#2D63D2" stroke="#1A4FB8"/>
<rect x="10" y="9" width="32" height="2" rx="1" fill="#1B1B1B"/><rect x="66" y="10" width="28" height="2" rx="1" fill="#FFFFFF"/>
<circle cx="13" cy="30" r="9" fill="url(#gb)" stroke="#2C7F22"/><path d="M8.5 30l5-4.5v3h4.5v3h-4.5v3z" fill="#FFF"/>
<circle cx="33" cy="30" r="7" fill="url(#gg)" stroke="#7F7A66"/><path d="M37 30l-4-3.5v2.5h-3.5v2h3.5v2.5z" fill="#7F7A66"/>
<rect x="46" y="23" width="90" height="14" rx="2" fill="#FFFFFF" stroke="#5E7DAA"/><rect x="51" y="29" width="60" height="2" rx="1" fill="#1B1B1B"/>
<rect x="139" y="23" width="18" height="14" rx="3" fill="url(#gb)" stroke="#2C7F22"/><path d="M144 30h5v-3l4 3-4 3v-3h-5z" fill="#FFF"/>
<rect x="0" y="41" width="160" height="43" fill="#F7F5EC"/><rect x="0" y="41" width="160" height="1" fill="#D6D2C0"/>
<rect x="10" y="47" width="140" height="32" rx="6" fill="#FFFFFF" stroke="#C6D3F7"/>
<path d="M10 53a6 6 0 0 1 6-6h128a6 6 0 0 1 6 6v3H10z" fill="#C6D3F7"/><rect x="16" y="50" width="40" height="2" rx="1" fill="#0B3F9E"/>
${textBars(16, 61, [100, 120, 84], '#555249', 6)}
<rect x="0" y="85" width="160" height="11" fill="#EEEBDD"/><rect x="0" y="85" width="160" height="1" fill="#D6D2C0"/>
${textBars(6, 89, [52], '#1B1B1B')}`
  return svgDoc(160, 96, b)
}

// ======================= y1999 "1999 Gumdrop" (DESIGN-Y1999 §8-10) =======================
const n2 = (v) => +v.toFixed(2)

// Tab spinner: "peppermint swirl", 8 frames of 16px. Three swirl wedges repeat every 120deg; 8 x 15deg = 120deg, so it loops.
export function loading1999(incognito = false) {
  const wedge = incognito ? '#9B6FD8' : '#2FA9C4'
  let body = ''
  for (let f = 0; f < 8; f++) {
    const cx = 16 * f + 8, cy = 8, R = 6.4
    body += `<circle cx="${cx}" cy="${cy}" r="6.5" fill="#FFFFFF"/>`
    for (let k = 0; k < 3; k++) {
      const a0 = ((f * 15 + k * 120 - 90) * Math.PI) / 180, a1 = a0 + (52 * Math.PI) / 180
      const P = (a, r) => `${n2(cx + r * Math.cos(a))} ${n2(cy + r * Math.sin(a))}`
      // swirl arm: from the centre, bow out to the rim, follow the rim, bow back in (curved like a peppermint)
      body += `<path d="M${cx} ${cy}Q${P(a0 - 0.55, R * 0.62)} ${P(a0, R)}A${R} ${R} 0 0 1 ${P(a1, R)}Q${P(a1 - 0.95, R * 0.5)} ${cx} ${cy}Z" fill="${wedge}"/>`
    }
    body += `<circle cx="${cx}" cy="${cy}" r="1.1" fill="#FFFFFF"/>`
    body += `<circle cx="${cx}" cy="${cy}" r="6.5" fill="none" stroke="${incognito ? '#5B2E91' : '#0A4F60'}" stroke-width="1"/>`
    if (incognito) body += `<circle cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="#FFFFFF" stroke-width="1"/>`
  }
  return svgDoc(128, 16, body)
}

// Throbber: "Gumdrop pod", 13 frames of 32px. 0 = idle (no bubbles, dome at 55%), 0-11 loop, 12 = reduced-motion loading frame.
const DOME = 'M3.5 27.5C3.5 14.5 8.5 6.5 16 6.5S28.5 14.5 28.5 27.5Z'
const GLOSS_ARC = (t) => { // point along the specular arc, t in 0..1 (lower-left -> top)
  const a = ((200 + t * 62) * Math.PI) / 180
  return [16 + 10.2 * Math.cos(a) + 1.2, 19 + 11 * Math.sin(a) + 0.6]
}
function podFrame(f, incognito, ox) {
  const [lt, md, dk] = incognito ? ['#E3D2FA', '#9B6FD8', '#5B2E91'] : ['#B9EEF6', '#2FA9C4', '#0E6F86']
  const idle = f === 0, reduced = f === 12
  const T = (d) => d.replace(/([MLCSQA ])(-?[\d.]+) (-?[\d.]+)/g, (_, c, x, y) => `${c}${n2(+x + ox)} ${y}`)
  let b = `<g${idle ? ' opacity=".55"' : ''}>`
  b += `<path d="${T(DOME)}" fill="url(#pod${incognito ? 'i' : ''})"/>`
  if (!idle) {
    b += `<g clip-path="url(#podc${ox})">`
    const bubbles = [[12, 1, 0], [16, 1.5, 4], [20, 1, 8]]
    for (const [bx, r, off] of bubbles) {
      const p = reduced ? [0.45, 0.6, 0.35][off / 4] : ((f + off) % 12) / 12
      const y = 24.5 - p * 12, x = bx + Math.sin(p * Math.PI * 2 + off) * 0.7
      b += `<circle cx="${n2(x + ox)}" cy="${n2(y)}" r="${r}" fill="#FFFFFF" fill-opacity=".8" stroke="${dk}" stroke-width="1"/>`
    }
    if (reduced) b += `<rect x="${14.5 + ox}" y="18.5" width="3" height="3" rx=".6" fill="#FF9A2E"/>`
    b += '</g>'
  }
  // specular arc (top-left) and outline
  const arc = [0, 0.33, 0.66, 1].map((t) => GLOSS_ARC(t))
  b += `<path d="M${n2(arc[0][0] + ox)} ${n2(arc[0][1])}C${n2(arc[1][0] + ox)} ${n2(arc[1][1])} ${n2(arc[2][0] + ox)} ${n2(arc[2][1])} ${n2(arc[3][0] + ox)} ${n2(arc[3][1])}" fill="none" stroke="#FFFFFF" stroke-opacity=".7" stroke-width="2.4" stroke-linecap="round"/>`
  b += `<path d="${T(DOME)}" fill="none" stroke="${dk}" stroke-width="1" stroke-linejoin="round"/>`
  b += `<rect x="${4 + ox}" y="27" width="24" height="1" fill="${dk}" fill-opacity=".35"/>`
  if (!idle) { // 2x2 sparkle travels out along the arc (frames 0-5) and back (6-11)
    const lf = reduced ? 0 : f
    const [ax, ay] = GLOSS_ARC((lf < 6 ? lf : 11 - lf) / 5)
    const sx = ax + (16 - ax) * 0.2, sy = ay + (19 - ay) * 0.2 // just inside the arc, so it reads against the jelly
    b += `<rect x="${n2(sx - 1 + ox)}" y="${n2(sy - 1)}" width="2" height="2" fill="#FFFFFF"/>`
  }
  return b + '</g>'
}
export function throbber1999(incognito = false) {
  const [lt, md] = incognito ? ['#E3D2FA', '#9B6FD8'] : ['#B9EEF6', '#2FA9C4']
  let defs = `<linearGradient id="pod${incognito ? 'i' : ''}" x1="0" y1="6" x2="0" y2="28" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${lt}"/><stop offset=".6" stop-color="${md}"/><stop offset="1" stop-color="${incognito ? '#C9B2EE' : '#8FD9E6'}"/></linearGradient>`
  let body = ''
  for (let f = 0; f < 13; f++) {
    const ox = 32 * f
    defs += `<clipPath id="podc${ox}"><path d="${DOME.replace(/([MLCSQA ])(-?[\d.]+) (-?[\d.]+)/g, (_, c, x, y) => `${c}${n2(+x + ox)} ${y}`)}"/></clipPath>`
    body += podFrame(f, incognito, ox)
  }
  return svgDoc(416, 32, `<defs>${defs}</defs>${body}`)
}

// Settings preview thumbnail 160x96
export function thumb1999() {
  const stripes = (y0, y1, col) => { let s = ''; for (let y = y0; y < y1; y += 3) s += `<rect y="${y}" width="160" height="1" fill="${col}"/>`; return s }
  const gum = (cx) => `<circle cx="${cx}" cy="27" r="6.5" fill="url(#gc)" stroke="#5F6C78"/><ellipse cx="${cx - 2}" cy="24.5" rx="2.6" ry="1.4" fill="#FFFFFF"/>`
  const b = `<defs>
<linearGradient id="ls" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#63C7D9"/><stop offset=".5" stop-color="#2A9BB4"/><stop offset="1" stop-color="#1A7F97"/></linearGradient>
<linearGradient id="mt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E4E8EB"/><stop offset="1" stop-color="#CDD3D8"/></linearGradient>
<linearGradient id="gc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".5" stop-color="#F3F6F8"/><stop offset=".55" stop-color="#DDE3E8"/><stop offset="1" stop-color="#F4F7F9"/></linearGradient>
<linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E6F8FB"/><stop offset=".45" stop-color="#A6E3EE"/><stop offset=".5" stop-color="#4DB8CC"/><stop offset="1" stop-color="#8FD9E6"/></linearGradient>
<linearGradient id="pd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B9EEF6"/><stop offset=".6" stop-color="#2FA9C4"/><stop offset="1" stop-color="#8FD9E6"/></linearGradient></defs>
<rect width="160" height="16" fill="url(#ls)"/>${stripes(0, 16, '#FFFFFF" fill-opacity=".14')}
<path d="M58 16v-9a4 4 0 0 1 4-4h34a4 4 0 0 1 4 4v9z" fill="#FFFFFF" fill-opacity=".4" stroke="#FFFFFF" stroke-opacity=".6"/>
<path d="M8 16v-9a5 5 0 0 1 5-5h38a5 5 0 0 1 5 5v9z" fill="#E4E8EB"/>
<rect x="14" y="8" width="30" height="2" rx="1" fill="#15202B"/><rect x="64" y="9" width="26" height="2" rx="1" fill="#0B2730"/>
<rect y="16" width="160" height="22" fill="url(#mt)"/>
<rect y="20" width="160" height="1" fill="#FFFFFF" fill-opacity=".5"/><rect y="27" width="160" height="1" fill="#000" fill-opacity=".04"/><rect y="33" width="160" height="1" fill="#FFFFFF" fill-opacity=".45"/>
<rect x="6.5" y="20.5" width="28" height="14" rx="7" fill="url(#gc)" stroke="#5F6C78"/><rect x="20" y="21" width="1" height="13" fill="#5F6C78"/>
<path d="M10 27.5l4-3.5v2.5h3v2h-3v2.5z M31 27.5l-4-3.5v2.5h-3v2h3v2.5z" fill="#0B2730"/>
${gum(48)}${gum(64)}${gum(80)}
<circle cx="48" cy="27" r="2.5" fill="none" stroke="#3F7F14" stroke-width="1.4"/><path d="M61.5 24.5h5v5h-5z" fill="#E8455A"/><path d="M76.5 28l3.5-3.5 3.5 3.5v2.5h-7z" fill="#FF9A2E"/>
<path d="M136.5 37C136.5 27 140 20 145 20S153.5 27 153.5 37Z" fill="url(#pd)" stroke="#0E6F86"/><path d="M139.5 31c.3-3 1.3-6 3-8" stroke="#FFFFFF" stroke-opacity=".7" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<rect y="38" width="160" height="12" fill="#DCE1E5"/>
<rect x="6.5" y="39.5" width="126" height="9" rx="4.5" fill="#FFFFFF" stroke="#5F6C78"/><rect x="12" y="43" width="58" height="2" rx="1" fill="#15202B"/>
<rect x="136.5" y="39.5" width="18" height="9" rx="4.5" fill="url(#gl)" stroke="#176C80"/><path d="M142 44h4v-2l3 2-3 2v-2h-4z" fill="#062A33"/>
<rect y="50" width="160" height="36" fill="#F5F7F9"/>${(() => { let s = ''; for (let y = 53; y < 86; y += 4) s += `<rect y="${y}" width="160" height="1" fill="#E8ECEF"/>`; return s })()}
<rect x="12.5" y="54.5" width="135" height="28" rx="8" fill="#FFFFFF" stroke="#A9B4BD"/>
<rect x="20" y="60" width="44" height="4" rx="2" fill="#0A4F60"/>${textBars(20, 69, [104, 84], '#44505B', 6)}
<rect y="86" width="160" height="10" fill="#D6DBDF"/><rect y="86" width="160" height="1" fill="#B3BCC4"/>${textBars(6, 90, [52], '#15202B')}
<rect x="124" y="89" width="7" height="4" rx="2" fill="#2FA9C4"/><rect x="131" y="89" width="7" height="4" fill="#FF9A2E"/><rect x="138" y="89" width="7" height="4" fill="#9B6FD8"/><rect x="145" y="89" width="7" height="4" rx="2" fill="#7CCB3A"/>`
  return svgDoc(160, 96, b)
}

// New-tab tile 160x160, seamless: pinstripe base + four soft candy circles that wrap at the edges.
export function tileBubbles() {
  let b = '<rect width="160" height="160" fill="#F5F7F9"/>'
  for (let y = 3; y < 160; y += 4) b += `<rect y="${y}" width="160" height="1" fill="#E8ECEF"/>`
  const dots = [['#2FA9C4', 0.16, 34, 30, 40], ['#FF9A2E', 0.12, 22, 118, 30], ['#9B6FD8', 0.12, 28, 100, 118], ['#7CCB3A', 0.12, 14, 28, 128]]
  for (const [c, op, r, cx, cy] of dots) {
    for (const dx of [-160, 0, 160]) for (const dy of [-160, 0, 160]) {
      const x = cx + dx, y = cy + dy
      if (x + r < 0 || x - r > 160 || y + r < 0 || y - r > 160) continue
      b += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" fill-opacity="${op}"/>`
      b += `<circle cx="${n2(x - r * 0.12)}" cy="${n2(y - r * 0.12)}" r="${n2(r * 0.78)}" fill="none" stroke="#FFFFFF" stroke-opacity=".5" stroke-dasharray="${n2(r * 0.78 * 1.4)} ${n2(r * 0.78 * 6.4)}" transform="rotate(178 ${n2(x - r * 0.12)} ${n2(y - r * 0.12)})"/>`
    }
  }
  return svgDoc(160, 160, b)
}
