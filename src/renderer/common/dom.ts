// Tiny DOM helpers: h() builds elements without innerHTML (CSP and XSS safe), keyedList() reconciles a
// list of children by key so re-renders reuse nodes (30-tab strip without thrash).

type Child = Node | string | number | false | null | undefined
type Handler = (ev: Event) => void

export interface Props {
  class?: string | Array<string | false | null | undefined>
  text?: string
  /** Attributes; `false`/`null`/`undefined` removes, `true` sets an empty attribute. */
  attrs?: Record<string, string | number | boolean | null | undefined>
  /** data-* attributes, camelCase keys as in `el.dataset`. */
  data?: Record<string, string | number | boolean | null | undefined>
  on?: Partial<Record<keyof HTMLElementEventMap, Handler>>
}

export function setClass(el: Element, cls: Props['class']): void {
  el.className = Array.isArray(cls) ? cls.filter(Boolean).join(' ') : (cls ?? '')
}

export function setAttrs(el: Element, attrs: Props['attrs']): void {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) el.removeAttribute(k)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
}

export function setData(el: HTMLElement, data: Props['data']): void {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === false || v === null || v === undefined) delete el.dataset[k]
    else el.dataset[k] = String(v)
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props.class !== undefined) setClass(el, props.class)
  setAttrs(el, props.attrs)
  setData(el, props.data)
  for (const [type, fn] of Object.entries(props.on ?? {})) if (fn) el.addEventListener(type, fn)
  if (props.text !== undefined) el.textContent = props.text
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue
    el.append(typeof c === 'number' ? String(c) : c)
  }
  return el
}

/** `<span class="rn-icon" data-icon="name" aria-hidden="true">` (icons are skin CSS, PLAN 1.13). */
export function icon(name: string): HTMLSpanElement {
  return h('span', { class: 'rn-icon', data: { icon: name }, attrs: { 'aria-hidden': 'true' } })
}

export interface KeyedList<T> {
  update(items: readonly T[]): void
  get(key: string): HTMLElement | undefined
}

/**
 * Keeps `container`'s children in step with `items`. `create` runs once per new key, `patch` on every
 * update (including right after create). Nodes for removed keys are dropped; order follows `items`.
 */
export function keyedList<T>(
  container: HTMLElement,
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  patch: (el: HTMLElement, item: T) => void
): KeyedList<T> {
  let nodes = new Map<string, HTMLElement>()
  return {
    update(items) {
      const next = new Map<string, HTMLElement>()
      let cursor: ChildNode | null = container.firstChild
      for (const item of items) {
        const k = key(item)
        if (next.has(k)) continue
        const el = nodes.get(k) ?? create(item)
        patch(el, item)
        next.set(k, el)
        if (el === cursor) cursor = cursor.nextSibling
        else container.insertBefore(el, cursor)
      }
      for (const [k, el] of nodes) if (!next.has(k)) el.remove()
      nodes = next
    },
    get: (k) => nodes.get(k)
  }
}
