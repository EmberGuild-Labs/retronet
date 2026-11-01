// RetroNet brand art: the "Sunrise Window" mark (DESIGN §4.1), small pixel variants,
// wordmark, the 88x31 badge (§4.2) and the dmg background. All original.
import { Grid, gridToSvgBody, svgDoc } from './lib.mjs'
import { textPath } from './pixelfont.mjs'

const C = { indigoTop: '#2B2160', indigoBot: '#120D33', gray: '#C9CCD2', white: '#FFFFFF', shade: '#5E636C', ink: '#0B0820',
  strip0: '#24438C', strip1: '#3B6FD6', sky0: '#1B1446', sky1: '#B33A7A', sky2: '#F08A24', sun: '#FFD24A', sunLow: '#FFB000',
  cream: '#F3E6C8', title: '#E9EBEE' }

// ---------- 1024 master ----------
export function logoMaster() {
  const cx = 512, hy = 728, B = 24
  // stepped sun: 7 rows of 24px
  let sun = ''
  for (let i = 0; i < 7; i++) {
    const dy = B * i + B / 2
    const hw = Math.round(Math.sqrt(168 ** 2 - dy ** 2) / B) * B
    if (hw <= 0) continue
    sun += `<rect x="${cx - hw}" y="${hy - B * (i + 1)}" width="${2 * hw}" height="${B}" fill="${i < 3 ? C.sunLow : C.sun}"/>`
  }
  // stepped arcs on the same 24px grid (cell edges at 512 + 24k, 728 - 24j)
  let arcs = ''
  ;[[232, 1], [296, 0.75], [360, 0.5]].forEach(([r, op]) => {
    let d = ''
    for (let j = 0; j < 20; j++) for (let k = -20; k < 20; k++) {
      const x = cx + B * k, y = hy - B * (j + 1)
      const mx = x + B / 2 - cx, my = hy - (y + B / 2)
      const dist = Math.hypot(mx, my), ang = (Math.atan2(my, mx) * 180) / Math.PI
      if (Math.abs(dist - r) < B / 2 && ang >= 25 && ang <= 155) d += `M${x} ${y}h${B}v${B}h-${B}z`
    }
    arcs += `<path fill="${C.cream}" fill-opacity="${op}" d="${d}"/>`
  })
  const body = `
<defs>
  <linearGradient id="rn-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.indigoTop}"/><stop offset="1" stop-color="${C.indigoBot}"/></linearGradient>
  <linearGradient id="rn-strip" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.strip0}"/><stop offset="1" stop-color="${C.strip1}"/></linearGradient>
  <linearGradient id="rn-sky" gradientUnits="userSpaceOnUse" x1="0" y1="344" x2="0" y2="720"><stop offset="0" stop-color="${C.sky0}"/><stop offset=".55" stop-color="${C.sky1}"/><stop offset="1" stop-color="${C.sky2}"/></linearGradient>
  <filter id="rn-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#000" flood-opacity=".3"/></filter>
  <clipPath id="rn-view"><rect x="244" y="344" width="536" height="376"/></clipPath>
  <mask id="rn-cuts" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#fff"/><rect x="0" y="668" width="1024" height="12" fill="#000"/><rect x="0" y="700" width="1024" height="16" fill="#000"/></mask>
</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#rn-body)" filter="url(#rn-shadow)"/>
<g shape-rendering="crispEdges">
  <rect x="212" y="232" width="600" height="520" fill="${C.ink}"/>
  <rect x="218" y="238" width="588" height="508" fill="${C.white}"/>
  <path fill="${C.shade}" d="M806 238V746H218L230 734H794V250Z"/>
  <rect x="230" y="250" width="564" height="484" fill="${C.gray}"/>
  <rect x="236" y="256" width="552" height="64" fill="url(#rn-strip)"/>
  <rect x="260" y="280" width="144" height="16" fill="${C.title}"/>
  <rect x="732" y="268" width="40" height="40" fill="${C.white}"/>
  <path fill="${C.shade}" d="M772 268V308H732L736 304H768V272Z"/>
  <rect x="736" y="272" width="32" height="32" fill="${C.gray}"/>
  <rect x="236" y="336" width="552" height="392" fill="${C.shade}"/>
  <path fill="${C.white}" d="M788 336V728H236L244 720H780V344Z"/>
  <rect x="244" y="344" width="536" height="376" fill="url(#rn-sky)"/>
  <g clip-path="url(#rn-view)">${arcs}<g mask="url(#rn-cuts)">${sun}</g></g>
  <rect x="236" y="720" width="552" height="8" fill="${C.ink}"/>
</g>`
  return svgDoc(1024, 1024, body)
}

// ---------- 32px pixel variant ----------
export function logo32() {
  const g = new Grid(32, 32)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    // stepped sun dome, center (16,27) r9 (one row per pixel, low rows deeper orange)
    if (y < 27) {
      const dy = 27 - y - 0.5, hw = Math.round(Math.sqrt(Math.max(0, 81 - dy * dy)))
      if (hw > 0 && x >= 16 - hw && x < 16 + hw) { g.set(x, y, y >= 25 ? C.sunLow : C.sun); continue }
    }
    const mx = x + 0.5 - 16, my = 27 - (y + 0.5)
    const d = Math.hypot(mx, my), a = (Math.atan2(my, mx) * 180) / Math.PI
    if (d >= 12 && d < 14 && a >= 30 && a <= 150) g.set(x, y, C.cream)
    if (y === 27) g.set(x, y, C.ink)
  }
  const body = `<defs><linearGradient id="rn32" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.sky0}"/><stop offset="1" stop-color="${C.sky1}"/></linearGradient>` +
    `<clipPath id="rn32c"><rect width="32" height="32" rx="6"/></clipPath></defs>` +
    `<rect width="32" height="32" rx="6" fill="url(#rn32)"/><g clip-path="url(#rn32c)" shape-rendering="crispEdges">${gridToSvgBody(g)}</g>`
  return svgDoc(32, 32, body)
}

// ---------- 16px pixel map (DESIGN §4.1) ----------
const MAP16 = [
  '.IIIIIIIIIIIIII.', 'IIIIIIIIIIIIIIII', 'IIIICCCCCCCCIIII', 'IIICIIIIIIIICIII', 'IICIIICCCCIIICII', 'IIIIICIIIICIIIII',
  'IIIIIIIIIIIIIIII', 'IMMMMMMSSMMMMMMI', 'MMMMMSSSSSSMMMMM', 'MMMMSSSSSSSSMMMM', 'MMMSSSSSSSSSSMMM', 'MMMSSSSSSSSSSMMM',
  'KKKKKKKKKKKKKKKK', 'IIIIIIIIIIIIIIII', 'IIIIIIIIIIIIIIII', '.IIIIIIIIIIIIII.']
const MAP_C = { I: '#1B1446', M: '#B33A7A', S: '#FFD24A', C: '#F3E6C8', K: '#0B0820' }
export function grid16() {
  const g = new Grid(16, 16)
  MAP16.forEach((row, y) => [...row].forEach((ch, x) => { if (MAP_C[ch]) g.set(x, y, MAP_C[ch]) }))
  return g
}
export const logo16 = () => svgDoc(16, 16, gridToSvgBody(grid16()), ' shape-rendering="crispEdges"')

// ---------- wordmark ----------
export function wordmark(fill) {
  const t = textPath('RetroNet', 'tall', 0, 0, 1)
  return svgDoc(t.w, 8, `<path fill="${fill}" d="${t.d}"/>`, ' shape-rendering="crispEdges"')
}

// ---------- 88x31 badge ----------
export function badge() {
  const l1 = textPath('BEST VIEWED IN', 'small', 0, 0, 1, 1)
  const l2w = textPath('RetroNet', 'tall', 0, 0, 1).w
  const fx = 31, fw = 55
  const x1 = fx + Math.floor((fw - l1.w) / 2), x2 = fx + Math.floor((fw - l2w) / 2)
  const t1 = textPath('BEST VIEWED IN', 'small', x1, 7, 1, 1)
  const t2 = textPath('RetroNet', 'tall', x2, 15, 1)
  const t2s = textPath('RetroNet', 'tall', x2 + 1, 16, 1)
  const mark = gridToSvgBody(grid16(), 8, 7)
  const body = `<defs><linearGradient id="rnb" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1B1446"/><stop offset="1" stop-color="#B33A7A"/></linearGradient></defs>` +
    `<rect width="88" height="31" fill="#000000"/>` +
    `<rect x="1" y="1" width="86" height="29" fill="#FFFFFF"/><path fill="#5E636C" d="M86 1h1v29H1v-1h85z"/>` +
    `<rect x="2" y="2" width="28" height="27" fill="#1B1446"/>${mark}` +
    `<rect x="30" y="2" width="1" height="27" fill="#0B0820"/>` +
    `<rect x="${fx}" y="2" width="${fw}" height="27" fill="url(#rnb)"/>` +
    `<path fill="#F3E6C8" d="${t1.d}"/><path fill="#0B0820" d="${t2s.d}"/><path fill="#FFD24A" d="${t2.d}"/>`
  return svgDoc(88, 31, body, ' shape-rendering="crispEdges"')
}

// ---------- dmg background 660x400 ----------
export function dmgBackground() {
  const label = 'Drag RetroNet to Applications'
  const w = textPath(label, 'tall', 0, 0, 2).w * 2
  const t = textPath(label, 'tall', Math.round((660 - w) / 2), 300, 2)
  // chunky 4-step arrow from the app slot (x=180) to the Applications slot (x=480) at y=200
  const arrow = `<rect x="262" y="192" width="100" height="16"/>` +
    [[362, 48], [374, 36], [386, 24], [398, 12]].map(([x, h]) => `<rect x="${x}" y="${200 - h / 2}" width="12" height="${h}"/>`).join('')
  const body = `<rect width="660" height="400" fill="#C0C0C0"/>` +
    `<rect x="16" y="16" width="627" height="367" fill="none" stroke="#808080" stroke-width="2" transform="translate(-1 -1)"/>` +
    `<rect x="18" y="18" width="627" height="367" fill="none" stroke="#FFFFFF" stroke-width="2" transform="translate(-1 -1)"/>` +
    `<g fill="#000080">${arrow}</g><path fill="#000000" d="${t.d}"/>`
  return svgDoc(660, 400, body, ' shape-rendering="crispEdges"')
}
