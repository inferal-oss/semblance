// How a page reaches a store elsewhere (docs/REMOTE.md): the protocol over HTTP, or anything that
// behaves the same. Apart from the remote-sources effect (src/remote.ts), so views following a
// source (src/views/remote.ts) take only this.
import { JELLY_MEDIA_TYPE, jellySourceEvents, type Pattern, serverSentEvents, type WriteRequest, type WriteResult } from './source-protocol.ts'

/** Where a source's store is, as the host decides: never read from the graph. */
export interface Endpoint {
  /** The protocol's base: `{url}/changes`, `{url}/writes`. */
  url: string
  /** Sent with every request (credentials). */
  headers?: Record<string, string>
  fetch?: typeof fetch
  /** Ask for the stream as Jelly (docs/JELLY.md), taking server-sent events from a server that answers with those. Default true. */
  jelly?: boolean
}

/** How the effect talks to a store: the protocol over HTTP (httpTransport), or anything that behaves the same. */
export interface SourceTransport {
  /** Deliver the stream's messages until it ends (resolve) or breaks (reject). */
  follow(patterns: Pattern[], after: number | undefined, on: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void>
  /** A write's answer; rejects when the store cannot be reached. */
  write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult>
}

/** The protocol of docs/REMOTE.md over HTTP: a Jelly stream or server-sent events, read with fetch (so headers go too); JSON writes. */
export function httpTransport(endpoint: Endpoint): SourceTransport {
  const base = endpoint.url.endsWith('/') ? endpoint.url : endpoint.url + '/'
  const go = (url: string, init: RequestInit) => (endpoint.fetch ?? globalThis.fetch)(url, init)
  return {
    async follow(patterns, after, on, signal) {
      const url = `${base}changes?patterns=${encodeURIComponent(JSON.stringify(patterns))}${after === undefined ? '' : `&after=${after}`}`
      const accept = endpoint.jelly === false ? 'text/event-stream' : `${JELLY_MEDIA_TYPE}, text/event-stream;q=0.9`
      const res = await go(url, { headers: { accept, ...endpoint.headers }, signal })
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`)
      if (res.headers.get('content-type')?.startsWith(JELLY_MEDIA_TYPE)) for await (const { event, data } of jellySourceEvents(res.body)) on(event, data)
      else for await (const { event, data } of serverSentEvents(res.body)) on(event, JSON.parse(data))
    },
    async write(req, signal) {
      const res = await go(`${base}writes`, { method: 'POST', headers: { 'content-type': 'application/json', ...endpoint.headers }, body: JSON.stringify(req), signal })
      if (res.status !== 200 && res.status !== 409) throw new Error(`${res.status} ${res.statusText}`)
      return (await res.json()) as WriteResult
    },
  }
}
