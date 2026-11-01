// RetroNet art toolkit: tiny vector shape model that can be rasterized into pixel art
// (1994 / 1997 skins) or emitted as smooth SVG (2001 skin). All art is original.

// ---------- shapes (16-unit design space, y down) ----------
export const poly = (...pts) => ({ t: 'poly', pts })
export const rect = (x, y, w, h) => poly([x, y], [x + w, y], [x + w, y + h], [x, y + h])
export const circle = (cx, cy, r) => ({ t: 'ell', cx, cy, rx: r, ry: r })
export const ellipse = (cx, cy, rx, ry) => ({ t: 'ell', cx, cy, rx, ry })
export const ring = (cx, cy, r, w) => ({ t: 'ring', cx, cy, rx: r, ry: r, w })
export const ringE = (cx, cy, rx, ry, w) => ({ t: 'ring', cx, cy, rx, ry, w })
export function line(x1, y1, x2, y2, w) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1
  const nx = (-dy / L) * (w / 2), ny = (dx / L) * (w / 2)
  return poly([x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny])
}
// polyline as a list of thick segments
export const path = (pts, w) => pts.slice(1).map((p, i) => line(pts[i][0], pts[i][1], p[0], p[1], w))
// band along a circle; screen angles in degrees (0 = +x, 90 = down)
export function arc(cx, cy, r, w, a0, a1, n = 40) {
  const out = [], inn = []
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    out.push([cx + (r + w / 2) * Math.cos(a), cy + (r + w / 2) * Math.sin(a)])
    inn.push([cx + (r - w / 2) * Math.cos(a), cy + (r - w / 2) * Math.sin(a)])
  }
  return poly(...out, ...inn.reverse())
}
export function star(cx, cy, R, r, rot = -90) {
  const pts = []
  for (let i = 0; i < 10; i++) {
    const a = ((rot + i * 36) * Math.PI) / 180, rr = i % 2 ? r : R
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)])
  }
  return poly(...pts)
}
export function transform(shape, fn) {
  if (shape.t === 'poly') return { ...shape, pts: shape.pts.map(fn) }
  const [cx, cy] = fn([shape.cx, shape.cy])
  return { ...shape, cx, cy }
}
export const mirrorX = (s) => transform(s, ([x, y]) => [16 - x, y])
export const rotate = (s, deg, cx = 8, cy = 8) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), si = Math.sin(a)
  return transform(s, ([x, y]) => [cx + (x - cx) * c - (y - cy) * si, cy + (x - cx) * si + (y - cy) * c])
}
export const translate = (s, dx, dy) => transform(s, ([x, y]) => [x + dx, y + dy])

// ---------- hit testing ----------
function inPoly(pts, x, y) {
  let ins = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins
  }
  return ins
}
const inEll = (cx, cy, rx, ry, x, y) => rx > 0 && ry > 0 && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
export function inside(s, x, y) {
  if (s.t === 'poly') return inPoly(s.pts, x, y)
  if (s.t === 'ell') return inEll(s.cx, s.cy, s.rx, s.ry, x, y)
  if (s.t === 'ring')
    return inEll(s.cx, s.cy, s.rx + s.w / 2, s.ry + s.w / 2, x, y) && !inEll(s.cx, s.cy, s.rx - s.w / 2, s.ry - s.w / 2, x, y)
  return false
}

// ---------- pixel grid ----------
export class Grid {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Array(w * h).fill(null) }
  get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.px[y * this.w + x] }
  set(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c }
  rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c) }
  // stamp another grid at an offset
  blit(g, ox, oy) { for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) { const c = g.get(x, y); if (c) this.set(ox + x, oy + y, c) } }
  // rasterize shapes at pixel centers; scale maps design units to pixels
  fill(shapes, c, scale = 1, holes = [], ox = 0, oy = 0) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const ux = (x + 0.5 - ox) / scale, uy = (y + 0.5 - oy) / scale
      if (shapes.some((s) => inside(s, ux, uy)) && !holes.some((s) => inside(s, ux, uy))) this.set(x, y, c)
    }
  }
}

export function mask(w, h, shapes, scale, holes = []) {
  const m = new Grid(w, h); m.fill(shapes, 1, scale, holes); return m
}

// Merge runs of each color into one <path> per color.
export function gridToSvgBody(g, ox = 0, oy = 0) {
  const byColor = new Map()
  for (let y = 0; y < g.h; y++) {
    let x = 0
    while (x < g.w) {
      const c = g.get(x, y)
      if (!c) { x++; continue }
      let e = x
      while (e + 1 < g.w && g.get(e + 1, y) === c) e++
      if (!byColor.has(c)) byColor.set(c, [])
      byColor.get(c).push(`M${x + ox} ${y + oy}h${e - x + 1}v1h${-(e - x + 1)}z`)
      x = e + 1
    }
  }
  let out = ''
  for (const [c, d] of byColor) {
    const [fill, op] = c.split('@')
    out += `<path fill="${fill}"${op ? ` fill-opacity="${op}"` : ''} d="${d.join('')}"/>`
  }
  return out
}

export const svgDoc = (w, h, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${extra}>${body}</svg>\n`

// ---------- shape -> svg (smooth) ----------
const f = (n) => +n.toFixed(3)
export function shapeToSvg(s, scale, attrs = '') {
  if (s.t === 'poly') return `<path${attrs} d="M${s.pts.map(([x, y]) => `${f(x * scale)} ${f(y * scale)}`).join('L')}Z"/>`
  if (s.t === 'ell') return `<ellipse${attrs} cx="${f(s.cx * scale)}" cy="${f(s.cy * scale)}" rx="${f(s.rx * scale)}" ry="${f(s.ry * scale)}"/>`
  if (s.t === 'ring') {
    const e = (rx, ry) => {
      const cx = s.cx * scale, cy = s.cy * scale
      return `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`
    }
    return `<path${attrs} fill-rule="evenodd" d="${e((s.rx + s.w / 2) * scale, (s.ry + s.w / 2) * scale)}${e((s.rx - s.w / 2) * scale, (s.ry - s.w / 2) * scale)}"/>`
  }
  return ''
}
export function bbox(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of shapes) {
    const pts = s.t === 'poly' ? s.pts : [[s.cx - s.rx - (s.w || 0), s.cy - s.ry - (s.w || 0)], [s.cx + s.rx + (s.w || 0), s.cy + s.ry + (s.w || 0)]]
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  }
  return { x0, y0, x1, y1 }
}

// ---------- color ----------
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
export const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()
export const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t))
