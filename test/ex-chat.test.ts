import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const CH = 'https://semblance.dev/demo/chat#'

/** The site, on the Chat example, driven only through events. */
function chat(kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite(kind, prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const click = (el: Element) => h.fire(el, 'click')
  click(button('Examples'))
  click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Chat' && visible(b))!)
  const root = () => h.document.querySelector(`[data-sem-c=card]:has([data-sem-c=message-list])`) as Element
  const channels = () => [...h.document.querySelectorAll('[aria-label=Channels] button')].filter(visible)
  const channel = (name: string) => channels().find((b) => b.querySelector('span:not([aria-hidden]):not(.sem-count):not(.sem-visually-hidden)')?.textContent === name || b.textContent!.includes(name))!
  const thread = () => [...h.document.querySelectorAll('[data-sem-c=message-list]')].find(visible)!
  const messages = () => [...thread().querySelectorAll('[data-sem-c=message]')]
  const bodies = () => messages().map((m) => m.querySelector('.sem-message-body')!.textContent)
  const composer = () => [...h.document.querySelectorAll('[data-sem-c=text-area] textarea')].find(visible) as HTMLTextAreaElement
  const type = (text: string) => {
    composer().value = text
    h.fire(composer(), 'input')
  }
  const press = (key: string, target: Element, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
    target.dispatchEvent(e)
  }
  const unread = (ch: string) => h.store.match(h.store.factory.namedNode(CH + ch), h.store.factory.namedNode(CH + 'unread'), null)[0]?.object.value
  return { ...h, visible, button, click, root, channels, channel, thread, messages, bodies, composer, type, press, unread }
}

describe('the chat example', () => {
  it('lists the channels with their unread counts and shows the open thread', () => {
    const h = chat()
    expect(h.channels().map((b) => b.textContent)).toEqual(['#general', '#design3, 3 unread', '#releases1, 1 unread', '#help'])
    expect(h.channel('general').getAttribute('aria-pressed')).toBe('true')
    // The count is shown once and spelled out once.
    expect(h.channel('design').querySelector('.sem-count [aria-hidden=true]')!.textContent).toBe('3')
    expect(h.thread().getAttribute('role')).toBe('log')
    expect(h.thread().getAttribute('aria-label')).toBe('Messages in # general')
    const first = h.messages()[0]!
    expect(first.querySelector('.sem-author')!.textContent).toBe('Grace Hopper')
    expect(first.querySelector('time')!.getAttribute('datetime')).toBe('2024-05-14T09:02:00Z')
    expect(first.querySelector('time')!.textContent).toBe('09:02')
    expect(first.querySelector('[data-sem-c=avatar]')!.getAttribute('aria-label')).toBe('Grace Hopper')
    // In order of publication; Ada's own message is marked as hers.
    expect(h.bodies()[3]).toBe("Thanks both. I'll fold the notes in this afternoon.")
    expect(h.messages().map((m) => m.classList.contains('sem-mine'))).toEqual([false, false, false, true, false])
  })

  it('sends with the button and with Enter, not with Shift+Enter or when blank', () => {
    const h = chat()
    h.type('Appendix numbers checked - they hold.')
    h.click(h.button('Send'))
    expect(h.bodies()).toHaveLength(6)
    expect(h.bodies().at(-1)).toBe('Appendix numbers checked - they hold.')
    expect(h.messages().at(-1)!.classList.contains('sem-mine')).toBe(true)
    expect(h.composer().value).toBe('')
    h.type('  And the export notes are in.  ')
    h.press('Enter', h.composer(), { shiftKey: true })
    expect(h.bodies()).toHaveLength(6)
    h.press('Enter', h.composer())
    expect(h.bodies().at(-1)).toBe('And the export notes are in.') // trimmed
    expect(h.composer().value).toBe('')
    h.type('   ')
    h.press('Enter', h.composer())
    h.click(h.button('Send'))
    expect(h.bodies()).toHaveLength(7)
    // Sending is announced.
    const toasts = [...h.document.querySelectorAll('[data-sem-c=toast-region] [data-sem-c=toast]')].map((t) => t.textContent)
    expect(toasts.some((t) => t!.includes('Message sent'))).toBe(true)
  })

  it('clears a channel’s unread count when it is opened, and keeps each thread', () => {
    const h = chat()
    expect(h.unread('Design')).toBe('3')
    h.click(h.channel('design'))
    expect(h.unread('Design')).toBe('0')
    expect(h.channel('design').textContent).toBe('#design')
    expect(h.channel('design').getAttribute('aria-pressed')).toBe('true')
    expect(h.bodies()).toEqual(['New empty-state illustrations are in the shared folder.', 'Love the second one. Can we try it with the accent color instead of gray?', 'Sure - give me ten minutes.'])
    expect(h.root().textContent).toContain('Grace Hopper is typing…')
    expect(h.unread('Releases')).toBe('1') // untouched
    h.type('Accent works for me.')
    h.click(h.button('Send'))
    h.click(h.channel('general'))
    expect(h.bodies()).toHaveLength(5) // sent to # design, not here
    h.click(h.channel('design'))
    expect(h.bodies().at(-1)).toBe('Accent works for me.')
  })

  it('gets a canned answer from the help desk bot', () => {
    const h = chat()
    h.click(h.channel('help'))
    h.type('I need access to the staging servers.')
    h.press('Enter', h.composer())
    const authors = h.messages().map((m) => m.querySelector('.sem-author')!.textContent)
    expect(authors).toEqual(['Help desk bot', 'Ada Lovelace', 'Help desk bot'])
    expect(h.bodies().at(-1)).toContain("I've logged that as a ticket")
  })

  it('hides sensitive messages in private mode, including ones sent as sensitive', () => {
    const h = chat()
    const sensitive = () => h.messages().map((m) => m.hasAttribute('data-sem-sensitive'))
    expect(sensitive()).toEqual([false, false, true, false, false])
    h.click(h.document.querySelector('[data-sem-c=toggle-switch] [role=switch], [data-sem-c=toggle-switch][role=switch]')!)
    h.type('Door code for Thursday: 4417.')
    h.click(h.button('Send'))
    expect(sensitive().at(-1)).toBe(true)
    const privacy = () => h.store.match(h.store.factory.namedNode(UI + 'shell'), h.store.factory.namedNode('https://semblance.dev/ns/privacy#privacy'), null)[0]!.object.value
    const shell = () => h.document.querySelector('[data-sem-privacy]')!.getAttribute('data-sem-privacy')
    expect(shell()).toBe('conceal')
    h.press('h', h.document.body, { ctrlKey: true, shiftKey: true }) // ⌘⇧H / Ctrl+Shift+H
    expect(privacy()).toBe('https://semblance.dev/ns/privacy#Private')
    expect(shell()).toBe('private') // the theme blurs [data-sem-sensitive] under it
    h.press('h', h.document.body, { ctrlKey: true, shiftKey: true })
    expect(shell()).toBe('conceal')
  })

  it('renders the same with SPARQL and with function rules', () => {
    const [a, b] = [chat('oxigraph', 'sparql'), chat('oxigraph', 'function')]
    for (const h of [a, b]) {
      h.type('Same either way.')
      h.click(h.button('Send'))
      h.click(h.channel('design'))
    }
    // The new message's IRI comes from its event, which differs per run; so does its time.
    const html = (h: typeof a) => h.root().outerHTML.replace(/urn:semblance:event:[^"&]*/g, 'E').replace(/m-[A-Za-z0-9%-]+/g, 'm').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/>\d\d:\d\d</g, '>t<')
    expect(html(a)).toBe(html(b))
  })

  it('costs the same to send a message in a long thread as in a short one', () => {
    const h = chat()
    const counters = { read: 0 }
    const { match } = h.store
    h.store.match = (...args) => {
      const quads = match.apply(h.store, args)
      counters.read += quads.length
      return quads
    }
    const snapshot = () => ({
      ruleRuns: h.screen.engine.stats.ruleRuns,
      written: h.screen.engine.stats.derivedAdded + h.screen.engine.stats.derivedRemoved,
      domOps: h.shell.ops,
      read: counters.read,
    })
    const send = (text: string) => {
      h.type(text)
      const a = snapshot()
      h.click(h.button('Send'))
      const b = snapshot()
      return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]]))
    }
    // Warm up until the toast region is full (it shows 3), so each send also retires one.
    for (const n of [1, 2, 3]) send(`warm-up ${n}`)
    const short = send('A message in a short thread.')
    // 200 more notes in the thread, as if the conversation had gone on all day.
    const f = h.store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const AS = 'https://www.w3.org/ns/activitystreams#'
    h.runtime.apply({
      remove: [],
      add: Array.from({ length: 200 }, (_, i) => {
        const m = nn(`${CH}bulk-${i}`)
        return [
          f.quad(m, nn(AS + 'attributedTo'), nn(CH + (i % 2 ? 'grace' : 'tim'))),
          f.quad(m, nn(AS + 'content'), f.literal(`Earlier message ${i}`)),
          f.quad(m, nn(AS + 'published'), f.literal(`2024-05-14T08:${String(i % 60).padStart(2, '0')}:00Z`, nn('http://www.w3.org/2001/XMLSchema#dateTime'))),
          f.quad(nn(UI + 'ch-general-thread'), nn('https://semblance.dev/ns/component#item'), m),
        ]
      }).flat(),
    })
    h.shell.flush()
    expect(h.messages().length).toBeGreaterThan(200)
    send('warm-up again')
    const long = send('A message in a long thread.')
    console.log('send cost', { short, long })
    expect(long).toEqual(short)
  }, 120_000)
})
