# Getting started

Semblance describes an interface as an RDF graph: instances of component classes, wired to your
own vocabulary. Rules — SPARQL `CONSTRUCT`s — turn that graph into RDF/HTML, which is patched
into the DOM, kept up to date incrementally as the graph changes. Interaction becomes RDF events,
and reactions (more `CONSTRUCT`s) turn events into changes of the graph.

This guide builds a small app with one component of its own. The finished code is in
[`examples/hello`](../examples/hello); `npx vite --config examples/hello/vite.config.ts` runs it
from a checkout of this repository.

## Install

> The package is not published yet. Until it is, use a checkout of this repository (`npm install`,
> then `npm run engine:build`) or `npm pack` it and install the tarball.

```bash
npm install @inferal-oss/semblance
npm install --save-dev vite
```

Semblance ships TypeScript sources, its ontologies (Turtle) and its WebAssembly engines, and is
built by your bundler. Today that bundler is [Vite](https://vite.dev): the package finds its
ontology files and engine builds with `import.meta.glob`, which Vite resolves. Tell Vite not to
pre-bundle it (pre-bundling would skip those imports and break Oxigraph's WASM loader), but to
pre-bundle its Turtle parser, N3, which is CommonJS underneath:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    exclude: ['@inferal-oss/semblance', 'oxigraph'],
    include: ['@inferal-oss/semblance > n3'],
  },
})
```

## A page

The whole interface is data. Put it in a Turtle file:

```turtle
# app.ttl
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sty: <https://semblance.dev/ns/style#> .
@prefix pos: <https://semblance.dev/ns/position#> .
@prefix tok: <https://semblance.dev/ns/token#> .
@prefix ex: <https://example.org/hello#> .

ex:page a c:Stack ; pos:direction pos:Column ; pos:gap tok:space-4 ; pos:inset tok:space-6 ;
    c:children ( ex:title ex:drink ) .
ex:title a c:Heading ; c:level 1 ; c:label "Hello, Semblance" .
ex:drink a c:Button ; c:label "Have another" ; sty:intent sty:Primary .
```

and mount it:

```html
<!-- index.html -->
<div id="app"></div>
<script type="module" src="./main.ts"></script>
```

```ts
// main.ts
import { mount } from '@inferal-oss/semblance/web'
import app from './app.ttl?raw'

await mount(document.getElementById('app')!, { root: 'https://example.org/hello#page', graphs: [app] })
```

`mount` loads a store with Semblance's ontologies and your graphs, compiles the theme into a
stylesheet, projects `root` on screen, patches it into the element and routes the element's
events to reactions. It returns the pieces (`store`, `runtime`, `projection`, `renderer`, `bus`)
for when you need more.

The components you can use, with live specimens and their ontology, are on the site's
[Components](https://semblance.dev/#components) page; [Reference](https://semblance.dev/#reference)
has every term.

## A component of your own

A component is an OWL class under `sem:Component`, a rendering slot that targets it, and a rule
that implements the slot. Write the rule in SPARQL:

```turtle
# tally.ttl
ex:Tally a owl:Class ;
    rdfs:subClassOf sem:Component ;
    sem:slug "ex-tally" .          # becomes data-sem-c="ex-tally": prefix it, slugs are global
ex:unit a owl:DatatypeProperty ; rdfs:domain ex:Tally .

ex:TallyRendering a sem:Rendering ; sem:targets ex:Tally ; sem:stratum 0 .
ex:TallyRendering-sparql a sem:Rule ;
    sem:implements ex:TallyRendering ;
    sem:construct """
PREFIX ex: <https://example.org/hello#>
CONSTRUCT {
  ?root a rdfhtml:Div ; sem:renders $this ; rdfhtml:hasChild ?name, ?figure .
  ?name a rdfhtml:Span ; rdfhtml:class "ex-tally-label" ; rdfhtml:hasChild ?nameText ;
        ord:immediatelyPrecedes ?figure .
  ?nameText a rdfhtml:Text ; rdfhtml:data ?label .
  ?figure a rdfhtml:Strong ; rdfhtml:hasChild ?figureText .
  ?figureText a rdfhtml:Text ; rdfhtml:data ?shown .
}
WHERE {
  $this a ex:Tally ; c:label ?label .
  OPTIONAL { $this c:value ?value }
  OPTIONAL { $this ex:unit ?unit }
  BIND(CONCAT(STR(COALESCE(?value, 0)), IF(BOUND(?unit), CONCAT(" ", ?unit), "")) AS ?shown)
  BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root)
  BIND(IRI(CONCAT(STR($this), "/~name")) AS ?name)
  BIND(IRI(CONCAT(STR($this), "/~name-text")) AS ?nameText)
  BIND(IRI(CONCAT(STR($this), "/~figure")) AS ?figure)
  BIND(IRI(CONCAT(STR($this), "/~figure-text")) AS ?figureText)
}""" .
```

The rule builds [RDF/HTML](https://ia2.dev/spec/rdf-html): elements and text nodes as resources.
Every node it makes is an IRI minted from the component (`<component>/~local`), never a blank
node, so a node keeps its identity across re-evaluation and its DOM element is reused. The
prefixes Semblance knows (`sem:`, `c:`, `rdfhtml:`, `ord:`, …) are declared for you.

Use it like any other component, and load its file before the app:

```turtle
ex:cups a ex:Tally ; c:label "Coffee today" ; c:value 0 ; ex:unit "cups" .
ex:page c:children ( ex:title ex:cups ex:drink ) .
```

```ts
import tally from './tally.ttl?raw'
await mount(element, { root: 'https://example.org/hello#page', graphs: [tally, app] })
```

Say what an instance must have with a SHACL shape — the shapes layer checks every instance and
outlines the ones that do not conform — and how it looks with style rules, which compile into
the stylesheet and follow every theme through tokens:

```turtle
ex:TallyShape a sh:NodeShape ; sh:targetClass ex:Tally ;
    sh:property [ sh:path c:label ; sh:minCount 1 ; sh:message "A tally needs a label (c:label)." ] .

[] a sty:StyleRule ; sty:appliesTo ex:Tally ;
    sty:declares [ sty:property "display" ; sty:raw "grid" ] , [ sty:property "gap" ; sty:token tok:space-1 ] .
[] a sty:StyleRule ; sty:appliesTo ex:Tally ; sty:part "> strong" ;
    sty:declares [ sty:property "font-size" ; sty:token tok:text-2xl ] .
```

[Building components](COMPONENTS.md) covers rules in depth: containers, lists, text output,
reactions, layers, performance and testing, and when (rarely) to write a rule as a function.

## State and reactions

The tally's value is a triple, and so is every component's state: a text field's `c:value`, a checkbox's `c:checked`, a page
switch's property of your app node. Events change it through reactions: a click on the button should add a cup. A reaction names the
event class and its source, and says what to delete and what to insert, as `CONSTRUCT`s over
`$this` (the component) and `$event` (the event, with `beh:value`, `beh:checked`, `beh:node`):

```turtle
@prefix beh: <https://semblance.dev/ns/behaviour#> .

ex:Drink a beh:Reaction ;
    beh:when beh:Click ; beh:source ex:drink ;
    beh:deletes """PREFIX ex: <https://example.org/hello#>
CONSTRUCT { ex:cups c:value ?n } WHERE { ex:cups c:value ?n }""" ;
    beh:inserts """PREFIX ex: <https://example.org/hello#>
CONSTRUCT { ex:cups c:value ?next } WHERE { ex:cups c:value ?n BIND(?n + 1 AS ?next) }""" .
```

Every matching reaction sees the graph as it was before the event; their deletions and
insertions are applied together as one change, and only what depends on that change is
re-evaluated and patched. Each event is also recorded, with the size of its change, in the change
log (`beh:ChangeLog`), which the site's Tools show.

## Rendering on the server

The same graph renders to HTML or text without a DOM:

```ts
import { MOD, Runtime, toHTML } from '@inferal-oss/semblance'
import { loadStore } from '@inferal-oss/semblance/node'

const store = loadStore('wat', tally, app)
const screen = new Runtime(store).project({ modality: MOD.Screen, roots: [page] })
const html = toHTML(screen.index, page)
```

## Stores

`mount` uses Semblance's own WebAssembly engine (`wat`, about 30 KB) when the build has it, else
`hybrid` (Oxigraph plus an in-memory index). `oxigraph` and `rust` (the same engine, built from
Rust) are there too; `n3` has no SPARQL and runs only function rules. Choose with `store`.

## Next

- [Building components](COMPONENTS.md): rules, reactions, layers, integrating with your app.
- [PERSISTENCE.md](../PERSISTENCE.md): remembering state (`per:Policy`).
- [IVM.md](IVM.md): maintained views over streams.
- The site, <https://semblance.dev>, is itself a Semblance app (`demo/app.ttl`); its Tools
  (⌘.) show the graph, the rules behind any element, the change log and a SPARQL workbench.
