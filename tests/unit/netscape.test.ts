import { describe, expect, it } from 'vitest'
import {
  MAX_IMPORT_BOOKMARKS,
  MAX_IMPORT_DEPTH,
  MAX_NETSCAPE_BYTES,
  MAX_TITLE_LEN,
  MAX_URL_LEN,
  decodeEntities,
  parseNetscape,
  serializeNetscape,
  type ExportNode,
  type ImportFolder,
  type ImportNode
} from '../../src/main/bookmarks/netscape'

const CHROME = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000" LAST_MODIFIED="1600000001" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1600000002" ICON="data:image/png;base64,AAAA">Example &amp; Co</A>
        <DT><H3 ADD_DATE="1600000003">Sub</H3>
        <DL><p>
            <DT><A HREF="http://sub.example.org/a?b=1&amp;c=2" ADD_DATE="1600000004">Deep</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://other.example/" ADD_DATE="1600000005">Other</A>
</DL><p>
`

const FIREFOX = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; img-src data: *; object-src 'none'"></meta>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
    <DT><H3 ADD_DATE="1500000000" LAST_MODIFIED="1500000001" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DD>The toolbar description
    <DL><p>
        <DT><A HREF="https://mozilla.org/" ADD_DATE="1500000002" LAST_MODIFIED="1500000003" ICON_URI="fake-favicon-uri:https://mozilla.org/" ICON="data:image/png;base64,iVBOR">Mozilla</A>
        <DD>A description with <b>tags</b>
        <DT><A HREF="place:sort=8&amp;maxResults=10" ADD_DATE="1500000004">Recent</A>
    </DL><p>
</DL>
`

describe('parseNetscape fixtures', () => {
  it('Chrome-style: nested folders, entities, toolbar flag, dates', () => {
    const r = parseNetscape(CHROME)
    expect(r.error).toBeUndefined()
    expect(r.stats).toMatchObject({ imported: 3, folders: 2, skippedTotal: 0, truncated: false })
    expect(r.roots).toHaveLength(2)
    const bar = r.roots[0] as ImportFolder
    expect(bar).toMatchObject({ kind: 'folder', title: 'Bookmarks bar', toolbar: true, addedAt: 1600000000000 })
    expect(bar.children[0]).toMatchObject({ kind: 'bookmark', title: 'Example & Co', url: 'https://example.com/', addedAt: 1600000002000 })
    const sub = bar.children[1] as ImportFolder
    expect(sub.title).toBe('Sub')
    expect(sub.children[0]).toMatchObject({ title: 'Deep', url: 'http://sub.example.org/a?b=1&c=2' })
    expect(r.roots[1]).toMatchObject({ kind: 'bookmark', title: 'Other' })
  })

  it('Firefox-style: <DD>, ICON_URI, missing </DL>, place: skipped and counted', () => {
    const r = parseNetscape(FIREFOX)
    expect(r.stats.imported).toBe(1)
    expect(r.stats.skipped.place).toBe(1)
    const bar = r.roots[0] as ImportFolder
    expect(bar.toolbar).toBe(true)
    expect(bar.children).toHaveLength(1)
    expect(bar.children[0]).toMatchObject({ title: 'Mozilla', url: 'https://mozilla.org/' })
  })

  it('Safari-ish: no doctype, lowercase, no <p>, single quotes and unquoted attributes', () => {
    const r = parseNetscape(`<html><body><dl>
<dt><h3 folded>Favorites</h3>
<dl>
<dt><a href='https://apple.com/'>Apple</a>
<dt><a href=https://example.net/x add_date=1700000000>Unquoted</a>
</dl>
</dl>`)
    expect(r.stats).toMatchObject({ imported: 2, folders: 1 })
    const f = r.roots[0] as ImportFolder
    expect(f.children.map((c) => (c as { url: string }).url)).toEqual(['https://apple.com/', 'https://example.net/x'])
    expect((f.children[1] as { addedAt?: number }).addedAt).toBe(1700000000000)
  })

  it('broken HTML: missing closing tags, stray closers, unknown tags, comments', () => {
    const r = parseNetscape(
      `</DL></DL><DL><DT><H3>F<DL><DT><A HREF="https://a.example/">A<DT><A HREF="https://b.example/">B</A><!-- c --><foo bar="x>y"><DT><A HREF="https://c.example/">C<b>bold</b>`
    )
    expect(r.error).toBeUndefined()
    const f = r.roots[0] as ImportFolder
    expect(f.title).toBe('F')
    expect(f.children.map((c) => c.title)).toEqual(['A', 'B', 'Cbold'])
  })

  it('CRLF and BOM', () => {
    const r = parseNetscape('﻿' + CHROME.replace(/\n/g, '\r\n'))
    expect(r.stats.imported).toBe(3)
    expect((r.roots[0] as ImportFolder).title).toBe('Bookmarks bar')
  })

  it('wrapped hrefs and multi-line titles are normalised', () => {
    const r = parseNetscape('<DL><DT><A HREF="https://example.com/\r\n  path">Two\r\n lines</A></DL>')
    expect(r.roots[0]).toMatchObject({ url: 'https://example.com/path', title: 'Two lines' })
  })

  it('rejects files that are not bookmark files', () => {
    expect(parseNetscape('<html><body><p>hello</p></body></html>').error).toBe('not-bookmarks')
    expect(parseNetscape('').error).toBe('not-bookmarks')
  })
})

describe('scheme filtering and credentials', () => {
  it('keeps http(s) only and counts the rest by reason', () => {
    const urls = [
      'https://ok.example/', 'http://ok2.example/',
      'javascript:alert(1)', 'JavaScript:void(0)', 'file:///etc/passwd', 'ftp://f.example/', 'place:x=1',
      'data:text/html,<b>', 'retronet://settings/', 'mailto:a@b.c', 'about:blank', 'not a url', '', 'http://'
    ]
    const html = '<DL>' + urls.map((u, i) => `<DT><A HREF="${u.replace(/"/g, '&quot;')}">t${i}</A>`).join('') + '</DL>'
    const r = parseNetscape(html)
    expect(r.stats.imported).toBe(2)
    expect(r.stats.skipped).toMatchObject({ javascript: 2, file: 1, ftp: 1, place: 1, data: 1, retronet: 1, otherScheme: 2, invalid: 3, tooLong: 0 })
    expect(r.stats.skippedTotal).toBe(12)
  })

  it('strips URL credentials', () => {
    const r = parseNetscape('<DL><DT><A HREF="https://user:pw@example.com/p">x</A></DL>')
    expect((r.roots[0] as { url: string }).url).toBe('https://example.com/p')
  })

  it('skips over-long URLs, truncates long titles', () => {
    const long = 'https://example.com/' + 'a'.repeat(MAX_URL_LEN)
    const r = parseNetscape(`<DL><DT><A HREF="${long}">x</A><DT><A HREF="https://e.example/">${'T'.repeat(5000)}</A></DL>`)
    expect(r.stats.skipped.tooLong).toBe(1)
    expect((r.roots[0] as { title: string }).title).toHaveLength(MAX_TITLE_LEN)
  })

  it('entity-encoded scheme tricks do not slip through', () => {
    const r = parseNetscape('<DL><DT><A HREF="java&#115;cript:alert(1)">x</A><DT><A HREF="&#106;avascript&colon;1">y</A></DL>')
    expect(r.stats.imported).toBe(0)
    expect(r.stats.skipped.javascript).toBe(1)
  })
})

describe('entities', () => {
  it('decodes named and numeric references, leaves malformed ones', () => {
    expect(decodeEntities('a &amp; b &lt;i&gt; &quot;q&quot; &#39;s&#39; &#x41;&#66; &apos;')).toBe(`a & b <i> "q" 's' AB '`)
    expect(decodeEntities('&bogus; &amp &#; &#xZZ; &#0; &#x110000; &#xD800;')).toBe('&bogus; &amp &#; &#xZZ; � � �')
    expect(decodeEntities('&amp;lt;')).toBe('&lt;') // no double decoding
    expect(decodeEntities('no entities')).toBe('no entities')
  })
})

describe('caps and pathological input', () => {
  it('rejects oversize input before parsing', () => {
    const big = 'x'.repeat(MAX_NETSCAPE_BYTES + 1)
    const t = Date.now()
    expect(parseNetscape(big).error).toBe('too-large')
    expect(Date.now() - t).toBeLessThan(500)
    // multi-byte: fewer chars than bytes limit but over in UTF-8
    expect(parseNetscape('€'.repeat(Math.ceil(MAX_NETSCAPE_BYTES / 3) + 1)).error).toBe('too-large')
  })

  it('caps the number of bookmarks', () => {
    let s = '<DL>'
    for (let i = 0; i < MAX_IMPORT_BOOKMARKS + 50; i++) s += `<DT><A HREF="https://e.example/${i}">${i}</A>\n`
    const r = parseNetscape(s + '</DL>')
    expect(r.stats.imported).toBe(MAX_IMPORT_BOOKMARKS)
    expect(r.stats.truncated).toBe(true)
  })

  it('caps folder depth and keeps deeper bookmarks', () => {
    const depth = 500
    let s = ''
    for (let i = 0; i < depth; i++) s += `<DL><DT><H3>f${i}</H3>`
    s += '<DL><DT><A HREF="https://deep.example/">deep</A></DL>' + '</DL>'.repeat(depth)
    const r = parseNetscape(s)
    expect(r.stats.imported).toBe(1)
    let d = 0
    let cur: ImportNode[] = r.roots
    while (cur[0]?.kind === 'folder') {
      d++
      cur = (cur[0] as ImportFolder).children
    }
    expect(d).toBe(MAX_IMPORT_DEPTH)
    expect(cur[0]).toMatchObject({ kind: 'bookmark', title: 'deep' })
  })

  it('runaway <DL> nesting with no folders terminates quickly', () => {
    const t = Date.now()
    const r = parseNetscape('<DL>'.repeat(1_000_000) + '<DT><A HREF="https://a.example/">a</A>')
    expect(Date.now() - t).toBeLessThan(2000)
    expect(r.error).toBeUndefined()
  })

  it('quadratic traps stay linear: unterminated tags, quotes, comments', () => {
    const t = Date.now()
    parseNetscape('<a href="'.repeat(500_000))
    parseNetscape('<a "'.repeat(2_000_000) + '>')
    parseNetscape('<!-- '.repeat(1_500_000))
    parseNetscape('<DT><A HREF="https://a.example/">' + '&'.repeat(5_000_000))
    parseNetscape('<A HREF="https://a.example/">' + '<'.repeat(5_000_000))
    expect(Date.now() - t).toBeLessThan(3000)
  })

  it('parses a ~10 MB synthetic file in under 2 s', () => {
    const chunk = '<DT><A HREF="https://example.com/some/path?q=1&amp;r=2" ADD_DATE="1600000000" ICON="data:image/png;base64,AAAAAAAAAAAAAAAAAAAA">A title here</A>\n'
    let s = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n'
    while (s.length < MAX_NETSCAPE_BYTES - 200) s += chunk
    s += '</DL><p>\n'
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(MAX_NETSCAPE_BYTES)
    const t = Date.now()
    const r = parseNetscape(s)
    const ms = Date.now() - t
    expect(r.error).toBeUndefined()
    expect(r.stats.imported).toBe(MAX_IMPORT_BOOKMARKS)
    expect(r.stats.truncated).toBe(true)
    expect(ms).toBeLessThan(2000)
  })
})

describe('fuzz', () => {
  // deterministic PRNG so a failure is reproducible
  let seed = 12345
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const PIECES = ['<', '>', '</', '<DL>', '</DL>', '<DT>', '<p>', '<H3', '</H3>', '<A ', 'HREF=', '"', "'", '=', '&', '&#', ';', '&amp;', ' ',
    '\n', '\r\n', '\0', '﻿', 'https://x.example/', 'javascript:', '<!--', '-->', '<!', 'ADD_DATE="9', '\ud800', '€', '</A>', 'PERSONAL_TOOLBAR_FOLDER="true"']
  it('500 random strings never throw and finish fast', () => {
    const t = Date.now()
    for (let i = 0; i < 500; i++) {
      let s = ''
      const len = Math.floor(rnd() * 400)
      for (let j = 0; j < len; j++) {
        s += rnd() < 0.5 ? PIECES[Math.floor(rnd() * PIECES.length)] : String.fromCharCode(Math.floor(rnd() * 65536))
      }
      const r = parseNetscape(s)
      expect(r.stats.imported).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(r.roots)).toBe(true)
    }
    expect(Date.now() - t).toBeLessThan(5000)
  })

  it('non-string input is rejected, not thrown', () => {
    expect(parseNetscape(undefined as unknown as string).error).toBe('not-bookmarks')
    expect(parseNetscape(null as unknown as string).error).toBe('not-bookmarks')
  })
})

describe('serializeNetscape', () => {
  const bm = (title: string, url: string, createdAt = 1600000000000): ExportNode => ({ kind: 'bookmark', title, url, createdAt })
  const folder = (title: string, children: ExportNode[], createdAt = 1600000000000): ExportNode => ({ kind: 'folder', title, createdAt, children })

  it('writes the required header, toolbar folder and ADD_DATE in seconds', () => {
    const s = serializeNetscape({ bar: { children: [bm('A', 'https://a.example/')] }, other: { children: [bm('B', 'https://b.example/')] } })
    expect(s.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
    expect(s).toContain('charset=UTF-8')
    expect(s).toContain('PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>')
    expect(s).toContain('<A HREF="https://a.example/" ADD_DATE="1600000000">A</A>')
    expect(s.indexOf('Bookmarks bar')).toBeLessThan(s.indexOf('https://b.example/'))
  })

  it('escapes titles and URLs so nothing can inject markup', () => {
    const evil = `<script>alert(1)</script>"><img src=x onerror=alert(2)> & 'q'`
    const s = serializeNetscape({
      bar: { children: [bm(evil, 'https://e.example/?a="b"&c=<d>'), folder(evil, [])] },
      other: { children: [] }
    })
    expect(s).not.toContain('<script')
    expect(s).not.toContain('<img')
    expect(s).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;')
    expect(s).toContain('HREF="https://e.example/?a=&quot;b&quot;&amp;c=&lt;d&gt;"')
    // and it parses back to the same text
    const r = parseNetscape(s)
    const barKids = (r.roots[0] as ImportFolder).children
    expect(barKids[0]?.title).toBe(evil)
    expect((barKids[0] as { url: string }).url).toBe('https://e.example/?a="b"&c=<d>')
    expect(barKids[1]?.title).toBe(evil)
  })

  it('round trip preserves http(s) bookmarks and folder structure', () => {
    const tree = {
      bar: {
        children: [
          bm('One', 'https://one.example/'),
          folder('Work', [bm('Two & Three', 'http://two.example/a?b=1&c=2'), folder('Nested', [bm('Four', 'https://four.example/x')])]),
          bm('Script', 'javascript:alert(1)')
        ]
      },
      other: { children: [bm('Five', 'https://five.example/'), folder('Empty', [])] }
    }
    const r = parseNetscape(serializeNetscape(tree))
    expect(r.stats).toMatchObject({ imported: 4, folders: 4 })
    expect(r.stats.skipped.javascript).toBe(1)
    const strip = (nodes: ImportNode[]): unknown[] =>
      nodes.map((n) => (n.kind === 'folder' ? { f: n.title, c: strip(n.children) } : { t: n.title, u: n.url, at: n.addedAt }))
    expect(strip(r.roots)).toEqual([
      {
        f: 'Bookmarks bar',
        c: [
          { t: 'One', u: 'https://one.example/', at: 1600000000000 },
          { f: 'Work', c: [{ t: 'Two & Three', u: 'http://two.example/a?b=1&c=2', at: 1600000000000 }, { f: 'Nested', c: [{ t: 'Four', u: 'https://four.example/x', at: 1600000000000 }] }] }
        ]
      },
      { t: 'Five', u: 'https://five.example/', at: 1600000000000 },
      { f: 'Empty', c: [] }
    ])
    expect((r.roots[0] as ImportFolder).toolbar).toBe(true)
  })

  it('handles an empty tree and bad dates', () => {
    const s = serializeNetscape({ bar: { children: [] }, other: { children: [bm('x', 'https://x.example/', NaN)] } })
    expect(s).toContain('ADD_DATE="0"')
    expect(parseNetscape(s).stats.imported).toBe(1)
  })
})
