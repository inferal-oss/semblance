// Numbers for #383: what an app's subset of the ontology weighs and saves (examples/hello), and
// per-request rendering from a fresh store against a warm runtime (examples/hello, semblance.dev).
// Not a test; times depend on the machine.
//   npx tsx scripts/subset-measure.ts [hello|site]
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { appOntology, loadStore, loadStoreWithOntology, ontologySources } from '../src/node/load.ts'
import { loadSite, renderSite, siteRenderer } from '../src/node/site.ts'
import { minifyTurtle } from '../src/node/turtle-min.ts'
import { renderToString } from '../src/server/render.ts'
import { compileStyles } from '../src/style/compile.ts'

const which = process.argv[2]
const kib = (n: number) => (n / 1024).toFixed(0) + ' KiB'
const ms = (n: number) => n.toFixed(1) + ' ms'
const time = async <T>(f: () => T | Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now()
  const r = await f()
  return [r, performance.now() - t0]
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!

if (which !== 'site') {
  const read = (f: string) => readFileSync(new URL('../examples/hello/' + f, import.meta.url), 'utf8')
  const app = [read('tally.ttl'), read('app.ttl')]
  const whole = minifyTurtle(ontologySources().join('\n'))
  const [subset, subsetMs] = await time(() => appOntology(app))
  const part = minifyTurtle(subset.turtle)
  console.log('examples/hello')
  console.log(`  ontology: whole ${kib(whole.length)} (${kib(gzipSync(whole).length)} gzipped), subset ${kib(part.length)} (${kib(gzipSync(part).length)} gzipped); ${subset.kept} of ${subset.total} statements, ${subset.classes.size} classes reached; computed in ${ms(subsetMs)}`)
  const rows: Record<string, { load: number[]; render: number[]; css: number[]; bytes: number }> = {}
  for (let i = 0; i < 6; i++) {
    for (const [name, load] of [
      ['whole', () => loadStore('wat', ...app)],
      ['subset', () => loadStoreWithOntology('wat', subset.turtle, ...app)],
    ] as const) {
      const row = (rows[name] ??= { load: [], render: [], css: [], bytes: 0 })
      const [store, l] = await time(load)
      const [r, p] = await time(() => renderToString({ store, root: 'https://example.org/hello#page', styles: false }))
      const [css, c] = await time(() => compileStyles(store))
      // The first round warms the process up.
      if (i) row.load.push(l), row.render.push(p), row.css.push(c)
      row.bytes = css.length
      r.runtime.dispose()
      store.dispose?.()
    }
  }
  for (const [name, r] of Object.entries(rows)) console.log(`  ${name}: load ${ms(median(r.load))}, first projection ${ms(median(r.render))}, stylesheet ${ms(median(r.css))} (${kib(r.bytes)})`)
  const site = await loadSite(new URL('../examples/hello/semblance.config.ts', import.meta.url).pathname)
  const warm = siteRenderer(site, { styles: false })
  const cold: number[] = []
  const hot: number[] = []
  for (let i = 0; i < 8; i++) {
    const [c, t] = await time(() => renderSite(site, '/', { styles: false }))
    c.runtime.dispose()
    if (i) cold.push(t)
    hot.push((await time(() => warm.render('/')))[1])
  }
  console.log(`  per request: fresh store ${ms(median(cold))}, warm ${ms(median(hot.slice(1)))} (first ${ms(hot[0]!)})`)
  warm.dispose()
}

if (which !== 'hello') {
  const site = await loadSite(new URL('../semblance.config.ts', import.meta.url).pathname)
  const warm = siteRenderer(site, { styles: false })
  const routes = ['/', '/docs/rules/', '/components/inputs/', '/examples/todo/', '/examples/kanban/', '/reference/c:Window/', '/uk/docs/rules/']
  console.log('semblance.dev, per request (a fresh store / warm: first visit, again)')
  const first = new Map<string, number>()
  for (const url of routes) first.set(url, (await time(() => warm.render(url)))[1])
  for (const url of routes) {
    const [c, t] = await time(() => renderSite(site, url, { styles: false }))
    c.runtime.dispose()
    c.runtime.store.dispose?.()
    const again = (await time(() => warm.render(url)))[1]
    console.log(`  ${url.padEnd(22)} ${ms(t).padStart(9)} / ${ms(first.get(url)!).padStart(9)}, ${ms(again).padStart(8)}`)
  }
  console.log(`  ${warm.stats.cold} loads (one per language), ${warm.stats.warm} moves`)
  warm.dispose()
}
