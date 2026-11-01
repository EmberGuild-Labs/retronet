// Hand-rolled subsequence scorer for the command palette (PLAN T20: no dependency). Every query character must
// appear in order. Matches at word starts and runs of consecutive characters score high, gaps cost a little,
// so "inc" ranks "New <inc>ognito window" above "Zoom <in> ... <c>" style scattered hits.
// O(query x text) per candidate via a running maximum, fast enough for every keystroke over ~100 rows.

export interface FuzzyMatch {
  score: number
  /** Indices into the text of the matched characters, ascending (for <mark> highlighting). */
  positions: number[]
}

const MATCH = 1
const WORD_START = 8
const FIRST_CHAR = 4
const CONSECUTIVE = 6
const GAP = 0.5
const NEG = -1e9

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]!
  const cur = text[i]!
  if (/[\s\-_.:/()]/.test(prev)) return true
  // camelCase / digit boundaries
  return /[a-z]/.test(prev) && /[A-Z]/.test(cur)
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return { score: 0, positions: [] }
  const t = text.toLowerCase()
  const n = t.length
  const m = q.length
  if (m > n) return null

  // best[i][j]: best score with q[i] matched at t[j]; from[i][j]: where q[i-1] was matched.
  const best: Float64Array[] = []
  const from: Int32Array[] = []
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(NEG)
    const back = new Int32Array(n).fill(-1)
    const prev = i > 0 ? best[i - 1]! : null
    // running max of prev[k] + GAP*k over k <= j - 2 (non-adjacent predecessor), with its index
    let runMax = NEG
    let runIdx = -1
    for (let j = 0; j < n; j++) {
      if (prev && j >= 2 && prev[j - 2]! > NEG) {
        const v = prev[j - 2]! + GAP * (j - 2)
        if (v > runMax) {
          runMax = v
          runIdx = j - 2
        }
      }
      if (t[j] !== q[i]) continue
      const gain = MATCH + (isWordStart(text, j) ? (i === 0 ? WORD_START : WORD_START / 2) : 0) + (j === 0 ? FIRST_CHAR : 0)
      if (!prev) {
        row[j] = gain - GAP * j * 0.2
        continue
      }
      let score = NEG
      let src = -1
      if (j >= 1 && prev[j - 1]! > NEG) {
        score = prev[j - 1]! + CONSECUTIVE
        src = j - 1
      }
      if (runIdx >= 0) {
        const s = runMax - GAP * (j - 1) // = prev[k] - GAP * (j - 1 - k)
        if (s > score) {
          score = s
          src = runIdx
        }
      }
      if (src < 0) continue
      row[j] = score + gain
      back[j] = src
    }
    best.push(row)
    from.push(back)
  }

  const last = best[m - 1]!
  let end = -1
  let top = NEG
  for (let j = 0; j < n; j++) {
    if (last[j]! > top) {
      top = last[j]!
      end = j
    }
  }
  if (end < 0) return null
  const positions = new Array<number>(m)
  for (let i = m - 1, j = end; i >= 0; i--) {
    positions[i] = j
    j = from[i]![j]!
  }
  // Shorter labels win ties ("New tab" over "New tab group ...").
  return { score: top - n * 0.01, positions }
}

/** Splits `text` into plain and matched runs for rendering with <mark>. */
export function highlightRuns(text: string, positions: readonly number[]): Array<{ text: string; mark: boolean }> {
  const runs: Array<{ text: string; mark: boolean }> = []
  const hit = new Set(positions)
  for (let i = 0; i < text.length; i++) {
    const mark = hit.has(i)
    const tail = runs[runs.length - 1]
    if (tail && tail.mark === mark) tail.text += text[i]
    else runs.push({ text: text[i]!, mark })
  }
  return runs
}
