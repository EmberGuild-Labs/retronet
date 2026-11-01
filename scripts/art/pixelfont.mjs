// Two tiny hand-drawn pixel alphabets, original to RetroNet (only the glyphs the art needs).
// SMALL: 5px caps. TALL: 8px caps, 6px x-height, 2px descenders (rows 8-9).
const SMALL = {
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  I: ['#', '#', '#', '#', '#'],
  W: ['#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
}
const x = (rows) => ['', ''].concat(rows) // lowercase starts at row 2
const TALL = {
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#.#.#', '#..##', '#..##', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  A: ['.###.', '#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  e: x(['.##.', '#..#', '####', '#...', '#..#', '.##.']),
  t: ['.#.', '.#.', '###', '.#.', '.#.', '.#.', '.#.', '..#'],
  r: x(['#.##', '##..', '#...', '#...', '#...', '#...']),
  o: x(['.##.', '#..#', '#..#', '#..#', '#..#', '.##.']),
  a: x(['.##.', '...#', '.###', '#..#', '#..#', '.###']),
  g: x(['.###', '#..#', '#..#', '#..#', '#..#', '.###', '...#', '.##.']),
  p: x(['###.', '#..#', '#..#', '#..#', '#..#', '###.', '#...', '#...']),
  l: ['#.', '#.', '#.', '#.', '#.', '#.', '#.', '.#'],
  i: ['#', '.', '#', '#', '#', '#', '#', '#'],
  c: x(['.##.', '#..#', '#...', '#...', '#..#', '.##.']),
  s: x(['.###', '#...', '.##.', '...#', '...#', '###.']),
  n: x(['###.', '#..#', '#..#', '#..#', '#..#', '#..#']),
}
const FONTS = { small: { g: SMALL, space: 2 }, tall: { g: TALL, space: 3 } }

// Returns { w, h, pixels: [[x,y],...] } for a string. gap = pixels between glyphs.
export function layout(text, font = 'tall', gap = 1) {
  const F = FONTS[font]
  let cx = 0, h = 0
  const pixels = []
  for (const ch of text) {
    if (ch === ' ') { cx += F.space; continue }
    const g = F.g[ch]
    if (!g) throw new Error(`pixelfont: no glyph "${ch}" in ${font}`)
    const w = Math.max(...g.map((r) => r.length))
    g.forEach((row, y) => [...row].forEach((c, xx) => { if (c === '#') pixels.push([cx + xx, y]) }))
    h = Math.max(h, g.length)
    cx += w + gap
  }
  return { w: cx - gap, h, pixels }
}

// SVG path (unit squares) for the text at (ox, oy) with integer scale.
export function textPath(text, font, ox, oy, scale = 1, gap = 1) {
  const L = layout(text, font, gap)
  return { ...L, d: L.pixels.map(([px, py]) => `M${ox + px * scale} ${oy + py * scale}h${scale}v${scale}h${-scale}z`).join('') }
}
