import { describe, expect, it } from 'vitest'
import { NetworkCapture } from '../src/network.ts'
import { loadStore } from '../src/node/load.ts'
import { NETWORK_GRAPH, NS } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'

const NET = NS.net
const HTTP = NS.http

function setup(extra = '') {
  const store = loadStore('oxigraph', extra)
  const runtime = new Runtime(store)
  let t = 0
  const fakeFetch = (async (input: RequestInfo | URL) => {
    t += 5
    const url = String(input)
    if (url.endsWith('/down')) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify({ ok: true, url }), { status: url.endsWith('/missing') ? 404 : 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const target: { fetch?: typeof fetch; WebSocket?: typeof WebSocket } = { fetch: fakeFetch }
  const capture = new NetworkCapture(runtime, { target, now: () => t })
  const original = target.fetch
  const detach = capture.attach()
  const f = store.factory
  const g = f.namedNode(NETWORK_GRAPH)
  const value = (s: string, p: string) => store.match(f.namedNode(s), f.namedNode(p), null, g)[0]?.object.value
  const members = () => store.match(f.namedNode(NET + 'Capture'), f.namedNode(NS.tree + 'member'), null, g).map((q) => q.object.value)
  return { store, runtime, capture, target, detach, value, members, f, g, original, tick: () => (t += 5) }
}

describe('network capture', () => {
  it('records a fetch as an HTTP exchange with its response', async () => {
    const { target, members, value, capture } = setup()
    await target.fetch!('/api/todos', { method: 'post', body: '{"title":"x"}', headers: { 'x-trace': 'abc' } })
    capture.flush()
    const [e] = members()
    expect(value(e, HTTP + 'methodName')).toBe('POST')
    expect(value(e, HTTP + 'absoluteURI')).toBe('/api/todos')
    expect(value(e, NET + 'status')).toBe(NET + 'Complete')
    expect(value(e, NET + 'body')).toBe('{"title":"x"}')
    expect(Number(value(e, NET + 'endedAt'))).toBeGreaterThan(Number(value(e, NET + 'startedAt')))
    const resp = value(e, HTTP + 'resp')
    expect(value(resp, HTTP + 'statusCodeValue')).toBe('200')
    expect(value(resp, NET + 'contentType')).toBe('application/json')
    expect(JSON.parse(value(resp, NET + 'body'))).toEqual({ ok: true, url: '/api/todos' })
    const header = value(e, HTTP + 'headers')
    expect(value(header, HTTP + 'fieldName')).toBe('x-trace')
  })

  it('marks failures and error statuses', async () => {
    const { target, members, value, capture } = setup()
    await target.fetch!('/missing')
    await expect(target.fetch!('/down')).rejects.toThrow()
    capture.flush()
    const [a, b] = members().sort((x, y) => Number(value(x, NET + 'sequence')) - Number(value(y, NET + 'sequence')))
    expect(value(a, NET + 'status')).toBe(NET + 'Failed')
    expect(value(value(a, HTTP + 'resp'), HTTP + 'statusCodeValue')).toBe('404')
    expect(value(b, NET + 'status')).toBe(NET + 'Failed')
    expect(value(b, NET + 'data')).toContain('Failed to fetch')
  })

  it('records events and spans', () => {
    const { capture, members, value } = setup()
    capture.event('Draft saved', { level: 'Success', data: { id: 1 }, correlation: 'c1' })
    const end = capture.span('Sync')
    capture.flush()
    const span = members().find((m) => value(m, NET + 'label') === 'Sync')!
    expect(value(span, NET + 'status')).toBe(NET + 'Pending')
    expect(value(span, NET + 'endedAt')).toBeUndefined()
    end()
    capture.flush()
    expect(value(span, NET + 'status')).toBe(NET + 'Complete')
    expect(value(span, NET + 'endedAt')).toBeDefined()
    const ev = members().find((m) => value(m, NET + 'label') === 'Draft saved')!
    expect(value(ev, NET + 'level')).toBe(NET + 'Success')
    expect(JSON.parse(value(ev, NET + 'data'))).toEqual({ id: 1 })
  })

  it('keeps only what the retention policy keeps, with everything that belongs to it', async () => {
    const { target, capture, members, store, g, runtime } = setup('@prefix net: <https://semblance.dev/ns/network#> . @prefix ldes: <https://w3id.org/ldes#> . net:CaptureRetention ldes:amount 3 .')
    for (let i = 0; i < 6; i++) await target.fetch!(`/r${i}`)
    capture.flush()
    expect(members()).toHaveLength(3)
    // Retired by the shared retention module, as the other logs are.
    expect(runtime.retention.get(NET + 'Capture')).toBeDefined()
    const subjects = new Set(store.match(null, null, null, g).map((q) => q.subject.value))
    // Only the capture stream and the three entries (and their minted nodes) remain.
    expect([...subjects].filter((s) => !s.includes('/~') && s !== NET + 'Capture')).toHaveLength(3)
    capture.clear()
    capture.flush()
    expect(store.match(null, null, null, g)).toHaveLength(0)
  })

  it('drops what arrives for an entry retired while it was in flight', async () => {
    const { members, store, g, f, runtime, detach, original } = setup('@prefix net: <https://semblance.dev/ns/network#> . @prefix ldes: <https://w3id.org/ldes#> . net:CaptureRetention ldes:amount 2 .')
    detach()
    let answer!: (r: Response) => void
    const target = { fetch: ((input: RequestInfo | URL, init?: RequestInit) => (String(input) === '/slow' ? new Promise<Response>((r) => (answer = r)) : original!(input, init))) as typeof fetch }
    const capture2 = new NetworkCapture(runtime, { target })
    capture2.attach()
    const slow = target.fetch!('/slow')
    for (let i = 0; i < 3; i++) await target.fetch!(`/r${i}`)
    capture2.flush()
    expect(members()).toHaveLength(2)
    answer(new Response('late', { status: 200, headers: { 'content-type': 'text/plain', 'x-late': '1' } }))
    await slow
    await new Promise((r) => setTimeout(r, 0))
    capture2.flush()
    // Every subject left belongs to a retained entry: nothing of the retired one came back.
    const kept = new Set(members())
    const owners = new Set(store.match(null, null, null, g).map((q) => q.subject.value.split('/~')[0]).filter((s) => s !== NET + 'Capture'))
    expect([...owners].every((s) => kept.has(s))).toBe(true)
    expect(store.match(null, f.namedNode(NET + 'body'), f.literal('late'), g)).toHaveLength(0)
    capture2.clear()
    capture2.flush()
    expect(store.match(null, null, null, g)).toHaveLength(0)
  })

  it('reads a streaming body only up to net:previewLimit', async () => {
    const { members, value, runtime, detach } = setup('@prefix net: <https://semblance.dev/ns/network#> . net:Capture net:previewLimit 10 .')
    detach()
    let pulled = 0
    let cancelled = false
    // A stream that never ends (server-sent events): a chunk whenever asked.
    const stream = () =>
      new ReadableStream<Uint8Array>({
        pull: (c) => void (pulled++, c.enqueue(new TextEncoder().encode('data: tick\n\n'))),
        cancel: () => void (cancelled = true),
      })
    const target = { fetch: (async () => new Response(stream(), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch }
    const c = new NetworkCapture(runtime, { target })
    c.attach()
    const response = await target.fetch('/events')
    await new Promise((r) => setTimeout(r, 10))
    c.flush()
    const [e] = members()
    const body = value(value(e, HTTP + 'resp'), NET + 'body')
    expect(body).toBe('data: tick…')
    expect(value(e, NET + 'status')).toBe(NET + 'Complete')
    expect(value(e, NET + 'size')).toBeUndefined() // not read to its end: its size is not known
    // The page's own reading goes on; the capture's stopped, so nothing is buffered for it.
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: tick\n\n')
    const before = pulled
    await new Promise((r) => setTimeout(r, 10))
    expect(pulled - before).toBeLessThan(4)
    void reader.cancel()
    await new Promise((r) => setTimeout(r, 0))
    expect(cancelled).toBe(true)
  })

  it('pauses while net:recording is false, and stops on detach', async () => {
    const { target, capture, members, runtime, f, detach, original } = setup()
    runtime.apply({ remove: [], add: [f.quad(f.namedNode(NET + 'Capture'), f.namedNode(NET + 'recording'), f.literal('false', f.namedNode(NS.xsd + 'boolean')))] })
    await target.fetch!('/quiet')
    capture.flush()
    expect(members()).toHaveLength(0)
    expect(target.fetch).not.toBe(original)
    detach()
    expect(target.fetch).toBe(original)
  })

  it('records a WebSocket connection and its frames', () => {
    const { capture, target, members, value, tick } = setup()
    class FakeSocket extends EventTarget {
      send(_data: string) {}
    }
    target.WebSocket = FakeSocket as unknown as typeof WebSocket
    capture.attach()
    const socket = new target.WebSocket('wss://example.test/live')
    socket.dispatchEvent(new Event('open'))
    socket.send('{"subscribe":"todos"}')
    socket.dispatchEvent(new MessageEvent('message', { data: '{"todo":1}' }))
    tick()
    socket.dispatchEvent(new Event('close'))
    capture.flush()
    const all = members()
    const c = all.find((m) => value(m, NET + 'url') === 'wss://example.test/live')!
    expect(value(c, NET + 'status')).toBe(NET + 'Closed')
    expect(value(c, NET + 'endedAt')).toBeDefined()
    const frames = all.filter((m) => value(m, NET + 'connection') === c)
    expect(frames.map((m) => value(m, NET + 'status')).sort()).toEqual([NET + 'Received', NET + 'Sent'])
  })
})
