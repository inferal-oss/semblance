// Function rules for changes as a page (ontology/components/changes.ttl): a change log release by
// release, a change's card body, one change with its migrations, one migration, and a component's
// versions. Each mints the framework's own components, as its SPARQL twin does; the tests compare
// the two.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, Out, RuleContext } from '../engine/context.ts'
import { H, NS, RDF_TYPE, SEM, XSD_BOOLEAN, XSD_INTEGER } from '../ns.ts'
import { md5Key } from './data.ts'
import { compact } from './reference.ts'
import { encodeForUri, named, RDFS_LABEL, rdfList, str, text } from './util.ts'

const c = NS.c
const CHG = NS.chg
const MIG = NS.mig
const RDF_NIL = NS.rdf + 'nil'
/** The terms these rules read and mint. */
const K = {
  Alert: c + 'Alert',
  Badge: c + 'Badge',
  Card: c + 'Card',
  ChangeEntry: c + 'ChangeEntry',
  ChangeSummary: c + 'ChangeSummary',
  Code: c + 'Code',
  DiffView: c + 'DiffView',
  Heading: c + 'Heading',
  Link: c + 'Link',
  LinkedCard: c + 'LinkedCard',
  MigrationView: c + 'MigrationView',
  Tag: c + 'Tag',
  Text: c + 'Text',
  badge: c + 'badge',
  bindFrom: c + 'bindFrom',
  bindProperty: c + 'bindProperty',
  block: c + 'block',
  changedBy: NS.sem + 'changedBy',
  content: c + 'content',
  emphasis: NS.sty + 'emphasis',
  help: c + 'help',
  href: c + 'href',
  internal: NS.sem + 'internal',
  items: c + 'items',
  label: c + 'label',
  language: c + 'language',
  level: c + 'level',
  of: c + 'of',
  size: NS.sty + 'size',
  textStyle: NS.sty + 'textStyle',
  to: c + 'to',
  tone: NS.sty + 'tone',
  version: NS.sem + 'version',
} as const

/** A phrase (c:Phrase) in the viewer's language. */
const say = (ctx: RuleContext, local: string) => text(ctx, ctx.nn(c + local), RDFS_LABEL) ?? ''
/** Prose on one line, as the SPARQL rules read it. */
const oneLine = (s: string) => s.replace(/[ \t\r\n]+/g, ' ')
/** What to call a change: its label in the viewer's language, else its local name. */
const changeLabel = (ctx: RuleContext, change: Term) => text(ctx, change, RDFS_LABEL) ?? change.value.replace(/^.*[#/]/, '')
/** "#123" for an issue or pull request. */
const issueWords = (issue: Term) => '#' + issue.value.replace(/^.*\//, '')
const fill = (phrase: string, key: string, value: string) => phrase.split(`{${key}}`).join(value)

const isChange = (ctx: RuleContext, t: Term | undefined): t is NamedNode => named(t) && ctx.match(t, RDF_TYPE, CHG + 'Change').length > 0
const migrationsOf = (ctx: RuleContext, change: Term): NamedNode[] => {
  const head = ctx.object(change, CHG + 'migrations')
  return head && head.value !== RDF_NIL ? rdfList(ctx, head).filter(named) : []
}
const migrates = (ctx: RuleContext, change: Term) => ctx.match(change, CHG + 'migrations', null).some((q) => q.object.value !== RDF_NIL)
const lossy = (ctx: RuleContext, change: Term) => migrationsOf(ctx, change).some((m) => ctx.match(m, MIG + 'loses', null).length > 0)

/** A component minted into the output: its class and its properties (literals as given, terms as they are). */
function mint(ctx: RuleContext, o: Out, node: NamedNode, cls: string, props: [string, Term | string | undefined][]): NamedNode {
  o.t(node, RDF_TYPE, ctx.nn(cls))
  for (const [p, v] of props) if (v !== undefined) o.t(node, p, v)
  return node
}
const int = (ctx: RuleContext, n: number) => ctx.f.literal(String(n), ctx.nn(XSD_INTEGER))
const yes = (ctx: RuleContext) => ctx.f.literal('true', ctx.nn(XSD_BOOLEAN))
/** Place `child` under `parent` by an order key. */
const place = (o: Out, parent: NamedNode, child: NamedNode, key: string) => o.t(parent, H.hasChild, child).t(child, SEM.orderKey, key)

/** What a log shows when a change is selected: the change, by c:bindProperty of c:bindFrom. */
function selectedChange(ctx: RuleContext, focus: NamedNode): NamedNode | undefined {
  const from = ctx.object(focus, K.bindFrom)
  const property = ctx.object(focus, K.bindProperty)
  if (!from || !named(property)) return undefined
  return ctx.objects(from, property).find((v) => isChange(ctx, v)) as NamedNode | undefined
}

// --- the log -------------------------------------------------------------------------------------------

const log: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const root = o.el('root', 'Div')
  o.renders(root)
  const selected = selectedChange(ctx, focus)
  if (selected) {
    o.t(root, H.hasChild, mint(ctx, o, o.node('entry'), K.ChangeEntry, [[K.of, selected]]))
    return o.quads
  }
  const logs = ctx.objects(focus, K.of)
  const releases = logs.flatMap((l) => ctx.match(null, CHG + 'log', l).map((q) => q.subject)).filter((r) => named(r) && ctx.match(r, RDF_TYPE, CHG + 'Release').length > 0) as NamedNode[]
  if (!releases.length) {
    o.t(root, H.hasChild, mint(ctx, o, o.node('empty'), K.Text, [[K.label, say(ctx, 'NoChangesPhrase')]]))
    return o.quads
  }
  for (const release of releases) {
    const version = str(ctx.object(release, CHG + 'version'))
    const section = o.node('release-' + encodeForUri(version ?? 'unreleased'))
    o.t(section, RDF_TYPE, ctx.nn(H.ns + 'Section')).t(section, H.ns + 'class', 'sem-release')
    place(o, root, section, String(Number(str(ctx.object(release, SEM.order)) ?? 0)))
    const changes = ctx.match(null, CHG + 'releasedIn', release).map((q) => q.subject).filter((ch) => isChange(ctx, ch)) as NamedNode[]
    const n = new Set(changes.map((ch) => ch.value)).size
    const date = str(ctx.object(release, CHG + 'date'))
    const tag = str(ctx.object(release, CHG + 'tag'))
    const previous = ctx.object(release, CHG + 'previous')
    const previousVersion = previous ? str(ctx.object(previous, CHG + 'version')) : undefined
    const when =
      version !== undefined
        ? date !== undefined && tag !== undefined
          ? fill(fill(say(ctx, 'ReleasedOnPhrase'), 'date', date), 'tag', tag)
          : undefined
        : previousVersion !== undefined
          ? fill(say(ctx, 'SinceReleasePhrase'), 'version', previousVersion)
          : say(ctx, 'NotReleasedPhrase')
    const count = n === 1 ? say(ctx, 'ChangeCountOnePhrase') : fill(say(ctx, 'ChangesCountPhrase'), 'n', String(n))
    const base = section.value.slice(focus.value.length + 2)
    place(o, section, mint(ctx, o, o.node(base + '-heading'), K.Heading, [[K.level, int(ctx, 2)], [K.label, version ?? say(ctx, 'UnreleasedPhrase')]]), '1')
    if (when !== undefined) place(o, section, mint(ctx, o, o.node(base + '-caption'), K.Text, [[K.textStyle, ctx.nn(NS.sty + 'Caption')], [K.label, `${when} · ${count}`]]), '2')
    if (n === 0) {
      place(o, section, mint(ctx, o, o.node(base + '-none'), K.Text, [[K.label, say(ctx, 'NoReleaseChangesPhrase')]]), '3')
      continue
    }
    const cards = o.node(base + '-cards')
    o.t(cards, RDF_TYPE, ctx.nn(H.ns + 'Div')).t(cards, H.ns + 'class', 'sem-change-cards')
    place(o, section, cards, '3')
    for (const change of changes) {
      const linked = o.node('change-' + md5Key(change.value))
      const kinds = (migrates(ctx, change) ? say(ctx, 'MigratesKindPhrase') : say(ctx, 'MeaningKindPhrase')) + (lossy(ctx, change) ? ' · ' + say(ctx, 'LossyKindPhrase') : '')
      const card = o.node(linked.value.slice(focus.value.length + 2) + '-card')
      const summary = o.node(linked.value.slice(focus.value.length + 2) + '-summary')
      mint(ctx, o, linked, K.LinkedCard, [[K.to, change], [K.content, card]])
      place(o, cards, linked, String(Number(str(ctx.object(change, SEM.order)) ?? 0)))
      mint(ctx, o, card, K.Card, [[K.label, changeLabel(ctx, change)], [K.badge, kinds], [K.content, summary]])
      mint(ctx, o, summary, K.ChangeSummary, [[K.of, change]])
    }
  }
  return o.quads
}

// --- a change's card body ---------------------------------------------------------------------------

const summary: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const root = o.el('root', 'Div')
  o.renders(root)
  const change = ctx.object(focus, K.of)
  if (!change) return o.quads
  const motivation = ctx.object(change, CHG + 'motivation')
  if (motivation) place(o, root, o.el('summary', 'P', { class: 'sem-summary' }, [o.text('summary-text', oneLine(motivation.value).replace(/^(.*?[.!?]) .*$/, '$1'))]), '1')
  const affects = ctx.objects(change, CHG + 'affects').filter(named)
  if (affects.length) {
    const tags = o.el('tags', 'Div', { class: 'sem-tags' })
    place(o, root, tags, '2')
    for (const t of affects) {
      const name = compact(ctx, t.value)
      place(o, tags, mint(ctx, o, o.node('tag-' + md5Key(t.value)), K.Tag, [[K.label, name], [K.size, ctx.nn(NS.sty + 'Small')], [K.tone, ctx.nn(NS.sty + 'Neutral')]]), name)
    }
  }
  const recorded = str(ctx.object(change, CHG + 'recorded'))
  // The least of its issues, as the SPARQL rule takes it.
  const issue = ctx.objects(change, CHG + 'issue').sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))[0]
  if (recorded !== undefined || issue)
    place(o, root, o.el('meta', 'P', { class: 'sem-meta' }, [o.text('meta-text', (recorded ?? '') + (recorded !== undefined && issue ? ' · ' : '') + (issue ? issueWords(issue) : ''))]), '3')
  return o.quads
}

// --- one change ----------------------------------------------------------------------------------------

const entry: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const root = o.el('root', 'Div')
  o.renders(root)
  const change = ctx.object(focus, K.of)
  if (!isChange(ctx, change)) return o.quads
  const tone = (local: string) => ctx.nn(NS.sty + local)
  const doesMigrate = migrates(ctx, change)
  const isLossy = lossy(ctx, change)

  // Its name, release, kind, date, issue and commit.
  place(o, root, mint(ctx, o, o.node('title'), K.Heading, [[K.level, int(ctx, 1)], [K.label, changeLabel(ctx, change)]]), '1')
  const facts = o.el('facts', 'Div', { class: 'sem-change-facts' })
  place(o, root, facts, '2')
  const release = ctx.object(change, CHG + 'releasedIn')
  const version = release ? str(ctx.object(release, CHG + 'version')) : undefined
  place(o, facts, mint(ctx, o, o.node('release'), K.Badge, [[K.label, version ?? say(ctx, 'UnreleasedPhrase')], [K.tone, tone(version !== undefined ? 'Success' : 'Neutral')], [K.emphasis, tone('Outline')]]), '1')
  place(o, facts, mint(ctx, o, o.node('kind'), K.Badge, [[K.label, say(ctx, doesMigrate ? 'MigratesKindPhrase' : 'MeaningKindPhrase')], [K.tone, tone(doesMigrate ? 'Accent' : 'Info')]]), '2')
  if (isLossy) place(o, facts, mint(ctx, o, o.node('lossy'), K.Badge, [[K.label, say(ctx, 'LossyKindPhrase')], [K.tone, tone('Warning')]]), '3')
  const recorded = str(ctx.object(change, CHG + 'recorded'))
  if (recorded !== undefined) place(o, facts, o.el('date', 'Span', { class: 'sem-date' }, [o.text('date-text', recorded)]), '4')
  for (const issue of ctx.objects(change, CHG + 'issue').filter(named))
    place(o, facts, mint(ctx, o, o.node('issue-' + md5Key(issue.value)), K.Link, [[K.href, issue.value], [K.label, issueWords(issue)]]), '5 ' + issue.value)
  const commit = ctx.objects(change, CHG + 'commit').find(named)
  if (commit) place(o, facts, mint(ctx, o, o.node('commit'), K.Link, [[K.href, commit.value], [K.label, commit.value.replace(/^.*\//, '').slice(0, 7)]]), '6')

  // The components it steps, and the terms it retires.
  const affects = ctx.objects(change, CHG + 'affects').filter(named)
  const retires = ctx.objects(change, CHG + 'retires').filter(named)
  if (affects.length || retires.length) {
    const box = o.el('affects', 'Div', { class: 'sem-change-affects' })
    place(o, root, box, '3')
    if (affects.length) place(o, box, mint(ctx, o, o.node('affects-label'), K.Text, [[K.textStyle, tone('Overline')], [K.label, say(ctx, 'AffectsPhrase')]]), '1')
    for (const t of affects) {
      const name = compact(ctx, t.value)
      const versions = ctx
        .match(null, CHG + 'of', t)
        .map((q) => q.subject)
        .filter((s) => ctx.match(s, RDF_TYPE, CHG + 'Step').length && ctx.match(s, K.changedBy, change).length)
        .map((s) => Number(str(ctx.object(s, K.version))))
        .filter((v) => Number.isFinite(v))
      const v = versions.length ? Math.max(...versions) : undefined
      place(o, box, mint(ctx, o, o.node('affects-' + md5Key(t.value)), K.Link, [[K.to, t], [K.label, v !== undefined ? `${name} ${v - 1} → ${v}` : name]]), '2 ' + name)
    }
    if (retires.length) place(o, box, mint(ctx, o, o.node('retires-label'), K.Text, [[K.textStyle, tone('Overline')], [K.label, say(ctx, 'RetiresPhrase')]]), '3')
    for (const t of retires) {
      const name = compact(ctx, t.value)
      place(o, box, mint(ctx, o, o.node('retires-' + md5Key(t.value)), K.Tag, [[K.label, name], [K.tone, tone('Danger')], [K.size, tone('Small')]]), '4 ' + name)
    }
  }

  // Why, what, and how to move each way.
  const heading = (part: string, order: string, level: number, phrase: string) => place(o, root, mint(ctx, o, o.node(part), K.Heading, [[K.level, int(ctx, level)], [K.label, say(ctx, phrase)]]), order)
  const prose = (part: string, order: string, property: string) => {
    for (const v of ctx.objects(change, CHG + property)) place(o, root, mint(ctx, o, o.node(part), K.Text, [[K.label, oneLine(v.value)]]), order)
  }
  heading('why-heading', '4', 2, 'WhyPhrase')
  prose('why', '5', 'motivation')
  heading('what-heading', '6', 2, 'WhatChangedPhrase')
  prose('what', '7', 'substance')
  heading('moving-heading', '8', 2, 'MovingPhrase')
  if (!doesMigrate) place(o, root, mint(ctx, o, o.node('meaning'), K.Alert, [[K.label, say(ctx, 'MeaningKindPhrase')], [K.help, say(ctx, 'MeaningNotePhrase')], [K.tone, tone('Info')]]), '9')
  const previousRelease = release ? ctx.object(release, CHG + 'previous') : undefined
  const previous = previousRelease ? str(ctx.object(previousRelease, CHG + 'version')) : undefined
  const from = previous !== undefined ? ` --from ${previous}` : ''
  const command = (part: string, order: string, code: string) =>
    place(o, root, mint(ctx, o, o.node(part), K.Code, [[K.label, code], [K.block, yes(ctx)], [K.language, 'shell']]), order)
  heading('forward-heading', '10', 3, 'ForwardPhrase')
  command('forward-command', '11', 'semblance migrate --check' + (doesMigrate ? '\nsemblance migrate' + from : from))
  prose('forward', '12', 'forwardGuide')
  heading('back-heading', '13', 3, 'BackPhrase')
  command('back-command', '14', `semblance migrate --to ${previous ?? '<release>'}${isLossy ? ' --accept-loss' : ''}`)
  prose('back', '15', 'backwardGuide')

  // Its migrations, in order: a card each.
  const migrations = migrationsOf(ctx, change)
  if (migrations.length) {
    place(o, root, mint(ctx, o, o.node('migrations-heading'), K.Heading, [[K.level, int(ctx, 2)], [K.label, fill(say(ctx, 'MigrationsCountPhrase'), 'n', String(migrations.length))]]), '16')
    migrations.forEach((m, i) => {
      const of = ctx.object(m, MIG + 'of')
      const fromVersion = str(ctx.object(m, MIG + 'from'))
      const toVersion = str(ctx.object(m, MIG + 'to'))
      const ofName = of ? compact(ctx, of.value) : '<>'
      const renameOnly = ctx.match(m, MIG + 'renames', null).length > 0 && ctx.match(m, MIG + 'forward', null).length === 0
      const kind = say(ctx, renameOnly ? 'RenameKindPhrase' : 'ShapeKindPhrase') + (ctx.match(m, MIG + 'loses', null).length ? ' · ' + say(ctx, 'LossyKindPhrase') : '')
      const card = o.node(`migration-${i + 1}`)
      const view = o.node(`migration-${i + 1}-view`)
      const label = ofName + (fromVersion !== undefined && toVersion !== undefined ? ` ${fromVersion} → ${toVersion}` : '')
      place(o, root, mint(ctx, o, card, K.Card, [[K.label, label], [K.badge, kind], [K.content, view]]), String(100 + i + 1))
      mint(ctx, o, view, K.MigrationView, [[K.of, m]])
    })
  }
  return o.quads
}

// --- one migration ----------------------------------------------------------------------------------

/** A rename's term by its prefixed name, a slug in quotes. */
const renamed = (ctx: RuleContext, t: Term) => (t.termType === 'NamedNode' ? compact(ctx, t.value) : `"${t.value}"`)

const migration: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const root = o.el('root', 'Div')
  o.renders(root)
  const m = ctx.object(focus, K.of)
  if (!m) return o.quads
  const tone = (local: string) => ctx.nn(NS.sty + local)
  for (const lost of ctx.objects(m, MIG + 'loses'))
    place(o, root, mint(ctx, o, o.node('loses'), K.Alert, [[K.tone, tone('Warning')], [K.label, say(ctx, 'LosesPhrase')], [K.help, oneLine(lost.value)]]), '1')
  const renames = ctx.objects(m, MIG + 'renames').flatMap((r) => {
    const old = ctx.object(r, MIG + 'old')
    const next = ctx.object(r, MIG + 'new')
    return old && next ? [{ old, next }] : []
  })
  if (renames.length) {
    const head = o.el('renames-head', 'Thead', {}, [o.el('renames-head-row', 'Tr', {}, [o.el('renames-old', 'Th', {}, [o.text('renames-old-text', say(ctx, 'OldNamePhrase'))]), o.el('renames-new', 'Th', {}, [o.text('renames-new-text', say(ctx, 'NewNamePhrase'))])])])
    const body = o.el('renames-body', 'Tbody')
    place(o, root, o.el('renames', 'Table', { class: 'sem-renames' }, [head, body]), '2')
    for (const { old, next } of renames) {
      const row = 'rename-' + md5Key(`${old.value} ${next.value}`)
      const oldName = renamed(ctx, old)
      const cell = (side: string, name: string) => o.el(`${row}-${side}`, 'Td', {}, [o.el(`${row}-${side}-code`, 'Code', {}, [o.text(`${row}-${side}-text`, name)])])
      place(o, body, o.el(row, 'Tr', {}, [cell('old', oldName), cell('new', renamed(ctx, next))]), oldName)
    }
  }
  const discriminator = ctx.objects(m, MIG + 'discriminator').find(named)
  if (discriminator)
    place(o, root, mint(ctx, o, o.node('discriminator'), K.Text, [[K.textStyle, tone('Caption')], [K.label, fill(say(ctx, 'DiscriminatorPhrase'), 'term', compact(ctx, discriminator.value))]]), '3')
  for (const diff of ctx.objects(m, MIG + 'exampleDiff')) {
    const lines = ctx.object(diff, MIG + 'lines')
    if (!lines) continue
    const n = Number(str(ctx.object(diff, SEM.order)) ?? 0)
    place(o, root, mint(ctx, o, o.node(`example-${n}`), K.DiffView, [[K.label, say(ctx, 'ExamplePhrase')], [K.items, lines]]), String(40 + n))
  }
  for (const [direction, update, phrase, captionOrder, codeOrder] of [
    ['forward', MIG + 'forward', 'ForwardUpdatePhrase', '60', '61'],
    ['backward', MIG + 'backward', 'BackwardUpdatePhrase', '62', '63'],
  ] as const) {
    for (const sparql of ctx.objects(m, update)) {
      place(o, root, mint(ctx, o, o.node(`${direction}-caption`), K.Text, [[K.label, say(ctx, phrase)], [K.textStyle, tone('Overline')]]), captionOrder)
      place(o, root, mint(ctx, o, o.node(`${direction}-code`), K.Code, [[K.label, sparql.value], [K.block, yes(ctx)], [K.language, 'sparql']]), codeOrder)
    }
  }
  return o.quads
}

// --- a component's versions ------------------------------------------------------------------------------

const history: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const root = o.el('root', 'Div')
  o.renders(root)
  const from = ctx.object(focus, K.bindFrom)
  const property = ctx.object(focus, K.bindProperty)
  const components = [...ctx.objects(focus, K.of), ...(from && named(property) ? ctx.objects(from, property) : [])]
  const steps = components.flatMap((comp) => ctx.match(null, CHG + 'of', comp).map((q) => q.subject).filter((s) => named(s) && ctx.match(s, RDF_TYPE, CHG + 'Step').length > 0)) as NamedNode[]
  if (!steps.length) {
    o.t(root, H.hasChild, mint(ctx, o, o.node('empty'), K.Text, [[K.label, say(ctx, 'NoVersionsPhrase')]]))
    return o.quads
  }
  for (const step of steps) {
    const version = Number(str(ctx.object(step, K.version)))
    if (!Number.isFinite(version)) continue
    const recorded = str(ctx.object(step, CHG + 'recorded'))
    const release = ctx.object(step, CHG + 'releasedIn')
    const releaseVersion = release ? str(ctx.object(release, CHG + 'version')) : undefined
    const change = ctx.objects(step, K.changedBy).find((ch) => isChange(ctx, ch))
    const internal = str(ctx.object(step, K.internal))
    const card = o.node(`version-${version}`)
    const body = o.node(`version-${version}-body`)
    place(o, root, mint(ctx, o, card, K.Card, [
      [K.label, fill(say(ctx, 'VersionPhrase'), 'n', String(version))],
      [K.badge, (releaseVersion ?? say(ctx, 'UnreleasedPhrase')) + (recorded !== undefined ? ' · ' + recorded : '')],
      [K.content, body],
    ]), String(0 - version))
    if (change) mint(ctx, o, body, K.Link, [[K.to, change], [K.label, changeLabel(ctx, change)]])
    else mint(ctx, o, body, K.Text, [[K.label, internal === 'new' ? say(ctx, 'NewComponentPhrase') : oneLine(internal ?? '')], [K.textStyle, ctx.nn(NS.sty + 'Caption')]])
  }
  return o.quads
}

export const functions: Record<string, FnRule> = {
  'changes:log': log,
  'changes:summary': summary,
  'changes:entry': entry,
  'changes:migration': migration,
  'changes:history': history,
}
