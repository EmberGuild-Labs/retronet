import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const r = (p: string): string => resolve(__dirname, p)

const PAGES = [
  'newtab',
  'history',
  'bookmarks',
  'downloads',
  'settings',
  'shortcuts',
  'about',
  'certerror',
  'neterror'
] as const

const alias = { '@shared': r('src/shared') }

// Output layout (PLAN 1.6): out/renderer/{shell,overlay}/index.html and out/renderer/pages/<host>/index.html.
// Preloads are sandboxed, so each must be a single CommonJS file (no "type":"module" in package.json).
export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: { input: { index: r('src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      rollupOptions: {
        input: { shell: r('src/preload/shell.ts'), internal: r('src/preload/internal.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: r('src/renderer'),
    base: './',
    publicDir: r('src/renderer/public'),
    resolve: { alias },
    build: {
      outDir: r('out/renderer'),
      emptyOutDir: true,
      sourcemap: false,
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          shell: r('src/renderer/shell/index.html'),
          overlay: r('src/renderer/overlay/index.html'),
          ...Object.fromEntries(PAGES.map((p) => [`pages/${p}`, r(`src/renderer/pages/${p}/index.html`)]))
        }
      }
    }
  }
})
