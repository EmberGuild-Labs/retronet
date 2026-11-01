// Hidden era pages (PLAN-FINAL 1.3, D-B1/D-B2). One per skin, served at retronet://<slug>/ from
// src/renderer/pages/<slug>/. The egg hosts are deliberately NOT in PAGE_HOSTS: they get no bridge and the router
// refuses every call from them. Plain constants only, so the renderer can import this without zod.
// scripts/check-assets.mjs scans this file: slugs and titles must stay clear of TRADEMARK_RE.
import type { SkinId } from './skins'

export const EGG_HOSTS = ['firstweb', 'cascade', 'clamshell', 'wikiwiki'] as const
export type EggHost = (typeof EGG_HOSTS)[number]

export interface EggPage {
  slug: EggHost
  title: string
}

/** The egg for each era (EGGS.md; titles from DESIGN-EGGS 1.2). Hints open the current skin's egg. */
export const EGG_PAGES: Readonly<Record<SkinId, EggPage>> = Object.freeze({
  y1994: { slug: 'firstweb', title: 'Where the Web Woke Up' },
  y1997: { slug: 'cascade', title: 'Comets, Couches and Cascades' },
  y1999: { slug: 'clamshell', title: 'Candy Shells and Web Standards' },
  y2001: { slug: 'wikiwiki', title: 'Wiki Wiki: the Quick Web' }
})

const EGG_HOST_SET: ReadonlySet<string> = new Set(EGG_HOSTS)

/** `retronet://<slug>/` for an era, or null for anything that is not a known era. */
export function eggUrl(era: SkinId): string | null {
  if (!Object.hasOwn(EGG_PAGES, era)) return null
  return `retronet://${EGG_PAGES[era].slug}/`
}

/** True for any retronet:// URL whose host is an egg (any path, query or fragment). */
export function isEggUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'retronet:' && EGG_HOST_SET.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}
