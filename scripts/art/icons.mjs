// RetroNet toolbar icon set: one shared, original geometry per concept (16-unit grid),
// rendered three ways: y1994 1-bit pixel outlines, y1997 16-color pixel art with
// black outline and top-left light, y2001 smooth glossy vector.
import { Grid, mask, gridToSvgBody, svgDoc, shapeToSvg, bbox, mix,
  poly, rect, circle, ellipse, ring, ringE, line, path, arc, star, mirrorX, rotate, translate } from './lib.mjs'

// part: { c: colorKey, s: shapes, h: holes, ink: solid line-work, o94: 'outline'|'solid'|'skip', only: [k] }
const P = (c, s, o = {}) => ({ c, s: [].concat(s), h: [], ...o })
const ink = (s, o = {}) => P(o.c || 'black', s, { ink: true, o94: 'solid', ...o })

const arrowLeft = () => poly([1.5, 8], [7.5, 2], [7.5, 5.5], [14.5, 5.5], [14.5, 10.5], [7.5, 10.5], [7.5, 14])
const sheet = () => poly([3, 1.5], [10, 1.5], [13, 4.5], [13, 14.5], [3, 14.5])
const fold = () => poly([10, 1.5], [10, 4.5], [13, 4.5])
const lockBody = () => rect(2, 7.5, 12, 7)
const keyhole = () => rect(7, 9.5, 2, 3)
const speaker = () => poly([1.5, 6], [4.5, 6], [8.5, 2.5], [8.5, 13.5], [4.5, 10], [1.5, 10])
const magnifier = (k, lens) => [
  P(lens, circle(6.5, 6.5, 5), { h: k === '94' ? [] : [] }),
  k === '94' ? ink(line(9.8, 9.8, 14.2, 14.2, 2.2)) : P('maroon', line(9.6, 9.6, 14, 14, 2.6), { c01: 'gray' }),
]

export const ICONS = {
  back: (k) => [P(k === '01' ? 'white' : 'blue', arrowLeft())],
  forward: (k) => [P(k === '01' ? 'white' : 'blue', mirrorX(arrowLeft()))],
  reload: (k) => [
    P('green', arc(8, 8.5, 5, k === '94' ? 1.6 : 2.4, -40, 250)),
    P('green', poly([8.2, 0.6], [8.2, 7.2], [12.8, 3.9]), { o94: 'solid' }),
  ],
  stop: (k) => k === '01'
    ? [P('red', circle(8, 8, 6.5)), ink(line(5.3, 5.3, 10.7, 10.7, 1.8), { c: 'white' }), ink(line(10.7, 5.3, 5.3, 10.7, 1.8), { c: 'white' })]
    : [
        P('red', poly([5.3, 1.5], [10.7, 1.5], [14.5, 5.3], [14.5, 10.7], [10.7, 14.5], [5.3, 14.5], [1.5, 10.7], [1.5, 5.3])),
        k === '94'
          ? [ink(line(5, 5, 11, 11, 1)), ink(line(11, 5, 5, 11, 1))]
          : ink(rect(4, 7, 8, 2), { c: 'white' }),
      ].flat(),
  home: (k) => [
    P(k === '01' ? 'gold' : 'gray', rect(3.5, 7.5, 9, 7), { h: k === '97' ? [] : [rect(7, 10.5, 2, 4.5)] }),
    P(k === '01' ? 'blue' : 'maroon', poly([1, 8.5], [8, 1.5], [15, 8.5])),
    k === '97' ? ink(rect(7, 10.5, 2, 4)) : null,
    k === '97' ? P('yellow', rect(10, 9.5, 2, 2)) : null,
  ].filter(Boolean),
  newtab: (k) => k === '94'
    ? [ink([rect(7, 2.5, 2, 11), rect(2.5, 7, 11, 2)])]
    : k === '97'
      ? [P('white', sheet()), P('gray', fold()), P('green', [rect(9, 7, 2, 7), rect(6.5, 9.5, 7, 2)], { c: 'lime' })]
      : [P('blue', [rect(6.3, 2, 3.4, 12), rect(2, 6.3, 12, 3.4)])],
  close: (k) => {
    const w = k === '94' ? 1.1 : 2, a = k === '94' ? 4 : 3.5
    return [ink([line(a, a, 16 - a, 16 - a, w), line(16 - a, a, a, 16 - a, w)], { c: k === '01' ? 'dgray' : 'black' })]
  },
  bookmark: (k) => [P(k === '01' ? 'white' : 'gray', star(8, 8.6, 7, 2.9))],
  'bookmark-filled': (k) => [P('gold', star(8, 8.6, 7, 2.9), { o94: 'solid' })],
  menu: (k) => k === '94'
    ? [ink([rect(2.5, 3.5, 11, 1), rect(2.5, 7.5, 11, 1), rect(2.5, 11.5, 11, 1)])]
    : [P('gray', [rect(2, 2, 12, 2), rect(2, 7, 12, 2), rect(2, 12, 12, 2)])],
  profile: (k) => [
    P(k === '97' ? 'teal' : 'blue', ellipse(8, 15.2, 6, 6), { h: [rect(0, 14.6, 16, 3)] }),
    P(k === '97' ? 'teal' : 'blue', circle(8, 5.4, 3.4)),
  ],
  incognito: (k) => [
    P(k === '97' ? 'purple' : 'violet', [poly([2.6, 7], [0.8, 12.6], [3.4, 11.8], [4.2, 8.6]), poly([13.4, 7], [15.2, 12.6], [12.6, 11.8], [11.8, 8.6])]),
    P(k === '97' ? 'black' : 'violet', ellipse(8, 7.4, 6.8, 3.6), { h: [ellipse(5.2, 7.2, 1.8, 1.1), ellipse(10.8, 7.2, 1.8, 1.1)] }),
    k === '97' ? P('white', [ringE(5.2, 7.2, 2.1, 1.4, 0.9), ringE(10.8, 7.2, 2.1, 1.4, 0.9)]) : null,
  ].filter(Boolean),
  lock: (k) => [
    P('gray', [arc(8, 5.5, 3, 2, 180, 360), rect(4, 5.5, 2, 2), rect(10, 5.5, 2, 2)], { o94: 'solid', c01: 'gray' }),
    P('gold', lockBody(), { h: [keyhole()] }),
  ],
  'not-secure': (k) => [
    P('gray', [arc(8, 4.5, 3, 2, 180, 330), rect(4, 4.5, 2, 2)], { o94: 'solid' }),
    P('gold', lockBody(), { h: [keyhole()] }),
  ],
  warning: (k) => [
    P(k === '01' ? 'gold' : 'yellow', poly([8, 1], [15.2, 14.5], [0.8, 14.5])),
    ink([rect(7, 5.5, 2, 5), rect(7, 11.5, 2, 1.8)], { c: k === '01' ? 'black' : 'black' }),
  ],
  find: (k) => magnifier(k, k === '97' ? 'cyan' : 'blue'),
  search: (k) => magnifier(k, k === '97' ? 'cyan' : 'blue'),
  download: (k) => [
    P(k === '01' ? 'green' : 'blue', poly([6.5, 1], [9.5, 1], [9.5, 6], [12.5, 6], [8, 10.8], [3.5, 6], [6.5, 6])),
    k === '94'
      ? ink([rect(1.5, 11, 1, 4), rect(1.5, 14, 13, 1), rect(13.5, 11, 1, 4)])
      : P('gray', [rect(1.5, 10.5, 2.5, 4.5), rect(1.5, 12.5, 13, 2.5), rect(12, 10.5, 2.5, 4.5)]),
  ],
  folder: (k) => [
    P(k === '01' ? 'gold' : 'yellow', [rect(1.5, 3, 5.5, 2.5), rect(1.5, 4.5, 13, 9.5)], { c97: '#FFFF00' }),
    k === '94' ? null : P(k === '01' ? 'gold' : 'olive', poly([1.5, 14], [3.5, 7.5], [15, 7.5], [13, 14]), { c01: 'gold' }),
  ].filter(Boolean),
  page: (k) => [
    P('white', sheet()),
    P(k === '01' ? 'white' : 'gray', fold(), { o94: 'outline' }),
    k === '01' ? ink([rect(5, 7, 6, 0.9), rect(5, 9.3, 6, 0.9), rect(5, 11.6, 4.5, 0.9)], { c: 'blue' }) : null,
  ].filter(Boolean),
  globe: (k) => {
    const wire = k === '94' ? 1 : 1.1
    const lines = [ring(8, 8, 6.2, wire), ringE(8, 8, 3, 6.2, wire), rect(1.8, 7.5, 12.4, wire)]
    if (k === '94') return [ink(lines)]
    return [P(k === '97' ? 'teal' : 'blue', circle(8, 8, 6.6)), ink([ringE(8, 8, 3, 6.4, wire), rect(1.8, 7.45, 12.4, wire)], { c: k === '97' ? 'cyan' : 'whiteA' })]
  },
  pin: (k) => {
    const r = (s) => rotate(s, 45)
    return [
      ink(r(rect(7.4, 9.5, 1.2, 6)), { c: k === '01' ? 'dgray' : 'black' }),
      P('red', [r(rect(5, 1, 6, 2.5)), r(rect(6.2, 3.5, 3.6, 4)), r(rect(3.5, 7.5, 9, 2))]),
    ]
  },
  audio: (k) => [
    P(k === '01' ? 'blue' : k === '97' ? 'black' : 'black', speaker(), { o94: 'solid' }),
    ink([arc(8.5, 8, 3.2, 1.2, -50, 50), arc(8.5, 8, 5.6, 1.2, -55, 55)], { c: k === '97' ? 'dgray' : k === '01' ? 'blue' : 'black' }),
  ],
  muted: (k) => [
    P(k === '01' ? 'blue' : 'black', speaker(), { o94: 'solid' }),
    ink([line(10.5, 5.5, 14.8, 10.5, 1.4), line(14.8, 5.5, 10.5, 10.5, 1.4)], { c: k === '01' ? 'red' : k === '97' ? 'red' : 'black' }),
  ],
  go: (k) => {
    const arrow = poly([2.5, 6.5], [8, 6.5], [8, 3], [13.5, 8], [8, 13], [8, 9.5], [2.5, 9.5])
    if (k === '94') return [P('black', rect(1, 1, 14, 14), { o94: 'solid' }), ink(translate(arrow, 0, 0), { c: 'knock' })]
    return [P(k === '01' ? 'white' : 'green', arrow)]
  },
  history: (k) => [
    P(k === '01' ? 'blue' : 'white', circle(8.5, 8.5, 6)),
    k === '01' ? P('white', circle(8.5, 8.5, 4.4)) : null,
    ink([line(8.5, 8.5, 5.9, 7, 1.3), line(8.5, 8.5, 11.4, 5.6, 1.1)], { c: 'black', o94: 'solid' }),
    ink(poly([0.6, 4.2], [4.6, 3.4], [1.6, 0.8]), { c: k === '94' ? 'black' : k === '01' ? 'green' : 'green' }),
  ].filter(Boolean),
  settings: (k) => [
    ink([rect(1.5, 3.5, 13, 1), rect(1.5, 7.5, 13, 1), rect(1.5, 11.5, 13, 1)], { c: k === '94' ? 'black' : 'dgray' }),
    P(k === '94' ? 'black' : 'blue', [rect(8.5, 2, 3, 4), rect(3.5, 6, 3, 4), rect(10, 10, 3, 4)], { o94: 'solid' }),
  ],
  trash: (k) => [
    P('gray', poly([3.2, 4.5], [12.8, 4.5], [11.7, 14.5], [4.3, 14.5])),
    P('gray', rect(2, 3, 12, 2)),
    ink([rect(6, 7, 1, 5.5), rect(9, 7, 1, 5.5)], { c: k === '94' ? 'black' : 'dgray' }),
  ],
  pause: (k) => [P(k === '01' ? 'blue' : 'black', [rect(3.5, 2.5, 3.2, 11), rect(9.3, 2.5, 3.2, 11)], { o94: 'solid' })],
  play: (k) => [P(k === '01' ? 'blue' : 'black', poly([4, 2], [13, 8], [4, 14]), { o94: 'solid' })],
  'chevron-down': (k) => [ink(path([[4, 6], [8, 10], [12, 6]], k === '94' ? 1.3 : 1.8), { c: k === '01' ? 'dgray' : 'black' })],
  'chevron-right': (k) => [ink(path([[6, 4], [10, 8], [6, 12]], k === '94' ? 1.3 : 1.8), { c: k === '01' ? 'dgray' : 'black' })],
  'chevron-left': (k) => [ink(path([[10, 4], [6, 8], [10, 12]], k === '94' ? 1.3 : 1.8), { c: k === '01' ? 'dgray' : 'black' })],
  external: (k) => [
    ink([rect(2, 4, 1.2, 10), rect(2, 12.8, 10, 1.2), rect(10.8, 9, 1.2, 5), rect(2, 4, 5, 1.2)], { c: k === '01' ? 'dgray' : 'black' }),
    ink([line(6.5, 9.5, 12.5, 3.5, 1.6), poly([8.5, 1.5], [14.5, 1.5], [14.5, 7.5])], { c: k === '94' ? 'black' : 'blue' }),
  ],
  info: (k) => [
    P('blue', circle(8, 8, 6.6), k === '94' ? {} : {}),
    ink([rect(7, 6.8, 2, 5.5), rect(7, 3.6, 2, 2)], { c: k === '94' ? 'black' : 'white' }),
  ],
  camera: (k) => [
    P(k === '01' ? 'gray' : 'dgray', rect(1.5, 4.5, 9, 7.5)),
    P(k === '01' ? 'blue' : 'black', poly([10.5, 8.2], [14.6, 5], [14.6, 11.5]), { o94: 'solid' }),
    k === '94' ? null : P(k === '01' ? 'blue' : 'cyan', circle(4.5, 8.2, 1.6)),
  ].filter(Boolean),
  mic: (k) => [
    P(k === '01' ? 'blue' : 'dgray', [rect(5.5, 3.5, 5, 4.5), circle(8, 3.5, 2.5), circle(8, 8, 2.5)]),
    ink([arc(8, 7.5, 4.6, 1.1, 0, 180), rect(7.5, 12, 1, 2.2), rect(5, 14, 6, 1)], { c: k === '01' ? 'dgray' : 'black' }),
  ],
  // teardrop map pin: wide head tapering to a point; the dot is a filled white disc in colour skins (a hole read as a ring)
  location: (k) => k === '94'
    ? [P('red', [circle(8, 6.2, 5.2), poly([3.1, 8.4], [12.9, 8.4], [8, 15.7])], { h: [circle(8, 6.2, 1.6)] })]
    : [P('red', [circle(8, 6.2, 5.2), poly([3.1, 8.4], [12.9, 8.4], [8, 15.7])]), P('white', circle(8, 6.2, 2))],
  bell: (k) => [
    P(k === '01' ? 'gold' : 'yellow', [circle(8, 6.5, 4.4), rect(3.6, 6.5, 8.8, 4.5), rect(1.8, 11, 12.4, 1.8)]),
    P(k === '01' ? 'gold' : 'yellow', [circle(8, 14, 1.3), circle(8, 1.8, 0.9)], { o94: 'solid' }),
  ],
  clipboard: (k) => [
    P(k === '01' ? 'gold' : 'olive', rect(2.5, 2.5, 11, 12.5)),
    k === '94' ? null : P('white', rect(4.2, 5, 7.6, 8.4)),
    k === '94' ? ink([rect(5, 7, 6, 1), rect(5, 9.5, 6, 1), rect(5, 12, 4, 1)]) : ink([rect(5.2, 7, 5.6, 0.9), rect(5.2, 9.3, 5.6, 0.9), rect(5.2, 11.5, 4, 0.9)], { c: 'dgray' }),
    P('gray', rect(5.5, 1, 5, 3)),
  ].filter(Boolean),
}

// toolbar-size names that also get a 24px pixel version in y1997
export const TOOLBAR_24 = ['back', 'forward', 'reload', 'stop', 'home', 'newtab', 'menu', 'profile', 'incognito', 'find',
  'search', 'download', 'history', 'settings', 'bookmark', 'bookmark-filled', 'go']

// ---------- palettes ----------
const C97 = { blue: '#0000FF', navy: '#000080', green: '#008000', lime: '#00FF00', red: '#FF0000', maroon: '#800000',
  gold: '#D9A21B', yellow: '#FFFF00', olive: '#808000', gray: '#C0C0C0', dgray: '#808080', white: '#FFFFFF',
  black: '#000000', teal: '#008080', cyan: '#00FFFF', purple: '#800080', violet: '#800080', whiteA: '#FFFFFF' }
const HI97 = { '#C0C0C0': '#FFFFFF', '#FFFF00': '#FFFFFF', '#D9A21B': '#FFFF00', '#0000FF': '#00FFFF', '#FF0000': '#FFFFFF',
  '#00FFFF': '#FFFFFF', '#008080': '#00FFFF', '#008000': '#00FF00', '#800000': '#FF0000', '#800080': '#FF00FF',
  '#808000': '#FFFF00', '#808080': '#C0C0C0', '#00FF00': '#FFFFFF' }
const SH97 = { '#C0C0C0': '#808080', '#FFFFFF': '#C0C0C0', '#FFFF00': '#808000', '#D9A21B': '#808000', '#0000FF': '#000080',
  '#FF0000': '#800000', '#00FFFF': '#008080', '#00FF00': '#008000', '#808080': '#000000' }

const H01 = { blue: ['#6FA0F5', '#1A4FB8'], green: ['#5DBB4C', '#2C7F22'], gold: ['#FFE07A', '#D9A21B'], red: ['#F06B5E', '#A3241A'],
  gray: ['#FFFFFF', '#B5B09A'], violet: ['#A08CF0', '#5A3FC0'], white: ['#FFFFFF', '#E6E2D2'] }
const ALIAS01 = { navy: 'blue', teal: 'blue', cyan: 'blue', maroon: 'red', yellow: 'gold', olive: 'gold', dgray: 'gray',
  purple: 'violet', lime: 'green', black: 'gray' }
const INK01 = { black: '#2E2C26', white: '#FFFFFF', whiteA: 'rgba(255,255,255,.75)', dgray: '#6B6656', blue: '#1A4FB8',
  green: '#2C7F22', red: '#A3241A', gray: '#7F7A66', knock: '#FFFFFF' }
const outline01 = (h) => (h === 'gray' || h === 'white' ? '#7F7A66' : mix(H01[h][1], '#000000', 0.28))

// ---------- renderers ----------
export function render94(name) {
  const parts = ICONS[name]('94')
  const g = new Grid(16, 16)
  for (const p of parts) {
    if (p.o94 === 'skip') continue
    const m = mask(16, 16, p.s, 1, p.h)
    const solid = p.ink || p.o94 === 'solid'
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (!m.get(x, y)) continue
      const edge = !m.get(x - 1, y) || !m.get(x + 1, y) || !m.get(x, y - 1) || !m.get(x, y + 1)
      if (p.c === 'knock') { g.px[y * 16 + x] = null; continue }
      if (solid || edge) g.set(x, y, '#000000')
      else if (p.clearInside) g.px[y * 16 + x] = null
    }
  }
  return svgDoc(16, 16, gridToSvgBody(g), ' shape-rendering="crispEdges"')
}

export function render97(name, size = 16) {
  const parts = ICONS[name]('97')
  const s = size / 16
  const g = new Grid(size, size)
  const inkSet = new Set()
  for (const p of parts) {
    const col = p.c97 || C97[p.c] || p.c
    const m = mask(size, size, p.s, s, p.h)
    const asInk = p.ink || col === '#000000'
    for (let i = 0; i < m.px.length; i++) if (m.px[i]) { g.px[i] = col; if (asInk) inkSet.add(i); else inkSet.delete(i) }
  }
  // 1px black outline around the silhouette (8-neighborhood)
  const out = new Grid(size, size); out.px = g.px.slice()
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (g.get(x, y)) continue
    let n = false
    for (let dy = -1; dy <= 1 && !n; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy
      if ((dx || dy) && g.get(xx, yy) && !inkSet.has(yy * size + xx)) { n = true; break }
    }
    if (n) out.set(x, y, '#000000')
  }
  // light from top-left
  const res = new Grid(size, size); res.px = out.px.slice()
  const edgeOf = (x, y) => { const c = out.get(x, y); return !c || c === '#000000' }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, c = out.get(x, y)
    if (!c || c === '#000000' || inkSet.has(i) || !g.get(x, y)) continue
    const tl = edgeOf(x - 1, y) || edgeOf(x, y - 1), br = edgeOf(x + 1, y) || edgeOf(x, y + 1)
    if (tl && !br && HI97[c]) res.px[i] = HI97[c]
    else if (br && !tl && SH97[c]) res.px[i] = SH97[c]
  }
  return svgDoc(size, size, gridToSvgBody(res), ' shape-rendering="crispEdges"')
}

export function render01(name) {
  const parts = ICONS[name]('01')
  const S = 1.375
  let defs = '', shadow = '', body = ''
  const all = []
  parts.forEach((p, i) => {
    const id = `${name}-${i}`
    const hueKey = p.c01 || ALIAS01[p.c] || p.c
    if (p.ink) {
      const col = INK01[p.c] || INK01[hueKey] || '#2E2C26'
      body += p.s.map((sh) => shapeToSvg(sh, S, ` fill="${col}"`)).join('')
      all.push(...p.s)
      return
    }
    const [lt, dk] = H01[hueKey] || H01.gray
    const bb = bbox(p.s)
    defs += `<linearGradient id="g${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${(bb.y0 * S).toFixed(2)}" x2="0" y2="${(bb.y1 * S).toFixed(2)}">` +
      `<stop offset="0" stop-color="${mix(lt, '#FFFFFF', 0.45)}"/><stop offset=".46" stop-color="${lt}"/>` +
      `<stop offset=".54" stop-color="${mix(lt, dk, 0.55)}"/><stop offset="1" stop-color="${dk}"/></linearGradient>`
    let m = ''
    if (p.h.length) {
      defs += `<mask id="m${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/>` +
        p.h.map((h) => shapeToSvg(h, S, ' fill="#000"')).join('') + '</mask>'
      m = ` mask="url(#m${id})"`
    }
    const ol = outline01(hueKey)
    body += `<g${m}>` + p.s.map((sh) => shapeToSvg(sh, S, ` fill="${ol}" stroke="${ol}" stroke-width="2" stroke-linejoin="round"`)).join('') +
      p.s.map((sh) => shapeToSvg(sh, S, ` fill="url(#g${id})"`)).join('') + '</g>'
    if (p.h.length) body += p.h.map((h) => shapeToSvg(h, S, ` fill="none" stroke="${ol}" stroke-width="1"`)).join('')
    all.push(...p.s)
  })
  shadow = `<g transform="translate(0 1)" opacity=".25" fill="#000" stroke="#000" stroke-width="2" stroke-linejoin="round">` +
    all.map((sh) => shapeToSvg(sh, S)).join('') + '</g>'
  // shadow sits under everything; strokes on the shadow keep it as wide as the outlined icon
  return svgDoc(24, 24, (defs ? `<defs>${defs}</defs>` : '') + `<g transform="translate(1 0.5)">${shadow}${body}</g>`)
}
