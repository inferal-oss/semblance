// llms.txt (llmstxt.org) for the site, generated from the graph that runs it: the ontology
// (ONTOLOGY_FILES) and the site (demo/app.ttl, demo/gallery/*.ttl). Besides /llms.txt and
// /llms-full.txt it writes one Markdown page per component, layer, doc section and example under
// /llms/, since the site routes by fragment (#components/...) and a crawler cannot render it.
// Every page body is Semblance's own text projection of that part of the graph (toText of a
// mod:Text projection); site routes come from the navigation model (addressOf).
//
// The Vite build emits the files (vite.config.ts) and the dev server serves them; run it alone
// to write them into a directory: `npx tsx scripts/gen-llms.ts [outDir]` (default dist/).
// test/llms.test.ts checks completeness, links and the format.
import type { Term } from '@rdfjs/types'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { todoApp } from '../src/examples/todo.ts'
import { addressOf } from '../src/navigation.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { isExampleSource, recordSources, turtleSpans } from '../src/sources.ts'
import type { GraphStore } from '../src/store/types.ts'

const root = resolve(import.meta.dirname, '..')
export const SITE = 'https://semblance.dev/'
export const REPO = 'https://github.com/inferal-oss/semblance'
const UI = 'https://semblance.dev/demo#'
/** The nodes this script adds to the graph: one c:ClassDoc per term it documents. */
const LLMS = 'urn:semblance:llms:'

/** The repository's own guides, linked from the Docs section (they are Markdown already). */
const GUIDES: [string, string, string][] = [
  ['Getting started', 'docs/GETTING-STARTED.md', 'build a small app with a component of its own'],
  ['Building components', 'docs/COMPONENTS.md', 'rules, reactions, layers and integrating with your app'],
  ['Foreign components', 'docs/FOREIGN.md', 'web components and framework components as parts of a Semblance UI'],
  ['Maintained views (IVM)', 'docs/IVM.md', 'incremental view maintenance under SPARQL views'],
  ['Design', 'DESIGN.md', 'the design system: tokens, components, themes'],
  ['Persistence', 'PERSISTENCE.md', 'what is remembered, where, and for how long'],
  ['Agents', 'AGENTS.md', 'ground rules for building Semblance or building with it'],
]

export interface LlmsOptions {
  /** The store to load the graph into (the site's default, Semblance's WASM engine). */
  store?: StoreKind
}

/** Every generated file, by its path in the site (`llms.txt`, `llms/components/button.md`, ...). */
export function generateLlms(options: LlmsOptions = {}): Map<string, string> {
  const read = (p: string) => readFileSync(join(root, p), 'utf8')
  const galleryFiles = Object.fromEntries(
    readdirSync(join(root, 'demo/gallery'))
      .filter((f) => f.endsWith('.ttl'))
      .sort()
      .map((f) => ['demo/gallery/' + f, read('demo/gallery/' + f)]),
  )
  const siteFiles: Record<string, string> = { 'demo/app.ttl': read('demo/app.ttl'), ...galleryFiles }
  const store = loadStore(options.store ?? 'wat', todoApp(5), ...Object.values(siteFiles))
  // As the host does: the examples' own files as c:SourceText, which their pages show.
  recordSources(store, { 'src/examples/todo.ts': todoApp(5), ...Object.fromEntries(Object.entries(galleryFiles).filter(([p]) => isExampleSource(p))) })
  const g = graph(store)

  // --- what there is --------------------------------------------------------------------------
  const keyed = (cls: string) =>
    g
      .instances(cls)
      .map((t) => ({ term: t, label: g.label(t), key: g.literal(t, UI + 'key')!, order: Number(g.literal(t, NS.sem + 'order') ?? 0) }))
      .filter((x) => x.key)
      .sort((a, b) => a.order - b.order)
  /** The content a switch over `property` shows for each of its values. */
  const caseContent = (value: Term) => g.subjects(NS.c + 'when', value).map((c) => g.object(c, NS.c + 'content')).find(Boolean)
  const docs = keyed(UI + 'DocSection').map((d) => ({ ...d, content: caseContent(d.term)! }))
  const examples = keyed(UI + 'Example').map((e) => ({ ...e, content: caseContent(e.term)! }))
  const groups = g
    .instances(NS.sem + 'ComponentGroup')
    .map((t) => ({ term: t, label: g.label(t), comment: g.literal(t, NS.rdfs + 'comment') ?? '', order: Number(g.literal(t, NS.sem + 'order') ?? 0) }))
    .sort((a, b) => a.order - b.order)
  const components = g
    .match(null, NS.sem + 'group', null)
    .filter((q) => q.subject.termType === 'NamedNode' && g.isA(q.object, NS.sem + 'ComponentGroup'))
    .map((q) => ({ term: q.subject, group: q.object }))
  const layers = g
    .instances(NS.sem + 'Layer')
    .filter((t) => t.termType === 'NamedNode')
    .sort((a, b) => g.pname(a).localeCompare(g.pname(b)))

  const fileName = (t: Term) => {
    const p = g.pname(t)
    const [prefix, local] = p.includes(':') ? [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)] : ['', p]
    const kebab = local.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase()
    return (prefix === 'c' || prefix === 'sem' ? '' : prefix + '-') + kebab.replace(/[^a-z0-9-]+/g, '-')
  }
  const unique = (paths: string[]) => {
    const seen = new Set<string>()
    for (const p of paths) {
      if (seen.has(p)) throw new Error(`gen-llms: two terms would share ${p}`)
      seen.add(p)
    }
  }
  const componentPage = (t: Term) => `llms/components/${fileName(t)}.md`
  const layerPage = (t: Term) => `llms/layers/${fileName(t)}.md`
  unique(components.map((c) => componentPage(c.term)))
  unique(layers.map(layerPage))

  // --- one text projection of everything the pages show ----------------------------------------
  const f = store.factory
  const classDocs = new Map<string, string>()
  for (const t of [...components.map((c) => c.term), ...layers]) {
    const doc = `${LLMS}doc/${encodeURIComponent(t.value)}`
    store.add(f.quad(f.namedNode(doc), f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + 'ClassDoc')))
    store.add(f.quad(f.namedNode(doc), f.namedNode(NS.c + 'of'), t as never))
    classDocs.set(t.value, doc)
  }
  const specimens = new Map(components.map((c) => [c.term.value, g.subjects(NS.c + 'demonstrates', c.term).filter((s) => g.isA(s, NS.c + 'Specimen'))]))
  const roots = [...docs.map((d) => d.content.value), ...examples.map((e) => e.content.value), ...[...specimens.values()].flat().map((s) => s.value), ...classDocs.values()]
  const projection = new Runtime(store).project({ modality: MOD.Text, name: 'llms', roots: [...new Set(roots)] })
  const text = (focus: string) => tidy(toText(projection.index, focus))

  // --- links --------------------------------------------------------------------------------------
  const page = (path: string) => SITE + path
  const route = (t: Term) => {
    const a = addressOf(g.reader, t)
    return a && a !== '#' ? SITE + a : undefined
  }
  const repo = (path: string) => `${REPO}/blob/main/${path}`
  const firstSentence = (s: string) => {
    const one = s.replace(/\s+/g, ' ').trim()
    const m = one.match(/^(.+?[.!?])(\s|$)/)
    return m ? m[1]! : one
  }

  /** The smallest statement in the site's own Turtle that makes an instance of `cls`, with its prefixes. */
  const spans = Object.entries(siteFiles).flatMap(([path, ttl]) => {
    const lines = ttl.split('\n')
    const prefixes = new Map([...ttl.matchAll(/@prefix\s+([\w-]*):\s*<([^>]*)>\s*\./g)].map((m) => [m[1]!, m[0]!]))
    return turtleSpans(ttl).map((s) => ({ ...s, path, prefixes, text: lines.slice(s.from - 1, s.to).join('\n') }))
  })
  const example = (cls: Term) => {
    const shown = new Set((specimens.get(cls.value) ?? []).flatMap((s) => g.reachable(s)))
    const candidates = spans
      .filter((s) => g.isA(f.namedNode(s.subject), cls.value) && s.text.trimStart().startsWith(s.name))
      .map((s) => ({ ...s, rank: [shown.has(s.subject) ? 0 : 1, s.path.includes('/_') ? 1 : 0, s.to - s.from, s.text.length] }))
      .sort((a, b) => a.rank.reduce((d, x, i) => d || x - b.rank[i]!, 0))
    const best = candidates[0]
    if (!best) return undefined
    const used = new Set([...best.text.replace(/"(?:[^"\\]|\\.)*"|'''[\s\S]*?'''|"""[\s\S]*?"""/g, '').matchAll(/(?<![\w<#/-])([\w-]*):(?=[\w-])/g)].map((m) => m[1]!))
    const prefixLines = [...best.prefixes].filter(([p]) => used.has(p)).map(([, line]) => line)
    return { path: best.path, from: best.from, turtle: `${prefixLines.join('\n')}\n\n${best.text.trim()}` }
  }

  // --- the pages --------------------------------------------------------------------------------
  const out = new Map<string, string>()
  const fence = (lang: string, body: string) => {
    const ticks = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)))
    return `${ticks}${lang}\n${body}\n${ticks}`
  }
  const generated = `This page is generated from the graph that runs ${SITE} (scripts/gen-llms.ts): its body is the site's text projection.`

  type ComponentInfo = { term: Term; name: string; pname: string; comment: string; group: Term; gallery?: string; reference?: string; path: string }
  const info: ComponentInfo[] = components.map((c) => ({
    term: c.term,
    name: g.label(c.term),
    pname: g.pname(c.term),
    comment: g.literal(c.term, NS.rdfs + 'comment') ?? '',
    group: c.group,
    // Its specimen in the gallery, or else the gallery page of its group.
    gallery: [...(specimens.get(c.term.value) ?? []), ...g.subjects(UI + 'componentGroup', c.group).map(caseContent)].filter((t) => t !== undefined).map(route).find(Boolean),
    reference: route(c.term),
    path: componentPage(c.term),
  }))

  const componentDetails = (c: ComponentInfo, level: string) => {
    const parts: string[] = []
    const supers = g.objects(c.term, NS.rdfs + 'subClassOf').filter((t) => t.termType === 'NamedNode')
    const mixins = g.objects(c.term, NS.sem + 'mixin')
    parts.push(
      [
        `- Term: \`${c.pname}\` (<${c.term.value}>)`,
        `- Group: ${g.label(c.group)}`,
        supers.length ? `- Subclass of: ${supers.map((s) => '`' + g.pname(s) + '`').join(', ')}` : '',
        mixins.length ? `- Mixins: ${mixins.map((s) => '`' + g.pname(s) + '`').join(', ')}` : '',
        c.gallery ? `- Gallery: ${c.gallery}` : '',
        c.reference ? `- Reference: ${c.reference}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    const props = g.subjects(NS.rdfs + 'domain', c.term).sort((a, b) => g.pname(a).localeCompare(g.pname(b)))
    const shapes = g.subjects(NS.sh + 'targetClass', c.term)
    const constraints = shapes.flatMap((s) => g.objects(s, NS.sh + 'property'))
    if (props.length || constraints.length) {
      parts.push(`${level} Properties`)
      const lines = props.map((p) => {
        const range = g.objects(p, NS.rdfs + 'range').map((r) => '`' + g.pname(r) + '`')
        const comment = g.literal(p, NS.rdfs + 'comment')
        return `- \`${g.pname(p)}\`${range.length ? ` (${range.join(', ')})` : ''}${comment ? `: ${comment.replace(/\s+/g, ' ').trim()}` : ''}`
      })
      for (const k of constraints) {
        const path = g.object(k, NS.sh + 'path')
        if (!path) continue
        const facets = [
          ['sh:minCount', 'at least'],
          ['sh:maxCount', 'at most'],
        ]
          .map(([p, say]) => {
            const v = g.literal(k, NS.sh + p!.slice(3))
            return v ? `${say} ${v}` : ''
          })
          .filter(Boolean)
        const kind = [NS.sh + 'datatype', NS.sh + 'class', NS.sh + 'node', NS.sh + 'in'].map((p) => g.object(k, p)).find((t) => t?.termType === 'NamedNode')
        const message = g.literal(k, NS.sh + 'message')
        lines.push(
          `- shape: \`${path.termType === 'NamedNode' ? g.pname(path) : 'a path'}\`${facets.length || kind ? ` (${[...facets, kind ? '`' + g.pname(kind) + '`' : ''].filter(Boolean).join(', ')})` : ''}${message ? `: ${message}` : ''}`,
        )
      }
      parts.push(lines.join('\n'))
    }
    const ex = example(c.term)
    if (ex) parts.push(`${level} Example`, `From ${repo(ex.path)}#L${ex.from}:`, fence('turtle', ex.turtle))
    return parts
  }

  for (const c of info) {
    const sections = [`# ${c.name}`, `> ${oneLine(c.comment) || `The ${c.pname} component.`}`, ...componentDetails(c, '##')]
    sections.push('## Ontology', 'Its class, properties, renderings, reactions and shape, as the Reference shows them (c:ClassDoc):', fence('turtle', text(classDocs.get(c.term.value)!)))
    for (const s of specimens.get(c.term.value) ?? []) {
      const where = route(s)
      sections.push(`## In the gallery: ${g.label(s)}`, where ? `As text (the site shows it at ${where}):` : 'As text:', fence('text', text(s.value)))
    }
    sections.push('---', generated)
    out.set(c.path, sections.join('\n\n') + '\n')
  }

  for (const l of layers) {
    const comment = g.literal(l, NS.rdfs + 'comment') ?? ''
    const reference = route(l)
    out.set(
      layerPage(l),
      [
        `# ${g.label(l)} (${g.pname(l)})`,
        `> ${oneLine(comment) || `The ${g.pname(l)} layer.`}`,
        reference ? `- Reference: ${reference}` : '',
        '## Ontology',
        'The layer and what it renders, as the Reference shows them (c:ClassDoc):',
        fence('turtle', text(classDocs.get(l.value)!)),
        '---',
        generated,
      ]
        .filter(Boolean)
        .join('\n\n') + '\n',
    )
  }

  const textPage = (title: string, at: string | undefined, body: string) =>
    [`# ${title}`, at ? `> On the site: ${at}` : '', fence('text', body), '---', generated].filter(Boolean).join('\n\n') + '\n'
  for (const d of docs) out.set(`llms/docs/${d.key}.md`, textPage(d.label, route(d.content), text(d.content.value)))
  for (const e of examples) out.set(`llms/examples/${e.key}.md`, textPage(e.label, route(e.content), text(e.content.value)))

  // --- llms.txt ---------------------------------------------------------------------------------
  const pkg = JSON.parse(read('package.json')) as { name: string; description: string }
  const head = [
    '# Semblance',
    `> Semblance is an RDF-native web UI framework: the user interface is data. An app is an RDF graph of component instances wired to its own vocabulary; rules project that graph into RDF/HTML, incrementally, and a renderer patches it into the DOM or serializes it as HTML or text.`,
    [
      'The core model:',
      '',
      '- **The graph.** Components, layers (modality, style, position, accessibility, behaviour, keyboard, localization, navigation, persistence, validation, ...), styles and themes are ontologies in Turtle; an app is instances of their classes.',
      '- **Rules and projections.** A component class has renderings; each rendering has a SPARQL CONSTRUCT rule and, as an escape hatch and a parity oracle, a function twin that renders byte-identical output. Rules are stratified and incremental: an interaction costs what it changes. The same graph is projected onto several modalities at once (screen, text).',
      '- **Events as data.** Interaction becomes RDF events in a bounded change log (an LDES stream); reactions (CONSTRUCT pairs of deletes and inserts) turn each event into one change of the graph. The host only performs the effects the graph asks for (the address, storage, timers, the network).',
      '- **Identity and order.** Rules mint IRIs as `<focus>/~<local>`, never blank nodes; siblings are ordered with an ordering vocabulary.',
      '',
      'Every component class is listed by its group (sem:group), with its page, its specimen in the gallery and its entry in the Reference; the layers and the complete examples follow.',
      '',
      `Every page linked below is Markdown generated from the graph that runs ${SITE}: its body is the site's own text projection of that part of the graph. The site itself routes by fragment (\`#components/...\`), so those links need a browser that runs it.`,
    ].join('\n'),
  ]
  const docsSection = [
    '## Docs',
    [
      ...docs.map((d) => `- [${d.label}](${page(`llms/docs/${d.key}.md`)}): ${firstSentence(firstParagraph(text(d.content.value)))}`),
      ...GUIDES.map(([title, path, what]) => `- [${title} (repository)](${repo(path)}): ${what}`),
    ].join('\n'),
  ]
  // llms.txt: one H2 file list per group (llmstxt.org: H2 sections of `- [name](url): notes`);
  // llms-full.txt: every component in full, under one H2.
  const componentList = (members: ComponentInfo[]) =>
    members
      .map((c) => {
        const links = [c.gallery ? `[gallery](${c.gallery})` : '', c.reference ? `[reference](${c.reference})` : ''].filter(Boolean).join(', ')
        return `- [${c.name} (${c.pname})](${page(c.path)}): ${firstSentence(c.comment) || 'A component.'}${links ? ` (${links})` : ''}`
      })
      .join('\n')
  const grouped = groups
    .map((grp) => ({ ...grp, members: info.filter((c) => c.group.equals(grp.term)).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((grp) => grp.members.length)
  const componentsSection = grouped.flatMap((grp) => [`## Components: ${grp.label}`, componentList(grp.members)])
  const componentsInFull = [
    '## Components',
    ...grouped.flatMap((grp) => [
      `### ${grp.label}`,
      oneLine(grp.comment),
      ...grp.members.flatMap((c) => [`#### ${c.name}`, oneLine(c.comment), `- Page: ${page(c.path)}`, ...componentDetails(c, '#####')]),
    ]).filter(Boolean),
  ]
  const layersSection = [
    '## Layers',
    layers.map((l) => `- [${g.label(l)} (${g.pname(l)})](${page(layerPage(l))}): ${firstSentence(g.literal(l, NS.rdfs + 'comment') ?? '') || 'A layer.'}`).join('\n'),
  ]
  const examplesSection = [
    '## Examples',
    examples
      .map((e) => {
        const at = route(e.content)
        return `- [${e.label}](${page(`llms/examples/${e.key}.md`)}): ${firstSentence(firstParagraph(text(e.content.value))) || 'An example application.'}${at ? ` ([live](${at}))` : ''}`
      })
      .join('\n'),
  ]
  const optional = [
    '## Optional',
    [
      `- [Source on GitHub](${REPO}): the framework, the ontologies (ontology/), the site (demo/) and Semblance's own SPARQL engines (rdf-engine/)`,
      `- [README](${repo('README.md')}): the architecture`,
      `- [npm package ${pkg.name}](https://www.npmjs.com/package/${pkg.name}): not published yet`,
      `- [Full listing](${page('llms-full.txt')}): every component with its description, properties and an example, and every doc section as text`,
    ].join('\n'),
  ]
  out.set('llms.txt', [...head, ...docsSection, ...componentsSection, ...layersSection, ...examplesSection, ...optional].join('\n\n') + '\n')
  out.set(
    'llms-full.txt',
    [
      ...head,
      ...docsSection,
      ...componentsInFull,
      ...layersSection,
      ...examplesSection,
      '## Docs, in full',
      ...docs.flatMap((d) => [`### ${d.label}`, fence('text', text(d.content.value))]),
      ...optional,
    ].join('\n\n') + '\n',
  )
  store.dispose?.()
  return out
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Trailing spaces off, runs of blank lines collapsed. */
const tidy = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
/** The first line of a projection that reads as a sentence (not a heading or a control). */
const firstParagraph = (s: string) => s.split('\n').find((l) => /^[A-Z][^│|]*[a-z][.:]/.test(l.trim()) && l.trim().split(' ').length > 5)?.trim() ?? ''

/** Reading the store as terms. */
function graph(store: GraphStore) {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const match = (s: Term | null, p: string | null, o: Term | null) => store.match(s as never, p ? nn(p) : null, o as never)
  const prefixes = Object.entries(NS).sort((a, b) => b[1].length - a[1].length)
  const g = {
    reader: { f, match },
    match,
    objects: (s: Term, p: string) => match(s, p, null).map((q) => q.object),
    object: (s: Term, p: string): Term | undefined => match(s, p, null)[0]?.object,
    subjects: (p: string, o: Term) => match(null, p, o).map((q) => q.subject as Term),
    instances: (cls: string) => match(null, NS.rdf + 'type', nn(cls)).map((q) => q.subject as Term),
    isA: (t: Term, cls: string) => store.has(f.quad(t as never, nn(NS.rdf + 'type'), nn(cls))),
    /** A literal value, English (or untagged) first. */
    literal: (s: Term, p: string): string | undefined => {
      const ls = match(s, p, null).map((q) => q.object).filter((o) => o.termType === 'Literal')
      const pick = ls.find((l) => (l as { language: string }).language === 'en') ?? ls.find((l) => !(l as { language: string }).language) ?? ls[0]
      return pick?.value
    },
    pname: (t: Term) => {
      for (const [p, ns] of prefixes) if (t.value.startsWith(ns) && /^[\w-]+$/.test(t.value.slice(ns.length))) return `${p}:${t.value.slice(ns.length)}`
      return t.value
    },
    label: (t: Term): string =>
      g.literal(t, NS.rdfs + 'label') ?? g.literal(t, NS.c + 'label') ?? g.pname(t).replace(/^[\w-]*:/, ''),
    /** The resources reachable from `t` through named nodes, a few hops deep (a specimen's parts). */
    reachable: (t: Term): string[] => {
      const seen = new Set<string>()
      const todo: [Term, number][] = [[t, 0]]
      while (todo.length) {
        const [n, d] = todo.shift()!
        if (seen.has(n.value) || d > 6) continue
        seen.add(n.value)
        for (const q of match(n, null, null)) if (q.object.termType !== 'Literal' && q.predicate.value !== NS.rdf + 'type') todo.push([q.object, d + 1])
      }
      return [...seen]
    },
  }
  return g
}

/** Write the files into `dir` (the build output). */
export function writeLlms(dir: string, files = generateLlms()): void {
  for (const [path, content] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? join(root, 'dist'))
  const t = performance.now()
  const files = generateLlms()
  writeLlms(dir, files)
  console.log(`gen-llms: ${files.size} files into ${dir} in ${Math.round(performance.now() - t)} ms`)
}
