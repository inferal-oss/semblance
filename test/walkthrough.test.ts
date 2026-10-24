import { readFileSync } from 'node:fs'
import type { Term } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { BEH, NS } from '../src/ns.ts'
import { sourceIri, turtleSpans } from '../src/sources.ts'
import { mountShell, mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const EX = 'https://example.org/todo#'
const C = NS.c

/** The shell on the todo example (as the Playground was), with its walkthrough. */
function todo(prefer: 'sparql' | 'function' = 'function', kind: 'oxigraph' | 'wat' = 'oxigraph') {
  const h = mountShell(5, kind, prefer)
  const walk = () => h.document.querySelector('[data-sem-c=walkthrough]') as HTMLElement
  const steps = () => [...walk().querySelectorAll<HTMLElement>('.sem-walk-step')]
  const mention = (label: string, step?: number) => [...(step === undefined ? walk() : steps()[step]!).querySelectorAll<HTMLElement>('.sem-mention')].find((m) => m.textContent === label)!
  const node = (iri: string) => [...walk().querySelectorAll('.sem-plot [data-sem-term]')].find((n) => n.getAttribute('data-sem-term') === iri) as SVGElement | undefined
  const current = () => walk().querySelector('.sem-walk-step[aria-current=step] .sem-walk-title')?.textContent
  const salience = (iri: string) => node(iri)?.getAttribute('data-sem-salience')
  const value = (s: string, p: string) => h.store.match(h.store.factory.namedNode(s), h.store.factory.namedNode(p), null).map((q) => q.object.value)
  const members = () => h.store.match(h.store.factory.namedNode(BEH.ChangeLog), h.store.factory.namedNode(NS.tree + 'member'), null).length
  const step = (el: Element) => {
    el.dispatchEvent(new h.window.CustomEvent('sem-step', { bubbles: true }))
    h.shell.flush()
  }
  const fire = (el: Element, type: string) => {
    h.fire(el, type)
    h.shell.flush()
  }
  const source = () => walk().querySelector('[data-sem-c=source-view]') as HTMLElement
  const highlighted = () => [...source().querySelectorAll('.sem-line[data-sem-highlighted]')].map((l) => l.textContent!.replace(/\n$/, ''))
  return { ...h, walk, steps, mention, node, current, salience, value, members, step, fire, source, highlighted }
}

describe('a walkthrough', () => {
  it('renders its steps, their mentions, and a diagram node for every mentioned term', () => {
    const t = todo()
    expect(t.walk().querySelector('h2')!.textContent).toBe('How it works')
    expect(t.steps().map((s) => s.querySelector('.sem-walk-title')!.textContent)).toEqual([
      'The data has its own vocabulary',
      'Components describe how to show it',
      'Reactions turn events into changes',
      'One graph, two projections',
      'Why a change is cheap',
    ])
    // Steps are focusable, numbered, and run text with mentions inside.
    for (const s of t.steps()) expect(s.getAttribute('tabindex')).toBe('0')
    expect(t.steps()[0]!.textContent).toContain('A todo is a resource such as ex:t1')
    const mentioned = new Set([...t.walk().querySelectorAll('.sem-mention')].map((m) => m.getAttribute('data-sem-mentions')!))
    expect(mentioned.size).toBeGreaterThan(12)
    for (const term of mentioned) expect(t.node(term), term).toBeDefined()
    expect(t.walk().querySelectorAll('.sem-plot [data-sem-term]')).toHaveLength(mentioned.size)
    // The links come from the graph: the list's own triples, list membership, and query text.
    const caption = t.walk().querySelector('figcaption')!.textContent!
    expect(caption).toContain('ex:todos c:sortBy ex:priority.')
    expect(caption).toContain('ex:page c:children ex:todos.')
    expect(caption).toContain('ex:AddTodo inserts ex:done.')
    expect(caption).toContain('ex:AddTodo beh:source ex:add.')
    // ...never what rendering derives between components.
    expect(caption).not.toMatch(/ord:|rdfhtml:|sem:renders/)
    expect(t.walk().querySelector('.sem-plot')!.getAttribute('aria-describedby')).toBe(t.walk().querySelector('figcaption')!.id)
    // Each mention says what it points at.
    expect(t.mention('ex:AddTodo').getAttribute('aria-description')).toBe('ex:AddTodo, in the diagram; activate to see its Turtle in the source')
    // The source it explains sits beside the diagram, every line numbered (c:line).
    expect(t.source().closest('.sem-walk-aside')).toBeTruthy()
    expect(t.source().querySelector('pre')!.textContent).toContain('ex:AddTodo a beh:Reaction')
  })

  it('reads the first step until the host reports another, without recording it', () => {
    const t = todo()
    expect(t.current()).toBe('The data has its own vocabulary')
    expect(t.value(UI + 'ex-todo-how', C + 'current')).toEqual([])
    const before = t.members()
    t.step(t.steps()[2]!)
    expect(t.current()).toBe('Reactions turn events into changes')
    expect(t.value(UI + 'ex-todo-how', C + 'current')).toEqual([UI + 'ex-todo-w3'])
    t.step(t.steps()[3]!)
    expect(t.current()).toBe('One graph, two projections')
    // Scrolling is not history: nothing was appended to the change log.
    expect(t.members()).toBe(before)
    // Focus (the keyboard) does the same.
    t.fire(t.steps()[0]!, 'focusin')
    expect(t.current()).toBe('The data has its own vocabulary')
    expect(t.members()).toBe(before)
  })

  it("focuses the current step's mentioned nodes, their neighbours, and dims the rest", () => {
    const t = todo()
    // Step 1 mentions ex:t1, ex:priority, ex:done, ex:todos.
    for (const x of ['t1', 'priority', 'done', 'todos']) expect(t.salience(EX + x), x).toBe('focused')
    expect(t.salience(EX + 'page')).toBe('neighbour') // ex:page c:children ex:todos
    expect(t.salience(EX + 'RequireText')).toBe('dimmed')
    const links = [...t.walk().querySelectorAll('.sem-plot .sem-link')]
    expect(links.filter((l) => l.getAttribute('data-sem-salience') === 'neighbour').length).toBeGreaterThan(3)
    t.step(t.steps()[2]!)
    expect(t.salience(EX + 'AddTodo')).toBe('focused')
    expect(t.salience(EX + 't1')).toBe('dimmed')
    expect(t.salience(EX + 'done')).toBe('neighbour') // ex:AddTodo inserts ex:done
  })

  it('points at a term while a mention is hovered or focused, and lights its other mentions', () => {
    const t = todo()
    const before = t.members()
    t.fire(t.mention('ex:priority', 1), 'mouseover')
    expect(t.value(UI + 'ex-todo-how', C + 'pointedTerm')).toEqual([EX + 'priority'])
    expect(t.salience(EX + 'priority')).toBe('focused')
    expect(t.salience(EX + 't1')).toBe('dimmed')
    // Both mentions of ex:priority (steps 1 and 2) are lit.
    expect([...t.walk().querySelectorAll('[data-sem-lit]')].map((m) => m.textContent)).toEqual(['ex:priority', 'ex:priority'])
    t.fire(t.mention('ex:priority', 1), 'mouseout')
    expect(t.value(UI + 'ex-todo-how', C + 'pointedTerm')).toEqual([])
    expect(t.walk().querySelectorAll('[data-sem-lit]')).toHaveLength(0)
    // Focusing a mention points at it and makes its step the current one.
    t.fire(t.mention('ex:AddTodo'), 'focusin')
    expect(t.current()).toBe('Reactions turn events into changes')
    expect(t.salience(EX + 'AddTodo')).toBe('focused')
    t.fire(t.mention('ex:AddTodo'), 'focusout')
    expect(t.value(UI + 'ex-todo-how', C + 'pointedTerm')).toEqual([])
    expect(t.members()).toBe(before)
  })

  it('shows the statement of a mentioned resource in the source, as graph state', () => {
    const t = todo()
    t.fire(t.mention('ex:AddTodo'), 'click')
    const view = UI + 'exs-todo'
    expect(t.value(view, C + 'highlightsSubject')).toEqual([EX + 'AddTodo'])
    expect(t.value(UI + 'ex-todo-how', C + 'selectedTerm')).toEqual([EX + 'AddTodo'])
    // Exactly the lines of its statement, from its subject to the final '.'.
    const lines = t.highlighted()
    expect(lines[0]).toBe('ex:AddTodo a beh:Reaction ;')
    expect(lines.at(-1)).toBe('    sem:function "todo:add" .')
    const span = turtleSpans(t.value(sourceIri('src/examples/todo.ts'), C + 'text')[0]!).find((s) => s.subject === EX + 'AddTodo')!
    expect(lines).toHaveLength(span.to - span.from + 1)
    expect(t.source().querySelector('.sem-source-focus')!.textContent).toBe(`ex:AddTodo · lines ${span.from}–${span.to}`)
    // The node and both... the one mention of it is lit; the click was recorded like any click.
    expect(t.salience(EX + 'AddTodo')).toBe('focused')
    // Another mention moves the highlight.
    t.fire(t.mention('ex:todos', 0), 'click')
    expect(t.value(view, C + 'highlightsSubject')).toEqual([EX + 'todos'])
    expect(t.highlighted()[0]).toBe('ex:todos a c:List ;')
    // Moving on to another step lets the selection go (the source keeps showing it).
    t.step(t.steps()[3]!)
    expect(t.value(UI + 'ex-todo-how', C + 'selectedTerm')).toEqual([])
    expect(t.value(view, C + 'highlightsSubject')).toEqual([EX + 'todos'])
  })

  it('selects a term by its node in the diagram, and lets it go on a second click', () => {
    const t = todo()
    t.fire(t.node(EX + 'done')!.querySelector('.sem-dot')!, 'click')
    expect(t.value(UI + 'ex-todo-how', C + 'selectedTerm')).toEqual([EX + 'done'])
    expect([...t.walk().querySelectorAll('[data-sem-lit]')].map((m) => m.textContent)).toEqual(['ex:done', 'ex:done'])
    // ex:done is described nowhere in the source on its own (it is a property used, not defined).
    expect(t.value(UI + 'exs-todo', C + 'highlightsSubject')).toEqual([])
    t.fire(t.node(EX + 'done')!.querySelector('.sem-dot')!, 'click')
    expect(t.value(UI + 'ex-todo-how', C + 'selectedTerm')).toEqual([])
    t.fire(t.node(EX + 'page')!, 'click')
    expect(t.highlighted()[0]).toBe('ex:page a c:Stack ;')
  })

  it("links a mention of a term the source does not describe to the term's page", () => {
    const t = todo()
    const list = t.mention('c:List')
    expect(list.localName).toBe('a')
    expect(list.getAttribute('href')).toBe('#reference/c:List')
    expect(list.getAttribute('aria-description')).toBe('c:List, in the diagram; opens its page')
    expect(t.node(C + 'List')).toBeDefined()
  })

  it('renders the same with SPARQL rules and reactions as with functions', () => {
    expect(implementationGaps(['components/walkthrough.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    // SPARQL on Oxigraph and on Semblance's own engine, and the function twins.
    const [a, b, c] = ([['sparql', 'oxigraph'], ['sparql', 'wat'], ['function', 'oxigraph']] as const).map(([prefer, kind]) => {
      const t = todo(prefer, kind)
      const html = [t.walk().outerHTML]
      t.step(t.steps()[2]!)
      html.push(t.walk().outerHTML)
      t.fire(t.mention('ex:priority', 1), 'mouseover')
      html.push(t.walk().outerHTML)
      t.fire(t.mention('ex:priority', 1), 'mouseout')
      t.fire(t.mention('ex:AddTodo'), 'click')
      html.push(t.walk().outerHTML)
      t.fire(t.node(EX + 'page')!, 'click')
      html.push(t.walk().outerHTML)
      t.fire(t.mention('ex:AddTodo'), 'focusin')
      html.push(t.walk().outerHTML)
      t.fire(t.mention('ex:todos', 0), 'click')
      html.push(t.walk().outerHTML)
      return html
    })
    a!.forEach((html, i) => expect(html, `state ${i} (Oxigraph)`).toBe(c![i]))
    b!.forEach((html, i) => expect(html, `state ${i} (wat)`).toBe(c![i]))
  })
})

describe('reading a walkthrough costs only the walkthrough', () => {
  it('moving between steps re-runs one rule and touches only the diagram and the steps, however big the app', () => {
    const measure = (grow: number) => {
      const t = todo()
      if (grow) {
        const f = t.store.factory
        const add = []
        for (let i = 0; i < grow; i++) {
          const item = f.namedNode(`${EX}extra-${i}`)
          add.push(f.quad(item, f.namedNode(NS.rdfs + 'label'), f.literal(`Extra ${i}`)), f.quad(f.namedNode(EX + 'todos'), f.namedNode(C + 'item'), item))
        }
        t.runtime.apply({ add, remove: [] })
        t.shell.flush()
      }
      const snap = () => ({ ruleRuns: t.screen.engine.stats.ruleRuns, written: t.screen.engine.stats.derivedAdded + t.screen.engine.stats.derivedRemoved, domOps: t.shell.ops })
      const runs: ReturnType<typeof snap>[] = []
      for (const i of [1, 2, 3, 1]) {
        const a = snap()
        t.step(t.steps()[i]!)
        const b = snap()
        runs.push({ ruleRuns: b.ruleRuns - a.ruleRuns, written: b.written - a.written, domOps: b.domOps - a.domOps })
      }
      const a = snap()
      t.fire(t.mention('ex:AddTodo'), 'click')
      const b = snap()
      return { steps: runs, click: { ruleRuns: b.ruleRuns - a.ruleRuns, written: b.written - a.written, domOps: b.domOps - a.domOps } }
    }
    const small = measure(0)
    const large = measure(300)
    expect(large).toEqual(small)
    // A step: the walkthrough's focus rule, and the layers that decorate the walkthrough (its
    // style hooks, its shape, its tooltips) - never the rendering, the steps or the source.
    for (const s of small.steps) expect(s.ruleRuns).toBeLessThanOrEqual(4)
    // A mention: the same for the walkthrough and the source view, its highlight rule, and the
    // toasts that read the change log's head - not the source view's rendering.
    expect(small.click.ruleRuns).toBeLessThanOrEqual(10)
    console.info('[walkthrough cost]', JSON.stringify(small))
  })
})

describe('every example explains itself with a walkthrough', () => {
  // The examples on the Examples page.
  const files = ['_ex-todo.ttl', '_network.ttl', '_ex-signin.ttl', '_ex-kanban.ttl', '_ex-checkout.ttl', '_ex-budget.ttl', '_ex-activity.ttl', '_ex-chat.ttl', '_ex-settings.ttl', '_ex-localized.ttl', '_ex-views.ttl', '_ex-shapes.ttl', '_ex-sheet.ttl', '_ex-calendar.ttl', '_ex-dashboard.ttl', '_ex-collab.ttl']
  it.each(files)('%s', (file) => {
    const text = readFileSync(new URL(`../demo/gallery/${file}`, import.meta.url), 'utf8')
    const root = /^(ui:[\w-]+-how) a c:Walkthrough/m.exec(text)?.[1]
    expect(root, `${file} has a c:Walkthrough -how`).toBeDefined()
    expect([...text.matchAll(/ a c:WalkthroughStep\b/g)].length, 'steps').toBeGreaterThanOrEqual(4)
    expect([...text.matchAll(/ a c:Mention\b/g)].length, 'mentions').toBeGreaterThanOrEqual(10)
  })

  it('and every mention resolves: to its node, and to its statement in the source or to a page', () => {
    const h = mountSite('oxigraph', 'function')
    const f = h.store.factory
    const nn = f.namedNode
    const walks = h.store.match(null, nn(NS.rdf + 'type'), nn(C + 'Walkthrough')).map((q) => q.subject).filter((w) => w.value.endsWith('-how'))
    expect(walks.length).toBeGreaterThanOrEqual(files.length)
    const problems: string[] = []
    for (const w of walks) {
      const view = h.store.match(w, nn(C + 'sourceView'), null)[0]?.object
      const text = view && h.store.match(view, nn(C + 'of'), null)[0]?.object
      if (!text) problems.push(`${w.value}: no source`)
      const list = (head: Term | undefined): Term[] => {
        const out: Term[] = []
        for (let n = head; n && n.value !== NS.rdf + 'nil'; n = h.store.match(n, nn(NS.rdf + 'rest'), null)[0]?.object) {
          const first = h.store.match(n, nn(NS.rdf + 'first'), null)[0]?.object
          if (first) out.push(first)
        }
        return out
      }
      const steps = list(h.store.match(w, nn(C + 'steps'), null)[0]?.object)
      const mentions = steps.flatMap((s) => list(h.store.match(s, nn(C + 'children'), null)[0]?.object)).filter((m) => m.termType === 'NamedNode' && h.store.match(m, nn(NS.rdf + 'type'), nn(C + 'Mention')).length)
      if (mentions.length < 10) problems.push(`${w.value}: only ${mentions.length} mentions`)
      for (const m of mentions) {
        const term = h.store.match(m, nn(C + 'mentions'), null)[0]?.object
        if (!term || term.termType !== 'NamedNode') {
          problems.push(`${m.value}: mentions nothing`)
          continue
        }
        const described = !!text && h.store.match(null, nn(C + 'subject'), term).some((q) => h.store.match(q.subject, nn(C + 'in'), text).length > 0)
        const linked = h.store.match(m, nn(C + 'to'), null).length > 0
        if (!described && !linked) problems.push(`${m.value} (${term.value}): neither described in its source nor linked`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('source spans', () => {
  it("are each statement's subject and lines, blank nodes and directives left out", () => {
    const text = ['@prefix ex: <https://example.org/> .', '', '# a comment', 'ex:a a ex:Thing ;', '    ex:says """one', 'two . three""" .', '[] a ex:Anonymous .', 'ex:b ex:list ( ex:c ex:d ) . ex:c ex:p "x" .', '<https://example.org/e> ex:p [ ex:q 1.5 ] .'].join('\n')
    expect(turtleSpans(text)).toEqual([
      { subject: 'https://example.org/a', name: 'ex:a', from: 4, to: 6 },
      { subject: 'https://example.org/b', name: 'ex:b', from: 8, to: 8 },
      { subject: 'https://example.org/c', name: 'ex:c', from: 8, to: 8 },
      { subject: 'https://example.org/e', name: '<https://example.org/e>', from: 9, to: 9 },
    ])
    expect(turtleSpans('const x = 1')).toEqual([])
  })
})
