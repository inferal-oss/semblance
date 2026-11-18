// The files the site links to (a feed, Markdown for agents, llms.txt): each is written by the site's
// build (vite.config.ts) or is in demo/public/, so a followed link opens it, and link following
// (Navigation) leaves it to the browser instead of reading it as a page of the app (#572).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'
import { namesFile } from '../src/navigation.ts'
import config from '../vite.config.ts'

const root = new URL('../', import.meta.url)
const emitted = new Map<string, string>()

// The build's own plugins write their files, as `vite build` runs them (all of the site's text, past a hook's default limit).
beforeAll(async () => {
  const resolved = typeof config === 'function' ? await config({ command: 'build', mode: 'production', isSsrBuild: false, isPreview: false }) : config
  const plugins = (resolved.plugins ?? []).flat(Infinity as 1) as Plugin[]
  const emitFile = (f: { fileName: string; source: string }) => (emitted.set(f.fileName, String(f.source)), f.fileName)
  for (const name of ['semblance-llms', 'semblance-changes']) {
    const plugin = plugins.find((p) => p?.name === name)
    expect(plugin, name).toBeDefined()
    const hook = plugin!.generateBundle as unknown as (this: unknown) => Promise<void>
    await hook.call({ emitFile })
  }
}, 180_000)

/** What the site links to under its root, from its graph (c:href, a file's schema:contentUrl) and its page template. */
function siteLinks(): string[] {
  const texts = [readFileSync(new URL('demo/app.ttl', root), 'utf8'), ...readdirSync(new URL('demo/gallery/', root)).filter((f) => f.endsWith('.ttl')).map((f) => readFileSync(new URL('demo/gallery/' + f, root), 'utf8'))]
  const graph = texts.flatMap((t) => [...t.matchAll(/(?:c:href|schema:contentUrl)\s+"(\/[^"/][^"]*)"/g)].map((m) => m[1]!))
  const template = [...readFileSync(new URL('demo/index.html', root), 'utf8').matchAll(/<link\b[^>]*\bhref="(\/[^"/][^"]*)"/g)].map((m) => m[1]!)
  return [...new Set([...graph, ...template])].map((href) => href.split(/[?#]/)[0]!)
}

describe('the files the site links to', () => {
  it('are in the build: the Atom feed and the Markdown for agents', () => {
    expect(emitted.get('changes.atom')).toMatch(/^<\?xml[^>]*\?>\s*<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/)
    expect(emitted.get('llms/changes.md')).toMatch(/^# /)
    expect(emitted.has('llms.txt')).toBe(true)
  })

  it('are each written by the build or in demo/public/, and named as files (left to the browser)', () => {
    const files = siteLinks().filter(namesFile)
    expect(files).toEqual(expect.arrayContaining(['/changes.atom', '/llms/changes.md', '/llms.txt']))
    for (const path of files) expect(emitted.has(path.slice(1)) || existsSync(new URL('demo/public' + path, root)), path).toBe(true)
  })

  it('is told apart from a page by its path', () => {
    for (const page of ['/', '/changes/', '/changes/app-bar-one-row/', '/reference/c:Button/', '/index.html', '/docs/index.htm']) expect(namesFile(page), page).toBe(false)
    for (const file of ['/changes.atom', '/llms/changes.md', '/llms.txt', '/demo/app.ttl', '/data.json', '/export.jelly']) expect(namesFile(file), file).toBe(true)
  })
})
