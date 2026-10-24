import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'

/** The Examples page, on one example. */
function example(name: string, prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const visible = (el: Element) => !el.closest('[hidden]')
  const click = (el: Element) => h.fire(el, 'click')
  click([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!)
  click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === name && visible(b))!)
  const shown = (sel: string) => [...h.document.querySelectorAll(sel)].filter(visible)
  return { ...h, shown }
}

describe('every example shows how it works and its source', () => {
  it.each(['sparql', 'function'] as const)('sign in: the app, then how it works, then its own file verbatim (%s)', (prefer) => {
    const { shown } = example('Sign in with a code', prefer)
    const how = shown('[data-sem-c=walkthrough]').find((w) => w.querySelector('h2')?.textContent === 'How it works')!
    expect(how).toBeDefined()
    const [source] = shown('[data-sem-c=source-view]')
    expect(source!.querySelector('.sem-source-path')!.textContent).toBe('demo/gallery/_ex-signin.ttl')
    // Verbatim: comments and all, in the order of the file...
    const file = readFileSync(new URL('../demo/gallery/_ex-signin.ttl', import.meta.url), 'utf8').trimEnd()
    expect(source!.querySelector('pre')!.textContent).toBe(file)
    // ...and colored like Turtle.
    expect([...source!.querySelectorAll('.ttl-comment')].some((c) => c.textContent!.startsWith('# --- Sign in with a code'))).toBe(true)
    expect([...source!.querySelectorAll('.ttl-pname')].map((c) => c.textContent)).toContain('ui:SigninTooShort')
    // The order on the page: the example, then its explanation, with its source beside the diagram.
    const card = shown('[data-sem-c=card]').find((c) => c.textContent!.includes('Check your email'))!
    const order = shown('[data-sem-c=card], [data-sem-c=walkthrough]')
    expect(order.indexOf(card)).toBeLessThan(order.indexOf(how))
    expect(how.contains(source!)).toBe(true)
  })

  it('the todo example shows the todo app graph it runs', () => {
    const { shown } = example('Todo, two projections')
    const [source] = shown('[data-sem-c=source-view]')
    expect(source!.querySelector('.sem-source-path')!.textContent).toBe('src/examples/todo.ts')
    expect(source!.textContent).toContain('ex:page a c:Stack')
    expect(shown('[data-sem-c=walkthrough] h2').some((h) => h.textContent === 'How it works')).toBe(true)
  })
})
