// /llms.txt and its pages (scripts/gen-llms.ts): every component listed, every link resolving to a
// generated file, a site route or a file of the repository, and llms.txt in llmstxt.org's format.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { generateLlms, REPO, SITE } from '../scripts/gen-llms.ts'
import { linkAddress, readAddress, readLocations, spellAddress } from '../src/navigation.ts'
import { loadStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import type { GraphStore } from '../src/store/types.ts'

const root = new URL('../', import.meta.url)
const UI = 'https://semblance.dev/demo#'
let files: Map<string, string>
let store: GraphStore

// It generates the whole site's Markdown, past the default limit of a hook.
beforeAll(() => {
  files = generateLlms()
  const gallery = readdirSync(new URL('demo/gallery/', root)).filter((f) => f.endsWith('.ttl')).map((f) => readFileSync(new URL('demo/gallery/' + f, root), 'utf8'))
  store = loadStore('wat', readFileSync(new URL('demo/app.ttl', root), 'utf8'), ...gallery)
}, 120_000)

/** Markdown links, and the site's own addresses written out (a route, or a generated page). */
const links = (md: string) =>
  [...md.matchAll(/\]\((https?:[^)\s]+)\)|(?<![(<`])(https:\/\/semblance\.dev\/(?:#|llms|(?:uk|de|ar)\/|docs|components|examples|reference)[^\s)>`]*)/g)].map((m) => (m[1] ?? m[2])!.replace(/[.,:;]$/, ''))

describe('llms.txt', () => {
  it('is in the llmstxt.org format: an H1, a blockquote, prose, then H2 file lists', () => {
    const lines = files.get('llms.txt')!.split('\n')
    expect(lines[0]).toBe('# Semblance')
    expect(lines[1]).toBe('')
    expect(lines[2]).toMatch(/^> \S/)
    const firstH2 = lines.findIndex((l) => l.startsWith('## '))
    // Before the file lists: no headings.
    expect(lines.slice(1, firstH2).filter((l) => /^#/.test(l))).toEqual([])
    const sections: string[] = []
    for (const l of lines.slice(firstH2)) {
      if (!l) continue
      if (l.startsWith('## ')) sections.push(l.slice(3))
      // A file list: "- [name](url)" with optional ": notes"; no other headings or prose.
      else expect(l, l).toMatch(/^- \[[^\]]+\]\(https?:\/\/[^)\s]+\)(: .+)?$/)
    }
    expect(sections[0]).toBe('Docs')
    expect(sections.at(-1)).toBe('Optional')
    expect(sections).toEqual(expect.arrayContaining(['Layers', 'Examples', 'Components: Layout', 'Components: Inspection']))
  })

  it('lists every component class with a sem:group, each with its page', () => {
    const f = store.factory
    const listed = files.get('llms.txt')!
    const classes = store
      .match(null, f.namedNode(NS.sem + 'group'), null)
      .filter((q) => q.subject.termType === 'NamedNode' && store.match(q.object, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.sem + 'ComponentGroup')).length)
      .map((q) => q.subject.value)
    expect(classes.length).toBeGreaterThan(150)
    const pname = (iri: string) => {
      const [p, ns] = Object.entries(NS).filter(([, ns]) => iri.startsWith(ns)).sort((a, b) => b[1].length - a[1].length)[0]!
      return `${p}:${iri.slice(ns.length)}`
    }
    const missing = classes.filter((c) => !listed.includes(`(${pname(c)})](${SITE}llms/components/`))
    expect(missing).toEqual([])
    const pages = [...files.keys()].filter((p) => p.startsWith('llms/components/'))
    expect(pages.length).toBe(new Set(classes).size)
    // Each component page names its term and carries its ontology as Turtle, as the Reference shows it,
    // and its specimens as the gallery shows them, under the page's headings.
    const button = files.get('llms/components/button.md')!
    expect(button).toMatch(/^# Button\n\n> An actionable control/)
    expect(button).toContain('## Ontology\n\nIts class, properties, renderings, reactions and shape, as the Reference shows them (c:ClassDoc):\n\n```turtle\n# the class\nc:Button a owl:Class ;\n')
    expect(button).toContain('```turtle\n@prefix c: <https://semblance.dev/ns/component#> .')
    expect(button).toContain(`- Reference: ${SITE}reference/c:Button/`)
    // A specimen of controls shows them by their words.
    expect(button).toContain('## In the gallery: Button\n\nOn the site: https://semblance.dev/components/actions/#act-buttons-spec\n\n### Button\n\n')
    expect(button).toContain('\n\nNeutral Accent Info Success Warning Danger\n\n')
  })

  it('has a page per doc section and per example, the site\'s page as Markdown', () => {
    const keys = (cls: string) => store.match(null, store.factory.namedNode(NS.rdf + 'type'), store.factory.namedNode(UI + cls)).map((q) => store.match(q.subject, store.factory.namedNode(UI + 'key'), null)[0]!.object.value)
    for (const k of keys('DocSection')) expect(files.has(`llms/docs/${k}.md`), k).toBe(true)
    for (const k of keys('Example')) expect(files.has(`llms/examples/${k}.md`), k).toBe(true)
    expect(files.get('llms/docs/overview.md')).toContain('Semblance describes a user interface as an RDF graph.')
    // A live example's sources: each under its name, as Turtle, the ones behind other tabs too.
    const behaviour = files.get('llms/docs/behaviour.md')!
    expect(behaviour).toMatch(/^# Behaviour and events\n\n> On the site: https:\/\/semblance\.dev\/docs\/behaviour\/\n\n/)
    expect(behaviour).toContain('**app.ttl**\n\n```turtle\n@prefix ex: <https://example.org/counter#> .\n')
    const start = files.get('llms/docs/start.md')!
    expect(start.match(/^\*\*(app|tally)\.ttl\*\*$/gm)).toEqual(['**app.ttl**', '**tally.ttl**', '**app.ttl**', '**tally.ttl**', '**app.ttl**'])
    // Links go to the Markdown page of what they link to.
    expect(start).toContain('[Recipes](https://semblance.dev/llms/docs/recipes.md)')
    // An example's headings under its title, its lists, its walkthrough's mentions as words.
    const kanban = files.get('llms/examples/kanban.md')!
    expect(kanban).toMatch(/^# Kanban board\n\n> On the site: https:\/\/semblance\.dev\/examples\/kanban\/\n\n/)
    expect(kanban).toContain('\n\n### To do\n\n3\n\n- Offline mode for the editor feature\n\n  Ada Lovelace\n\n')
    expect(kanban).toContain('\n\n## How it works\n\n')
    expect(kanban).toContain('A card such as kb:c4 is data in the kb: vocabulary')
    expect(kanban).toContain('is a [c:Board](https://semblance.dev/llms/components/board.md)')
  })

  it('is Markdown on every page: no text projection in a fence, no relative links, no HTML', () => {
    for (const [path, md] of files) {
      if (!path.startsWith('llms/')) continue
      expect(md, path).toMatch(/^# \S/)
      expect(md, path).not.toMatch(/^`{3,}text$/m)
      // Outside code: one title, no rules of the text projection, no link relative to the site, no markup.
      const prose = md.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, '').replace(/`[^`\n]*`/g, '')
      expect(prose.match(/^# /gm), path).toHaveLength(1)
      expect(prose, path).not.toMatch(/──|\]\(\/|(?<!\\)<\/?[a-z][\w-]*[ >]/)
    }
    expect(files.get('llms-full.txt')).not.toMatch(/^`{3,}text$/m)
  })

  it('has an index of changes, by release, and a page per change, in Markdown', () => {
    const index = files.get('llms/changes.md')!
    expect(index).toMatch(/^# Changes\n\n> /)
    expect(index).toContain('\n## Unreleased\n')
    const items = index.split('\n').filter((l) => l.startsWith('- '))
    const pages = [...files.keys()].filter((p) => p.startsWith('llms/changes/'))
    expect(items.length).toBe(pages.length)
    // A line per change: its page, its date (when it is recorded), its issue and what it affects, as code.
    for (const item of items) expect(item, item).toMatch(/^- \[[^\n]+\]\(https:\/\/semblance\.dev\/llms\/changes\/[\w-]+\.md\): (\d{4}-\d\d-\d\d · )?\[#\d+\]\([^)]+\) · (meaning|migrates(, lossy back)?) · `[\w-]+:\w+`(, `[\w-]+:\w+`)*$/)
    expect(index).toContain('- [An app bar is one row while it fits: its actions and end actions in one group after the brand](https://semblance.dev/llms/changes/app-bar-one-row.md): 2026-11-17 · [#570](https://github.com/inferal-oss/semblance/issues/570) · meaning · `c:AppBar`')
    const page = files.get('llms/changes/app-bar-one-row.md')!
    expect(page).toMatch(/^# An app bar is one row while it fits[^\n]*\n\n> On the site: https:\/\/semblance\.dev\/changes\/app-bar-one-row\/\n/)
    expect(page).toContain('\n## Why\n')
    expect(page).toContain('```shell\nsemblance migrate --check\n```')
    // What it affects links that component's own page here.
    expect(page).toContain('[c:AppBar 4 → 5](https://semblance.dev/llms/components/app-bar.md)')
  })

  it('stays the same size however many changes there are: llms.txt links the index of changes only', () => {
    const fixture = readFileSync(new URL('test/fixtures/changes.ttl', root), 'utf8')
    const tags = [
      { version: '0.1.0', commit: '0b050bb', date: '2026-11-11' },
      { version: '0.2.0', commit: '7b19fcf', date: '2026-11-16' },
    ]
    const more = generateLlms({ changes: { tags, extra: [fixture] } })
    expect(more.get('llms.txt')).toBe(files.get('llms.txt'))
    expect(files.get('llms.txt')).not.toContain('llms/changes/')
    // The index has them, by release, the unreleased first.
    const index = more.get('llms/changes.md')!
    expect(index.match(/^## .*/gm)).toEqual(['## Unreleased', '## 0.2.0', '## 0.1.0'])
    expect(index).toContain('Since 0.2.0, not released yet.')
    expect(index).toContain('Released 2026-11-11 as `v0.1.0`. 1 change.')
    for (const slug of ['example-label-hidden', 'example-window-size', 'example-radio-into-choice']) {
      expect(index).toContain(`(https://semblance.dev/llms/changes/${slug}.md)`)
      expect(more.has(`llms/changes/${slug}.md`), slug).toBe(true)
    }
    expect(index).toMatch(/\[a radio group is a c:Choice\]\([^)]+\): [^\n]* · migrates, lossy back · `c:Choice`, `c:RadioGroup`/)
  }, 120_000)

  it('links only to generated files, site routes and files of the repository', () => {
    const f = store.factory
    const r = { f, match: (s: never, p: string | null, o: never) => store.match(s, p ? f.namedNode(p) : null, o) }
    const loc = readLocations(r).find((l) => l.iri === UI + 'location')!
    const bad: string[] = []
    for (const [path, md] of files) {
      for (const url of links(md)) {
        if (url.startsWith(SITE) && !url.startsWith(SITE + 'llms')) {
          // A route: the site reads it and spells it back the same.
          const address = url.slice(SITE.length - 1)
          if (linkAddress(spellAddress(r, loc, readAddress(r, loc, address))) !== address) bad.push(`${path}: ${url}`)
        } else if (url.startsWith(SITE)) {
          if (!files.has(url.slice(SITE.length))) bad.push(`${path}: ${url}`)
        } else if (url.startsWith(`${REPO}/blob/main/`)) {
          if (!existsSync(new URL(url.slice(`${REPO}/blob/main/`.length).replace(/#.*$/, ''), root))) bad.push(`${path}: ${url}`)
        } else if (/^https:\/\/(semblance\.dev|github\.com)\//.test(url) && url !== REPO && !/^https:\/\/github\.com\/inferal-oss\/semblance\/(issues|pull|commit)\/\w+$/.test(url)) bad.push(`${path}: ${url}`)
        // Any other site is linked as the site's own page links it.
      }
    }
    expect(bad).toEqual([])
  })
})
