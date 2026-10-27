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

beforeAll(() => {
  files = generateLlms()
  const gallery = readdirSync(new URL('demo/gallery/', root)).filter((f) => f.endsWith('.ttl')).map((f) => readFileSync(new URL('demo/gallery/' + f, root), 'utf8'))
  store = loadStore('wat', readFileSync(new URL('demo/app.ttl', root), 'utf8'), ...gallery)
})

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
    // Each component page names its term and carries its ontology as Turtle, from the text projection.
    const button = files.get('llms/components/button.md')!
    expect(button).toMatch(/^# Button\n\n> An actionable control/)
    expect(button).toContain('c:Button a owl:Class ;\n')
    expect(button).toContain('```turtle\n@prefix c: <https://semblance.dev/ns/component#> .')
    expect(button).toContain(`- Reference: ${SITE}reference/#c:Button`)
  })

  it('has a page per doc section and per example, from the text projection', () => {
    const keys = (cls: string) => store.match(null, store.factory.namedNode(NS.rdf + 'type'), store.factory.namedNode(UI + cls)).map((q) => store.match(q.subject, store.factory.namedNode(UI + 'key'), null)[0]!.object.value)
    for (const k of keys('DocSection')) expect(files.has(`llms/docs/${k}.md`), k).toBe(true)
    for (const k of keys('Example')) expect(files.has(`llms/examples/${k}.md`), k).toBe(true)
    expect(files.get('llms/docs/overview.md')).toContain('Semblance describes a user interface as an RDF graph.')
    expect(files.get('llms/examples/kanban.md')).toContain('## To do (3)')
  })

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
        } else if (url !== REPO && !url.startsWith('https://www.npmjs.com/package/')) bad.push(`${path}: ${url}`)
      }
    }
    expect(bad).toEqual([])
  })
})
