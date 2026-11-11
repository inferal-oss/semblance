// semblance build [--single] [--config semblance.config.ts] [--out dir] [--base /]
//   Build the client with Vite (the project's vite.config, if any) and render every page of the
//   site beforehand: one HTML file per address, taken over by the client without rendering again.
//   --single: one self-contained file (every script, stylesheet and WASM inline).
// semblance serve [--assets dist] [--port 3000] [--embed] [--warm] [--config semblance.config.ts]
//   Serve the built client and render every other address per request (--warm: from runtimes
//   loaded once and moved to each address, src/server/warm.ts).
// semblance subset [--out ontology.ttl] [--config semblance.config.ts]
//   Write the part of Semblance's ontology the site's graphs use (docs/SUBSET.md), as Turtle: what
//   a server without a filesystem (a Cloudflare Worker, docs/WORKERS.md) loads in place of the whole.
// semblance migrate [paths] [--check] [--verify] [--json] [--from <release>] [--to <release>] [--accept-loss] [--changes dir] [--update]
//   Move a project's Turtle across framework versions (docs/MIGRATIONS.md, ontology/changes/).
// semblance changes [--json] [--since <release>]
//   The changes, each with its motivation, substance and guides.
// semblance render <address> [--config semblance.config.ts] [--template dist/404.html]
//   Print one address's page (or its root's HTML alone, without a template).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createHandler, listen, loadSite, namedGraphs, renderSite, siteOntology } from '../src/node/site.ts'
import { minifyTurtle } from '../src/node/turtle-min.ts'
import { appOntology } from '../src/node/load.ts'
import { semblance } from '../src/node/vite.ts'
import { renderDocument } from '../src/server/document.ts'

const [command, ...rest] = process.argv.slice(2)
// Moving a project across framework versions needs no site description, only its files.
if (command === 'migrate' || command === 'changes') {
  const { run } = await import('../src/migrate/cli.ts')
  process.exit(await run(command, rest))
}
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    config: { type: 'string', default: 'semblance.config.ts' },
    single: { type: 'boolean', default: false },
    out: { type: 'string' },
    base: { type: 'string' },
    assets: { type: 'string', default: 'dist' },
    port: { type: 'string', default: '3000' },
    host: { type: 'string', default: 'localhost' },
    embed: { type: 'boolean', default: false },
    warm: { type: 'boolean', default: false },
    template: { type: 'string' },
  },
})
const config = resolve(values.config!)
if (command !== 'help' && command !== undefined && !existsSync(config)) {
  console.error(`semblance: no site description at ${config} (export default defineSite({ root, graphs }) from '@inferal-oss/semblance/node')`)
  process.exit(1)
}

if (command === 'build') {
  const { build } = await import('vite')
  const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].map((f) => resolve(f)).find(existsSync)
  await build({
    configFile: viteConfig ?? false,
    mode: values.single ? 'single' : 'production',
    base: values.base,
    build: values.out ? { outDir: resolve(values.out) } : undefined,
    // The project's config may have the plugin already; then this one stands aside.
    plugins: [
      ...(values.single && !viteConfig ? [(await import('vite-plugin-singlefile')).viteSingleFile({ removeViteModuleLoader: true })] : []),
      semblance({ config, single: values.single }),
    ],
  })
} else if (command === 'serve') {
  const site = await loadSite(config)
  const handler = createHandler({ site, assets: values.assets!, embed: values.embed, base: values.base, template: values.template, warm: values.warm })
  await listen(handler, Number(values.port), values.host)
  console.log(`semblance: serving ${values.assets} at http://${values.host}:${values.port}/, rendered per request`)
} else if (command === 'render') {
  const site = await loadSite(config)
  const address = positionals[0] ?? '/'
  const rendered = await renderSite(site, address, { base: values.base, styles: !!values.template })
  process.stdout.write(values.template ? renderDocument(readFileSync(values.template, 'utf8'), rendered, { mount: site.mount, attributes: rendered.attributes }) : rendered.html + '\n')
  rendered.runtime.dispose()
} else if (command === 'subset') {
  const site = await loadSite(config)
  // The site's subset (Site.subset, with its classes), else the subset of its graphs.
  const subset = (await siteOntology(site)) ?? appOntology(Object.values(await namedGraphs(site)))
  const turtle = minifyTurtle(subset.turtle)
  if (values.out) writeFileSync(values.out, turtle)
  else process.stdout.write(turtle)
  console.error(`semblance: ${subset.kept} of ${subset.total} statements${subset.whole ? ' (a class reached reads the whole ontology)' : ''}, ${(turtle.length / 1024).toFixed(0)} KiB`)
} else {
  console.log(`semblance build [--single] [--config semblance.config.ts] [--out dir] [--base /]
semblance serve [--assets dist] [--port 3000] [--embed] [--warm] [--config semblance.config.ts]
semblance subset [--out ontology.ttl] [--config semblance.config.ts]
semblance render <address> [--config semblance.config.ts] [--template dist/404.html]`)
  process.exit(command && command !== 'help' ? 1 : 0)
}
