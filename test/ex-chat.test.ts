import { describe, expect, it } from 'vitest'
import { ManualClock } from '../src/behaviour/clock.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
import { mountRemembering, mountSite } from './harness.ts'
import { loadStore } from '../src/node/load.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'
const CH = 'https://semblance.dev/demo/chat#'
const PER = 'https://semblance.dev/ns/persistence#'
const SEEDED = 16 // notes in # general before anyone types

type Mounted = ReturnType<typeof mountSite>

/** The site, on the Chat example, driven only through events (and, given a clock, time). */
function chatOn(h: Mounted) {
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const click = (el: Element) => h.fire(el, 'click')
  click(button('Examples'))
  click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Chat' && visible(b))!)
  const root = () => h.document.querySelector(`[data-sem-c=card]:has([data-sem-c=message-list])`) as Element
  const channels = () => [...h.document.querySelectorAll('[aria-label=Channels] button')].filter(visible)
  const channel = (name: string) => channels().find((b) => b.textContent!.startsWith('#' + name))!
  const thread = () => [...h.document.querySelectorAll('[data-sem-c=message-list]')].find(visible)!
  const messages = () => [...thread().querySelectorAll('[data-sem-c=message]')]
  const published = () => messages().filter((m) => !m.classList.contains('sem-pending'))
  const bodies = () => published().map((m) => m.querySelector('.sem-message-body')!.textContent)
  const typing = () => messages().filter((m) => m.classList.contains('sem-pending')).map((m) => m.querySelector('.sem-author')!.textContent)
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
  return { ...h, visible, button, click, root, channels, channel, thread, messages, published, bodies, typing, composer, type, press, unread }
}
const chat = (kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql', clock?: ManualClock) => chatOn(mountSite(kind, prefer, clock))

describe('the chat example', () => {
  it('lists the channels with their unread counts and shows the open thread', () => {
    const h = chat()
    expect(h.channels().map((b) => b.textContent)).toEqual(['#general', '#design3, 3 unread', '#releases1, 1 unread', '#help'])
    expect(h.channel('general').getAttribute('aria-pressed')).toBe('true')
    // The count is shown once and spelled out once.
    expect(h.channel('design').querySelector('.sem-count [aria-hidden=true]')!.textContent).toBe('3')
    expect(h.thread().getAttribute('role')).toBe('log')
    expect(h.thread().getAttribute('aria-label')).toBe('Messages in # general')
    expect(h.messages()).toHaveLength(SEEDED)
    const first = h.messages()[0]!
    expect(first.querySelector('.sem-author')!.textContent).toBe('Grace Hopper')
    expect(first.querySelector('time')!.getAttribute('datetime')).toBe('2024-05-14T08:31:00Z')
    expect(first.querySelector('time')!.textContent).toBe('08:31')
    expect(first.querySelector('[data-sem-c=avatar]')!.getAttribute('aria-label')).toBe('Grace Hopper')
    // In order of publication; Ada's own messages are marked as hers.
    expect(h.bodies()[5]).toBe("Thanks. I'll hold the demo data refresh until it's done.")
    expect(h.messages().flatMap((m, i) => (m.classList.contains('sem-mine') ? [i] : []))).toEqual([5, 9, 14])
  })

  it("puts the composer on one's own side, where one's own messages are", () => {
    const h = chatOn(mountSite('oxigraph', 'function'))
    // One notion for both: the composer's group aligns to c:OwnSide; one's messages sit there too.
    const area = h.composer().closest('[data-sem-align]')!
    expect(area.getAttribute('data-sem-align')).toBe('own')
    expect(h.messages().some((m) => m.classList.contains('sem-mine'))).toBe(true)
    // Both read the theme's own-side token (the inline end, which right to left mirrors).
    const css = compileStyles(loadStore('n3'))
    expect(css).toMatch(/\[data-sem-align="own"\] \{ align-items: var\(--sem-own-side\); \}/)
    expect(css).toMatch(/\.sem-mine \{[^}]*align-self: var\(--sem-own-side\)/)
    expect(css).toContain('--sem-own-side: flex-end;')
  })

  it('sends with the button and with Enter, not with Shift+Enter or when blank', () => {
    const h = chat()
    h.type('Appendix numbers checked - they hold.')
    h.click(h.button('Send'))
    expect(h.bodies()).toHaveLength(SEEDED + 1)
    expect(h.bodies().at(-1)).toBe('Appendix numbers checked - they hold.')
    expect(h.messages().at(-1)!.classList.contains('sem-mine')).toBe(true)
    expect(h.composer().value).toBe('')
    h.type('  And the export notes are in.  ')
    h.press('Enter', h.composer(), { shiftKey: true })
    expect(h.bodies()).toHaveLength(SEEDED + 1)
    h.press('Enter', h.composer())
    expect(h.bodies().at(-1)).toBe('And the export notes are in.') // trimmed
    expect(h.composer().value).toBe('')
    h.type('   ')
    h.press('Enter', h.composer())
    h.click(h.button('Send'))
    expect(h.bodies()).toHaveLength(SEEDED + 2)
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
    expect(h.unread('Releases')).toBe('1') // untouched
    h.type('Accent works for me.')
    h.click(h.button('Send'))
    h.click(h.channel('general'))
    expect(h.bodies()).toHaveLength(SEEDED) // sent to # design, not here
    h.click(h.channel('design'))
    expect(h.bodies().at(-1)).toBe('Accent works for me.')
  })

  it('plays the others’ script over time: typing, then the message in its place', () => {
    const clock = new ManualClock()
    const h = chat('oxigraph', 'sparql', clock)
    expect(h.typing()).toEqual([]) // nothing has happened yet: time has not moved
    clock.advance(0) // the scripts' first steps are long due: they start as soon as the chat is shown
    expect(h.typing()).toEqual(['Grace Hopper'])
    const pending = h.messages().at(-1)!
    expect(pending.querySelector('.sem-dots [aria-hidden], .sem-dots')!.getAttribute('aria-hidden')).toBe('true')
    expect(pending.textContent).toContain('Grace Hopper')
    expect(pending.querySelector('.sem-visually-hidden')!.textContent).toBe('is typing…')
    expect(pending.querySelector('time')).toBeNull()
    clock.advance(2400)
    expect(h.typing()).toEqual(['Grace Hopper'])
    clock.advance(100) // 2.5 s of typing
    expect(h.typing()).toEqual([])
    // The same entry is now the message.
    expect(h.messages().at(-1)).toBe(pending)
    expect(h.bodies().at(-1)).toContain('the review with the analytics team is Thursday at 14:00')
    expect(Date.parse(pending.querySelector('time')!.getAttribute('datetime')!)).toBe(clock.now())
    clock.advance(3000) // Tim's pause
    expect(h.typing()).toEqual(['Tim Berners-Lee'])
    clock.advance(2000)
    expect(h.bodies().at(-1)).toBe("I'll bring the export samples.")
    // Meanwhile Grace has written in # design, which is not open: its count went up.
    clock.advance(20_000)
    expect(h.bodies().at(-1)).toBe('Perfect, thanks Katherine.')
    expect(h.unread('Design')).toBe('5')
    expect(h.channel('design').textContent).toBe('#design5, 5 unread')
  })

  it('answers when you write, after a pause, and holds while the chat is not shown', () => {
    const clock = new ManualClock()
    const h = chat('oxigraph', 'sparql', clock)
    clock.advance(60_000) // let the scripts run out
    h.type('Great, see you all Thursday.')
    h.press('Enter', h.composer())
    expect(h.typing()).toEqual([])
    clock.advance(1500)
    expect(h.typing()).toEqual(['Grace Hopper'])
    clock.advance(2000)
    expect(h.bodies().slice(-2)).toEqual(['Great, see you all Thursday.', 'Thanks Ada!'])
    // The next reply is someone else's.
    h.type('One more thing: the room has moved to 4B.')
    h.click(h.button('Send'))
    // Leave the chat before the reply: the script waits, past its time, until the chat is back.
    h.click(h.button('Docs'))
    clock.advance(30_000)
    expect(h.scheduler.pending().some((p) => p.waiting)).toBe(true)
    h.click(h.button('Examples'))
    clock.advance(0)
    expect(h.typing()).toEqual(['Tim Berners-Lee'])
    clock.advance(2500)
    expect(h.bodies().at(-1)).toBe('Sounds good to me.')
  })

  it('gets an answer from the help desk bot', () => {
    const clock = new ManualClock()
    const h = chat('oxigraph', 'sparql', clock)
    h.click(h.channel('help'))
    h.type('I need access to the staging servers.')
    h.press('Enter', h.composer())
    clock.advance(1000)
    expect(h.typing()).toEqual(['Help desk bot'])
    clock.advance(1500)
    expect(h.published().map((m) => m.querySelector('.sem-author')!.textContent)).toEqual(['Help desk bot', 'Ada Lovelace', 'Help desk bot'])
    expect(h.bodies().at(-1)).toContain("I've logged that as a ticket")
  })

  it('hides sensitive messages in private mode, including ones sent as sensitive', () => {
    const h = chat()
    const sensitive = () => h.messages().flatMap((m, i) => (m.hasAttribute('data-sem-sensitive') ? [i] : []))
    expect(sensitive()).toEqual([8])
    h.click(h.document.querySelector('[data-sem-c=toggle-switch] [role=switch], [data-sem-c=toggle-switch][role=switch]')!)
    h.type('Door code for Thursday: 4417.')
    h.click(h.button('Send'))
    expect(sensitive()).toEqual([8, SEEDED])
    const privacy = () => h.store.match(h.store.factory.namedNode(UI + 'shell'), h.store.factory.namedNode('https://semblance.dev/ns/privacy#privacy'), null)[0]!.object.value
    const shell = () => h.document.querySelector('[data-sem-privacy]')!.getAttribute('data-sem-privacy')
    expect(shell()).toBe('conceal')
    h.press('h', h.document.body, { ctrlKey: true, shiftKey: true }) // ⌘⇧H / Ctrl+Shift+H
    expect(privacy()).toBe('https://semblance.dev/ns/privacy#Private')
    expect(shell()).toBe('private') // the theme blurs [data-sem-sensitive] under it
    h.press('h', h.document.body, { ctrlKey: true, shiftKey: true })
    expect(shell()).toBe('conceal')
  })

  it('renders the same with SPARQL and with function rules, typing included', () => {
    const [a, b] = [new ManualClock(), new ManualClock()].map((clock) => ({ clock, h: chat('oxigraph', 'sparql', clock) }))
    const fn = { clock: b!.clock, h: chatOn(mountSite('oxigraph', 'function', b!.clock)) }
    for (const { h, clock } of [a!, fn]) {
      h.type('Same either way.')
      h.click(h.button('Send'))
      clock.advance(0) // a note being typed in # general and in # design
      h.click(h.channel('design'))
    }
    expect(a!.h.typing()).toEqual(['Grace Hopper'])
    // The new notes' IRIs come from their events, which differ per run; so do their times.
    const html = (h: Mounted & { root: () => Element }) =>
      h.root().outerHTML.replace(/urn:semblance:event:[^"&]*/g, 'E').replace(/m-[A-Za-z0-9%-]+/g, 'm').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/>\d\d:\d\d</g, '>t<')
    expect(html(a!.h)).toBe(html(fn.h))
  })

  it('remembers the conversation on this device, the scripts where they were', async () => {
    const storage: Record<string, Backend> = { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
    const clock = new ManualClock()
    const a = chatOn(await mountRemembering(storage, clock))
    clock.advance(0)
    clock.advance(2500) // Grace's message is published; Tim is about to type
    clock.advance(1000)
    a.type('Saved for later.')
    a.click(a.button('Send'))
    clock.advance(2000) // Tim is typing
    expect(a.typing()).toEqual(['Tim Berners-Lee'])
    await (a as unknown as { persistence: { flush(): Promise<void> } }).persistence.flush()
    expect(await storage[PER + 'Device']!.get('semblance:' + UI + 'rememberChat')).toBeTruthy()

    // "Reload": a new page over the same storage, an hour later.
    const later = new ManualClock(clock.now() + 3_600_000)
    const b = chatOn(await mountRemembering(storage, later))
    expect(b.bodies().slice(-2)).toEqual([expect.stringContaining('analytics team'), 'Saved for later.'])
    expect(b.typing()).toEqual(['Tim Berners-Lee']) // his note is still being written
    later.advance(0) // its time has passed: it is published as soon as the chat is shown
    expect(b.typing()).toEqual([])
    expect(b.bodies().at(-1)).toBe("I'll bring the export samples.")
  })

  it('costs the same per message, sent or scripted, in a long thread as in a short one', () => {
    const clock = new ManualClock()
    const h = chat('oxigraph', 'sparql', clock)
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
    const measure = (act: () => void) => {
      const a = snapshot()
      act()
      const b = snapshot()
      return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]]))
    }
    clock.advance(60_000) // the scripts run out
    // Warm up until the toast region is full (it shows 3), so each send also retires one.
    const send = (text: string) => {
      h.type(text)
      return measure(() => h.click(h.button('Send')))
    }
    const reply = () => ({ typing: measure(() => clock.advance(2000)), published: measure(() => clock.advance(3000)) })
    for (const n of [1, 2, 3]) send(`warm-up ${n}`), clock.advance(10_000)
    const short = { sent: send('A message in a short thread.'), reply: reply() }
    clock.advance(10_000)
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
          f.quad(m, nn(AS + 'published'), f.literal(`2024-05-14T07:${String(i % 60).padStart(2, '0')}:00Z`, nn('http://www.w3.org/2001/XMLSchema#dateTime'))),
          f.quad(nn(UI + 'ch-general-thread'), nn('https://semblance.dev/ns/component#item'), m),
        ]
      }).flat(),
    })
    h.shell.flush()
    expect(h.messages().length).toBeGreaterThan(200)
    for (const n of [1, 2]) send(`warm-up again ${n}`), clock.advance(10_000)
    const long = { sent: send('A message in a long thread.'), reply: reply() }
    console.log('chat cost', JSON.stringify({ short, long }))
    expect(long).toEqual(short)
  }, 120_000)
})
