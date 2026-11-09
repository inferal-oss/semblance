// The viewer's platform and the key hints (#303): a server-rendered page marks the platform in its
// head, before the first paint, with the same reading of the platform the client mounts with; and a
// hint's box does not depend on it (only which spelling is seen does), so nothing moves when it is
// marked, late or never.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { documentParts, renderDocument } from '../src/server/document.ts'
import { compileStyles } from '../src/style/compile.ts'
import { isApple, markPlatform, PLATFORM_ATTRIBUTE, PLATFORM_SCRIPT } from '../src/web/platform.ts'
import { CAPTURE_SCRIPT } from '../src/web/takeover.ts'

const TEMPLATE = '<!doctype html><html><head><title>t</title></head><body><div id="app"></div></body></html>'

// navigator as browsers report it: [userAgentData.platform, platform, Apple?]
const PLATFORMS: [string | undefined, string | undefined, boolean][] = [
  ['macOS', 'MacIntel', true],
  [undefined, 'MacIntel', true], // Safari on a Mac, and an iPad that asks for desktop sites
  [undefined, 'iPhone', true],
  [undefined, 'iPad', true],
  [undefined, 'iPod touch', true],
  ['Windows', 'Win32', false],
  [undefined, 'Linux x86_64', false],
  ['Android', 'Linux armv81', false],
  ['Chrome OS', 'Linux x86_64', false],
  ['', 'MacIntel', true], // an empty UA-CH platform falls back to navigator.platform
  ['Windows', 'MacIntel', false], // UA-CH first
  [undefined, undefined, false],
]

const navigatorOf = (ch: string | undefined, platform: string | undefined) => ({
  ...(ch === undefined ? {} : { userAgentData: { platform: ch } }),
  ...(platform === undefined ? {} : { platform }),
})

/** Run the head script against `nav` in a fresh document: the root's platform attribute after it. */
function runScript(nav: object): string | null {
  const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>')
  new Function('navigator', 'document', PLATFORM_SCRIPT)(nav, document)
  return document.documentElement.getAttribute(PLATFORM_ATTRIBUTE)
}

describe('the viewer platform', () => {
  it('is Apple on macOS, iOS and iPadOS, alike in the head script and the client', () => {
    for (const [ch, platform, apple] of PLATFORMS) {
      const nav = navigatorOf(ch, platform)
      expect(isApple(nav), JSON.stringify(nav)).toBe(apple)
      expect(runScript(nav), JSON.stringify(nav)).toBe(apple ? 'apple' : null)
      const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>')
      markPlatform(document, nav)
      expect(document.documentElement.getAttribute(PLATFORM_ATTRIBUTE), JSON.stringify(nav)).toBe(apple ? 'apple' : null)
    }
  })

  it('is marked in a server-rendered head, ahead of the styles that read it', () => {
    const script = `<script>${PLATFORM_SCRIPT}</script>`
    for (const stylesheet of ['inline', { href: '/semblance.css' }] as const) {
      const doc = renderDocument(TEMPLATE, { html: '<p>hi</p>', css: 'p{}', lang: 'en', dir: 'ltr' }, { stylesheet })
      const head = doc.slice(0, doc.indexOf('</head>'))
      expect(head).toContain(script)
      expect(head.indexOf(script)).toBeLessThan(head.indexOf('data-sem-styles'))
      // Once, and the capture script still goes before the mount element.
      expect(doc.split(script).length).toBe(2)
      expect(doc).toContain(`<script>${CAPTURE_SCRIPT}</script><div id="app" data-sem-ssr>`)
    }
    // A streamed page's head carries it too.
    const [before] = documentParts(TEMPLATE, { lang: 'en', dir: 'ltr' }, { stylesheet: 'none' })
    expect(before).toContain(script)
  })
})

/** The compiled theme's rules: [selector, declarations]. */
function rules(css: string): [string, Map<string, string>][] {
  const out: [string, Map<string, string>][] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>()
    for (const d of m[2]!.split(/;(?=(?:[^']*'[^']*')*[^']*$)/)) {
      const at = d.indexOf(':')
      if (at > 0) decls.set(d.slice(0, at).trim(), d.slice(at + 1).trim())
    }
    out.push([m[1]!.trim(), decls])
  }
  return out
}

describe('a key hint', () => {
  const all = rules(compileStyles(loadStore('n3')))
  const PAIRS = [
    ['data-sem-shortcut-other', 'data-sem-shortcut-apple'],
    ['data-sem-key-hint', 'data-sem-key-hint-apple'],
  ]

  it('holds both spellings in one box, one line tall, the viewer\'s first', () => {
    const contents = all.filter(([, d]) => /attr\(data-sem-(shortcut|key-hint)/.test(d.get('content') ?? ''))
    expect(contents.length).toBe(4)
    for (const [selector, d] of contents) {
      const content = d.get('content')!
      const pair = PAIRS.find(([other]) => content.includes(`attr(${other})`))!
      const [first, second] = selector.includes('[data-sem-platform=apple]') ? [pair[1], pair[0]] : pair
      expect(content, selector).toBe(`attr(${first}) '\\A' attr(${second}) / ''`)
    }
    // The boxes they are shown in: a line tall, clipping the other line, which no padding shows.
    const boxes = all.filter(([s]) => /::after$/.test(s) && /\[data-sem-(shortcut|key-hint)\]/.test(s) && !s.includes('platform'))
    const sized = boxes.filter(([, d]) => d.has('height'))
    expect(sized.length).toBe(2)
    for (const [selector, d] of sized) {
      expect(d.get('height'), selector).toBe('1lh')
      expect(d.get('overflow'), selector).toBe('clip')
      expect(d.get('white-space'), selector).toBe('pre')
      expect(d.get('box-sizing'), selector).toBe('content-box')
      expect(d.get('padding')!.split(/\s+/)[0], selector).toBe('0')
    }
  })

  it('in a list, both spellings share one grid cell and only their visibility follows the platform', () => {
    const cells = all.filter(([s, d]) => /(dd|\.sem-ta-keys) > kbd$/.test(s) && d.get('grid-area') === '1 / 1')
    expect(cells.length).toBe(2)
    for (const kind of ['shortcut-list', 'typeahead-option']) {
      const hidden = all.find(([s]) => s === `[data-sem-c="${kind}"]${kind === 'shortcut-list' ? '' : ' > .sem-ta-keys >'} .sem-apple`)
      expect(hidden?.[1].get('visibility'), kind).toBe('hidden')
    }
  })

  it('changes nothing but which spelling is seen when the platform is marked', () => {
    const marked = all.filter(([s]) => s.includes('[data-sem-platform=apple]'))
    expect(marked.length).toBeGreaterThan(0)
    for (const [selector, d] of marked) expect([...d.keys()].filter((p) => p !== 'content' && p !== 'visibility'), selector).toEqual([])
  })
})
