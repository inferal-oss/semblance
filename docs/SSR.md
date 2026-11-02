# Server-side rendering

A Semblance page can arrive already rendered: as files a static host serves (built
beforehand, one per address) or rendered per request by a server. The browser paints it before
any script runs. The client then loads the engine and the graph, projects the same graph at the
same address, and **takes the page over**: it pairs the nodes of its projection with the DOM the
HTML parser made, in document order, without creating any. Clicks and typing that happened in
between are kept and replayed. The design and the measurements behind it are in
[#201](https://github.com/inferal-oss/semblance/issues/201).

On semblance.dev, a cold load's first paint went from 908 ms to about 300 ms on a desktop and
from 9.8 s to under 1 s on a throttled phone (Slow 4G, CPU slowed 4×). The page becomes
interactive when its client has loaded and taken it over. Until then, links work: they are
real links to pages of their own.

## The pieces

| what | where |
|---|---|
| A site description: root, graphs, what the host writes before projecting | `defineSite` (`src/server/site.ts`) |
| One address rendered: the root's HTML, the stylesheet, `lang`/`dir`, the status | `renderToString` (`src/server/render.ts`) |
| The same as a stream: the head goes out first, the root once the rules are done | `renderToStream` (`src/server/stream.ts`) |
| A whole document from the client build's `index.html` | `renderDocument` (`src/server/document.ts`) |
| Every address of a site, beforehand | `buildSite`, the Vite plugin `semblance()`, `semblance build` |
| Per request, in Node (or anything with the Fetch API's `Request`/`Response`) | `createHandler`, `listen`, `semblance serve` |
| The client's side: adopt, skip the stylesheet, replay | `mount()` (automatic), `takeOver` (`src/web/takeover.ts`) |

`@inferal-oss/semblance/server` is platform-neutral: it renders a store that you load (Deno and
workers pass the engine's WebAssembly module themselves). `@inferal-oss/semblance/node` adds
loading, the static build, the request handler and the Vite plugin.

## A site

```ts
// semblance.config.ts
import { readFileSync } from 'node:fs'
import { defineSite } from '@inferal-oss/semblance/node'

const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')

export default defineSite({
  root: 'https://example.org/hello#page', // what the client mounts
  graphs: () => [read('tally.ttl'), read('app.ttl')], // the app's Turtle
  // setup(store, { single })  after loading, before the address is read
  // prepare(store)            after the address is read, before projecting
  // layers(store), prefer, functions, documentAttributes(store), routes(found)
})
```

The rule is that the server and the client must do the same things to the graph, in the same
order, before their first projection. `mount()` reads the address, runs `prepare` and projects in
the graph's language. A host with its own start sequence (the site's `demo/main.ts`) shares those
writes with its site description (`demo/site.ts`). That is what makes the page the client renders
first the same as the page it received, node for node. A test checks it
(`test/ssr.test.ts`).

## Building a static site

```bash
npx semblance build            # dist/: the client, and one rendered page per address
npx semblance build --single   # one self-contained file, rendered too
```

Or add the plugin to your Vite config:

```ts
import { semblance } from '@inferal-oss/semblance/node'
export default defineConfig({ plugins: [semblance({ config: 'semblance.config.ts' })] })
```

After the client is built, the plugin:
- renders each address the site's location names (`routesOf`): every combination of its path
  dimensions' values (`nav:Path`), in every language it carries, including a section's parent on
  its own (`/docs/` as well as `/docs/rules/`);
- writes each to `<path>/index.html`, from a fresh store, on worker processes;
- writes the stylesheet once (`semblance.css`, which the client does not compile again);
- writes `404.html`, the client alone, for any other address;
- with `preload: true`, puts in each page's head a `modulepreload` for the modules the first
  moments need and a `preload` for the engine's WASM. This is off by default: the preloads share
  the network with the stylesheet that the first paint waits for. semblance.dev on a throttled
  phone painted at 1.9 s with them and at 0.9 s without; it was interactive 0.6 s sooner with
  them.

semblance.dev has 216 pages: 54 places in 4 languages. They render in about 16 s on 4 workers.

With `--single` (or Vite's mode `single` and vite-plugin-singlefile), the one file is rendered
with everything inline: the scripts, the stylesheet, and the WASM of the engine and the layout
solver. A file has no paths, so the site description's `setup` moves where we are into the
fragment (`carryInFragment` in `demo/site.ts`).

## Paths

A page of its own needs an address a server sees, so a location's dimensions are carried by the
path (`nav:Path`, `ontology/layers/navigation.ttl`): `/docs/rules/`, `/uk/components/inputs/`.
The path starts at the location's `nav:base` (`setBase`; Vite's `base`). A value marked
`nav:implicit` is left out (English: `/docs/`, not `/en/docs/`; the home page: `/`). A link spells
what shows its resource, and keeps where we are for the rest: the language, and the page for what
is on every page. The navigation effect takes over clicks on links to the location's own paths
(a step in the history, not a page load). A fragment that spells path dimensions, as links did
before paths, is still read, and the address is rewritten as a path. The
target stays in the fragment: `/components/inputs/#inp-codes-spec`. The Reference's term is a
path too (`/reference/c:Window/`); it is shown in place (`nav:rendersInPlace`), so the build
renders a language's terms one after another in one runtime rather than each from a fresh store.

A link that keeps where we are reads a value its focus cannot reach (the language is a property of
the app, not of the link). Its rendering says so with `sem:readsLocation`. Each link's
destination also states which dimensions it kept (`nav:keeps`), and the engine re-runs it only
when one of those changes. A language switch re-runs every link. A page switch re-runs only the
links to what is on every page.

## Serving per request

```bash
npx semblance serve --assets dist --port 3000
```

```ts
import { createHandler, listen, loadSite } from '@inferal-oss/semblance/node'
const site = await loadSite('semblance.config.ts')
await listen(createHandler({ site, assets: 'dist' }), 3000)
```

The handler serves the built client's files as they are, and renders every other address for
the request from a fresh store. The status is 404 when no location names the address.
`embed: true` inlines the stylesheet: with a single-file client build as the template, a response
is one self-contained document. `createHandler` returns `(Request) => Promise<Response>`, so it
also serves from Deno, Bun or a worker.

Rendering per request costs one load of the graph and one first projection. That is about 0.3 s
for semblance.dev's whole graph and a few milliseconds for a small app. A site that large is better
built beforehand. Forking a warm runtime would make per-request rendering of large graphs cheap;
that belongs to the engine (#9).

## What the visitor's settings do before scripts run

- **Colour scheme and reduced motion** follow the system in CSS (`light-dark()`,
  `sty:underMedia "(prefers-reduced-motion: reduce)"`), so the HTML is right without a script.
- **The language** is part of the path, so each language's page is rendered as it is.
- **Remembered choices** (a theme picked this session, the inspector open) are restored by the
  client. What differs from the page as rendered is patched at takeover, like any change.

## Taking over

`DomRenderer.adopt()` walks the index and the DOM together:
- it splits text nodes the parser joined, and creates empty ones;
- it skips comments;
- it compares tag names case-blind, because a parser may lower SVG names;
- on a mismatch (another tag, other attributes) it patches that node as a flush would, and counts it.

Host-owned slots keep their content: islands' custom elements, live examples.

## Live examples

A live example (`c:LiveExample`) runs in a sandbox of its own: a store, a runtime and projections
of its own (`src/sandbox.ts`). With `sandboxes` in the render options (`renderSite` and the
build pass them: a store of the site's kind), the server builds the sandbox of every example the
page shows, as the browser builds it: the same sources, the same languages, the same turn limit
(1.5 s). It serializes the rendering, the text (`c:textPreview`) and the data's RDF editor
(`c:dataPreview`) into the example's slots, then lets the sandbox go: one sandbox per example
shown, built and disposed while the page renders (`prerenderSandboxes`). The page shows the
example before any script runs. Its frame says `data-sem-state="pending"` until the client's
sandbox runs.

A build that fails writes its problem to the page's graph, as the browser's host does. The frame
then shows it (`broken`), and the panes stay empty. A styled example (one that declares its own
`sty:` rules) carries its scoped styles in a `<style>` beside its rendering.

The client still builds a sandbox when its slot comes near the view (`Sandboxes`' `defer`), not
during the first moments. The first sandbox of a slot the server rendered takes its elements
over (`DomRenderer.adopt`, `Sandboxes.adopted`) rather than replacing them: its first projection
is the server's, so no node is created, and nothing flashes or moves. Its own stylesheet replaces
the server's `<style>`. The frame then reads `live`. A source edit remembered from earlier in the
session differs from what the server rendered, so it is patched, like any change. The server marks
each example's rendering `data-sem-ssr`, a region of its own to take over: what is done there before
its sandbox runs (a todo ticked, one typed and added) is kept and happens once the sandbox has
taken the region over, never on a control that changes while the graph does not.

`CAPTURE_SCRIPT` sits right before the mount element, so it runs before any of the HTML it keeps
events for has arrived. It keeps clicks (on anything but a link) and submits, holding them back,
and it keeps `input` and `change` while letting them happen (what was typed stays in the field); no
listener sees a kept event. After takeover, `replay()` dispatches
each kept event again on its element, except those in a region still marked `data-sem-ssr` (a live
example): they stay kept until that region's own takeover (`replayKept(region)`). The script stops
keeping once no region is left.

## Making the first moments cheap

The client's first projection is no longer on the first-paint path, but it is still the time to
interactive. Two things make it cheaper:
- **Provenance on demand** (`provenance: 'onDemand'`). PROV-O is recorded from the end of the
  run in which a rendering that reads it first runs: one whose SPARQL names what the engine
  writes, or one marked `sem:readsProvenance true` (the inspector, a card's back). It is then
  recorded for everything derived so far too. The site's landing page no longer pays for it, which
  was about 40% of its first rule run.
- **Deferred sandboxes:** a live example's store is built when its slot comes near the view.

## Without scripts

The pages work without scripts:
- **Links** are real links to pages of their own.
- **Choosers of a place:** a segmented control or a nav list over a dimension the path carries
  (the app bar's pages, the docs' sections) renders as a GET form of submit buttons. Each option
  has the address it sets as its `formaction` (`c:SegmentedDestination`), keeping where we are for
  the rest: the language, and the section the page remembers. With scripts, the navigation effect
  cancels the submit and the option's reaction sets the value, as for any click.
- **The Reference's terms** are pages too (`/reference/c:Window/`). They are rendered beforehand
  in English (about 1,600 pages; all four languages would be 650 MB). A term page in another
  language is rendered by the client, from `404.html`, like any address the build did not render.

What still needs the client: a choice made in a picker (the phone's compact form of those
choosers, a `<select>`), every control that changes the graph rather than the address, and
announcements.

## Bytes

A page needs part of the site's graphs to render, and a client that waits for all of them is
interactive late: the ontology and every example's graph are most of a phone's wait, since the page
itself paints from the HTML. So each page names the graphs its client needs first, and the client
loads those, takes the page over, and loads the rest in idle time (`Site.pageGraphs`,
`src/server/page-graphs.ts`).

- **The build finds them.** After rendering a page, it renders it again with function rules,
  whose reads are traced: a graph is needed when it states a triple the page read (a subject and
  predicate some rule read for something it renders), describes a rule with output, a node with
  output or a class of one. Reads made for the viewer (every term's label in its languages, kept
  whether or not a page shows it) are not counted.
- **The build checks them.** The page rendered from only those graphs must be the page rendered
  from all of them, byte for byte; otherwise it names none, and its client loads everything. A page
  rendered in place after another (a Reference term) names none either.
- **The page names them** in `<meta name="semblance-graphs">`: `ontology/<file>` for the
  framework's files, the site's own names (`demo/gallery/inputs.ttl`) for the rest. Each graph is
  a chunk of its own in the client build; with the plugin's `preload`, the page preloads those it
  names.
- **The client loads the rest** once it is interactive (`sem:ready`), in idle time: fetched, read
  a file per slice, then loaded as one change through the runtime (`Runtime.load`, or
  `runtime.apply` of parsed triples). Their rules join the running engine and are evaluated for
  what is shown, their reactions the bus, their remembered state is restored
  (`Persistence.restoreAdded`), and the live examples build from then (they need the whole
  ontology). A test takes pages over with only their graphs and loads the rest without a change
  (`test/ssr.test.ts`).

On semblance.dev a page names about 80 of the site's 189 graphs: 60% of the bytes. The shell reads
much of the rest itself (the taskbar lists every window, the theme menu every theme, the command
palette every command). On a throttled phone (Slow 4G, CPU slowed 4×, HTTP/2), the landing page is
interactive at 9.1 s instead of 9.8 s, an example's page at 9.3 s instead of 10.1 s, with the
first paint unchanged (1.8 s): it sends 1,085 KiB instead of 1,252 before it is interactive. The
rest follows in idle time, its change one task of about 2 s there (0.4 s on a laptop). With preloads, the graphs arrive earlier (interactive at 8.4 s) but
share the network with the stylesheet: the first paint waited until 4.5 s. Finer pieces than whole
files (a theme's name apart from its styles) would leave more for later.

The Vite plugin bundles the framework's ontology without its comments and indentation: the same
triples, 846 to 735 KiB gzipped. The examples' own Turtle is kept as written, because the site
shows it as their source.
