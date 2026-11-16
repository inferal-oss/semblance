import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'

// The chrome speaks the viewer's language (AGENTS.md, rule 7): what a reader finds their way by has
// a text in English (or untagged), Ukrainian, German and Arabic. That is the framework's own phrases
// and options, the site's pages, groups, examples and specimen titles, its shell and the network
// inspector. Sample content, specimen help, intros and the docs' prose are in English.

const UI = 'https://semblance.dev/demo#'
const NET = 'https://semblance.dev/ns/network#'
const LANGS = ['uk', 'de', 'ar']
const TEXTS = [NS.c + 'label', NS.rdfs + 'label', NS.c + 'title', NS.c + 'help', NS.c + 'note', NS.c + 'placeholder', NS.c + 'emptyText', NS.c + 'badge', NS.c + 'unit']
// Classes whose instances name something in the chrome (their label and title; their help is prose).
const CLASSES = new Set([
  NS.c + 'Phrase', NS.c + 'Specimen', NS.c + 'Charset', NS.c + 'Case', NS.c + 'CellStyle', NS.c + 'TextStyle', NS.c + 'CompactPresentation',
  NS.pos + 'Alignment', NS.sty + 'Tone', NS.sty + 'Emphasis', NS.sty + 'ControlSize', NS.sty + 'Elevation',
  NET + 'Status', NET + 'Kind', NET + 'Level',
  UI + 'GalleryGroup', UI + 'Example', UI + 'DocSection',
])
const NAMES = new Set([NS.c + 'label', NS.rdfs + 'label', NS.c + 'title'])
// Names and symbols, the same in every language.
const NOT_WORDS = new Set(['HTTP', 'URL', 'Semblance', 'Semblance WASM', 'Semblance Rust', 'Oxigraph', 'Inferal', 'ms', 'KB', 'Z', 'log–log', 'Turtle'])

const ttl = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f)
  return statSync(p).isDirectory() ? ttl(p) : p.endsWith('.ttl') ? [p] : []
})

/** Per subject and text property: its file, types and values by language; across a statement's files. */
function texts() {
  const types = new Map<string, Set<string>>()
  const found = new Map<string, { s: string; p: string; files: Set<string>; langs: Map<string, string> }>()
  for (const file of [...ttl('ontology'), ...ttl('demo')]) {
    for (const q of new Parser().parse(readFileSync(file, 'utf8'))) {
      if (q.predicate.value === NS.rdf + 'type') {
        const set = types.get(q.subject.value) ?? new Set()
        types.set(q.subject.value, set.add(q.object.value))
      } else if (q.object.termType === 'Literal' && TEXTS.includes(q.predicate.value)) {
        const k = q.subject.value + ' ' + q.predicate.value
        const e = found.get(k) ?? { s: q.subject.value, p: q.predicate.value, files: new Set(), langs: new Map() }
        found.set(k, e)
        e.files.add(file)
        e.langs.set(q.object.language.toLowerCase(), q.object.value)
      }
    }
  }
  return { types, found: [...found.values()] }
}

function inChrome(e: { s: string; p: string; files: Set<string> }, classes: Set<string> | undefined): boolean {
  const local = e.s.replace(/^.*[#/]/, '')
  if (e.files.has('demo/app.ttl')) return true
  if (e.files.has('demo/gallery/_examples.ttl')) return true
  if (e.files.has('demo/gallery/_network.ttl')) return (local.startsWith('net-') && !['net-intro', 'net-page'].includes(local)) || local === 'sample'
  if (/^gallery-\w+-intro$/.test(local)) return true
  if (local.endsWith('-how') && e.p === NS.c + 'label') return true
  return NAMES.has(e.p) && [...(classes ?? [])].some((c) => CLASSES.has(c))
}

describe('the chrome is translated', () => {
  const { types, found } = texts()
  const chrome = found.filter((e) => inChrome(e, types.get(e.s)))

  it('covers what it says', () => {
    const names = new Set(chrome.map((e) => e.s))
    for (const s of [UI + 'GroupInspection', UI + 'GroupDocuments', UI + 'ExCheckout', UI + 'net-inspector', UI + 'wn-stack-spec', NS.c + 'ResizeCommand', NS.sty + 'Accent']) expect(names).toContain(s)
    expect(chrome.length).toBeGreaterThan(400)
  })

  it('has every language', () => {
    const missing = chrome.flatMap((e) => {
      const source = e.langs.get('') ?? e.langs.get('en')
      if (source !== undefined && (NOT_WORDS.has(source) || !/\p{L}/u.test(source))) return []
      const absent = [...(source === undefined ? ['en'] : []), ...LANGS.filter((l) => !e.langs.has(l))]
      return absent.length ? [`${e.s} ${e.p.replace(/^.*[#/]/, '')} "${source ?? ''}": no ${absent.join(', ')}`] : []
    })
    expect(missing).toEqual([])
  })
})
