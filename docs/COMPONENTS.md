# Building components

A component is vocabulary plus rules. The class says what it is, a SHACL shape says what an
instance must say, renderings say what it looks like as RDF/HTML, reactions say what its events
do, and style rules say how it looks in every theme. All of it is Turtle, loaded into the same
store as the app that uses it, and all of it can be queried — the site's Reference and Tools are
built that way.

Start with [Getting started](GETTING-STARTED.md) for the smallest complete example.

## SPARQL first; functions are the escape hatch

Every rendering is implemented by one or more `sem:Rule`s. A rule is either a SPARQL `CONSTRUCT`
(`sem:construct`) or a function registered under a name (`sem:function`). **Write the SPARQL
rule.** It is the implementation: it is data, so it is inspectable (turn any component over with
the Source layer, or open the Inspector), portable across stores, and part of the graph you can
query and reason over.

A function rule is two things, and only these:

- **An escape hatch**, for the rare step SPARQL cannot express well. Reach for a building block
  first: put the missing input in the graph (a precomputed value, a view maintained by
  [IVM](IVM.md)) so a SPARQL rule can read it.
- **An oracle.** A function twin of a SPARQL rule renders the identical HTML, faster in the
  browser, and the tests compare the two after every step. Disagreement is a bug in one of them.
  The twins also give performance tests a baseline.

The engine picks one implementation per rendering by preference (`prefer: 'sparql'`, the
default) and by what the store can run. Turning SPARQL off is a debugging tool, not a mode to
design for: a component without a SPARQL rule is incomplete.

## Anatomy

```turtle
ex:Tally a owl:Class ;                       # 1. the class
    rdfs:subClassOf sem:Component ;
    rdfs:comment "A figure (c:value) with its label (c:label) and unit (ex:unit)."@en ;
    sem:slug "ex-tally" .                    #    data-sem-c="ex-tally": globally unique, so prefix it

ex:TallyRendering a sem:Rendering ;          # 2. a rendering slot
    sem:targets ex:Tally ;
    sem:stratum 0 .                          #    components are stratum 0; layers run around them

ex:TallyRendering-sparql a sem:Rule ;        # 3. its implementation(s)
    sem:implements ex:TallyRendering ;
    sem:construct """CONSTRUCT { … } WHERE { $this a ex:Tally … }""" .

ex:TallyShape a sh:NodeShape ;               # 4. what an instance must say
    sh:targetClass ex:Tally ;
    sh:property [ sh:path c:label ; sh:minCount 1 ; sh:message "…" ] .

[] a sty:StyleRule ; sty:appliesTo ex:Tally ;  # 5. how it looks (tokens, so every theme applies)
    sty:declares [ sty:property "gap" ; sty:token tok:space-1 ] .
```

Reuse the shared properties where they fit — `c:label`, `c:value`, `c:help`, `c:icon`,
`c:disabled`, `c:children`, `c:content`, `c:controls` / `c:property` (a control bound to a
property of another node) — and the shared variant axes (`sty:tone`, `sty:emphasis`, `sty:size`),
which the style layer already turns into `data-sem-*` hooks for every component that has them.
Capabilities are mixin classes: an instance that is also `c:Draggable`, `c:Flippable` or
`dnd:Draggable` gets that behaviour without its component knowing.

## Writing a rendering rule

A rendering rule runs once per instance (`$this`) and constructs RDF/HTML
([spec](https://ia2.dev/spec/rdf-html)):

- **Elements and text.** `?n a rdfhtml:Div` (any HTML element class), `rdfhtml:hasChild`,
  `?t a rdfhtml:Text ; rdfhtml:data "…"`. Attributes are `rdfhtml:class`, `rdfhtml:id`,
  `rdfhtml:type` and the like, or `rdfhtml:attribute [ rdfhtml:attributeName … ;
  rdfhtml:attributeValue … ]` as a minted node.
- **The root.** Exactly one node `sem:renders $this`. It is where the style hooks
  (`data-sem-c`, tone, size…) and the layers' decorations land.
- **Identity.** Mint every node from the focus: `BIND(IRI(CONCAT(STR($this), "/~label")) AS ?label)`.
  Never blank nodes. A minted IRI is stable across re-evaluation, so the DOM node is reused, and
  it doubles as the element's `id` for `label for`, `aria-labelledby` and `aria-describedby`.
- **Order.** Siblings are ordered with `ord:immediatelyPrecedes` (or `ord:precedes`); an
  ambiguous order is an error. Member-wise siblings carry `sem:orderKey` and are sorted instead.
- **Optional parts.** Bind an optional node to `?none` (unbound) when its data is missing:
  `BIND(IF(BOUND(?icon), IRI(CONCAT(STR($this), "/~icon")), ?none) AS ?iconNode)`. Unbound
  variables drop the triples that use them.
- **Nested components.** A container puts the child *component* under its element:
  `?root rdfhtml:hasChild ?child` where `?child` is the component IRI (e.g. a member of
  `c:children`). The renderer substitutes the child's own root. The child renders itself.
- **Text modality.** A projection has a modality, `mod:Screen` or `mod:Text`. A rule that only
  applies to one says so with `sem:modality`; write one per modality the component makes sense in.

Correlated sub-patterns are cheaper as `EXISTS { … }` inside `BIND(IF(…))` than as
`OPTIONAL` (some stores plan correlated `OPTIONAL`s as scans).

### What makes a rule re-run

Each (rule, focus) pair owns its output; the engine diffs outputs and patches only what changed.
A pair is dirty when the focus's own triples change, and also:

- `sem:follows c:of` — when the triples of the node the focus points at through `c:of` change
  (for components that show another node's data);
- `sem:watches c:value` — narrows it: only these predicates make the focus dirty;
- `sem:requires c:icon` — the rule is skipped for a focus without that property;
- `sem:inputOnly true` — derived triples (other rules' output) do not re-trigger it;
- `sem:forEach c:item` — the rendering is member-wise: evaluated once per (focus, member), so
  adding or re-sorting one item touches only that item.

A SPARQL rule pending for many foci runs once with `VALUES ?this { … }` when everything it
constructs hangs off `$this` or IRIs minted from it, so keep templates attributable.

### Strata and layers

Renderings run in strata: localization (-20) and validation (-10) before components (0), then
accessibility, keyboard and status (10), style hooks (20), debug and source (90+). A **layer** is
a set of renderings marked `sem:layer ex:MyLayer` and enabled per projection (`sem:enables` in
the graph, or `layers` in `mount`). Layers decorate what components render without the components
knowing: write a layer when the concern cuts across components (an audit outline, a privacy
mask, an analytics hook), not a flag on every component.

## Reactions

```turtle
ex:TallyReset a beh:Reaction ;
    beh:when beh:Click ;                 # beh:Click, beh:Input, beh:Change, beh:Focus, beh:Hover, …
    beh:sourceClass ex:Tally ;           # every instance (or beh:source ex:one for one instance)
    beh:deletes """CONSTRUCT { $this c:value ?v } WHERE { $this c:value ?v }""" ;
    beh:inserts """CONSTRUCT { $this c:value 0 } WHERE {}""" .
```

An event goes to the innermost component with a matching reaction. `$event` has `beh:value`
(the control's value), `beh:checked`, `beh:node` (the RDF/HTML node hit) and `beh:at`. All
matching reactions see the state before the event; their union is applied as one change and
recorded in the change log. Events marked `beh:recorded false` (hover, focus) are not logged.
Say what a reaction means for people with `ann:announces` (a toast and a live-region message).

Keyboard: `key:shortcut "mod+k"` on any component activates it by key; a class declares its
arrow-key pattern with `key:navigation` (roving focus for menus, tabs, trees).

## Validation and shapes

Two kinds of SHACL, both data:

- **Component shapes** (`sh:targetClass ex:Tally`) say what a well-formed instance is. The shapes
  layer records `sh:ValidationResult`s, outlines offenders and lists them in `c:ShapeReport`.
- **Input validation**: a field points at a property shape (`val:validates`); the validation layer
  derives `c:error` (which fields render) and disables buttons whose `val:requires` fields are
  invalid. Messages are `sh:message`, language-tagged.

## Styling

`sty:StyleRule`s compile into cascade layers (tokens, hooks, components, variants, intents).
`sty:appliesTo` a class styles its instances and subclasses; `sty:part` narrows to a selector
inside the component; `sty:when` narrows to a variant value or a theme. Use tokens
(`sty:token tok:…`) rather than raw values so themes, contrast, density and dark mode apply.
Structural themes (Classic, Tracker, Doodle…) add their own rules under `sty:when <theme>`; check
a new component in them.

Layout is the position layer's vocabulary (`pos:direction`, `pos:layout`, `pos:gap`…), exposed as
hooks in the lowest cascade layer: a component's own rule that sets the same property wins, so a
component defers to a hook it should not override with a `sty:state` such as
`:not([data-sem-direction])` (as `c:Surface` does). Two layouts make parts line up across siblings:

- **Rows that share columns.** A container declares its column tracks (a `pos:Layout` with
  `grid-template-columns`) and each row says `pos:layout pos:Subgrid`.
- **Columns whose parts line up.** A container says `pos:layout pos:AlignedColumns` (or is any grid
  of columns, such as a `c:Grid`, that says it): each child with parts takes its rows from it
  (`pos:rows pos:RowSubgrid`) and spans one row per part (`pos:rowSpan`). Both are derived, before the
  components render: the parts are a child's `c:children`, or what its class declares
  (`c:Card pos:rowParts 2`: a header and a body). So the tallest heading sets the heading row for all
  the columns on a line, and their bodies start together; where columns wrap (a phone) each line has
  rows of its own. A component whose style lays out its own parts must defer to the span
  (`:not([data-sem-row-span])`, as `c:Card` does), and should place optional parts in fixed rows
  (`c:TermCard`), so that a missing part does not shift the next one up a row. A rendering that mints
  components into a grid of its own says both properties on them (`c:TermMembers`).

## Localization

Labels are language-tagged literals (`c:label "Save"@en , "Зберегти"@uk`); the localization layer
picks the viewer's language into `l10n:label`, which rules read before `c:label`. Untagged
literals are the fallback. RTL languages flip the page.

## Testing a component

- **Render and interact** through events, as a person would: mount the graph in linkedom (see
  `test/hello-example.test.ts` and `test/harness.ts`), fire DOM events, check the DOM and the graph.
- **Parity**: when a rendering has a function twin, render with `prefer: 'sparql'` and
  `prefer: 'function'` and require identical HTML, after every step.
- **Cost**: count rule runs and DOM operations per interaction (`engine.stats`, `renderer.ops`) and
  bound them; they must not grow with the size of the data (`test/cost.test.ts`).
- **Shapes**: a well-formed instance has no violations; a malformed one has the one you expect.

## Integrating with your app

`mount` (from `@inferal-oss/semblance/web`) is the short way. The pieces it wires, for when you
need them yourself:

```ts
import { compileStyles, EventBus, MOD, Runtime } from '@inferal-oss/semblance'
import { DomRenderer, initWeb, loadStore } from '@inferal-oss/semblance/web'

await initWeb('wat')
const store = loadStore('wat', components, app)       // Semblance's ontology + yours
const runtime = new Runtime(store)                      // one graph, many projections
const screen = runtime.project({ modality: MOD.Screen, layers, roots: [root] })
const sheet = new CSSStyleSheet()                       // the theme, compiled from the graph
sheet.replaceSync(compileStyles(store))
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
const renderer = new DomRenderer(screen.index, element, root)
renderer.flush()
new EventBus(runtime, screen).attach(renderer, () => renderer.flush())
```

- **Your data in, your data out.** Change the graph with `runtime.apply({ add, remove })` (quads),
  or several changes as one tick with `runtime.transaction(() => …)`, then `flush()`. Read it with
  `store.match` or `store.select`. Keep domain data in your own vocabulary and point components at
  it (`c:of`, `c:controls` / `c:property`, `c:item`), so the same data can be shown many ways.
- **Several projections.** `runtime.project` again with another root or modality (a Text
  projection for a terminal or an accessibility summary); every change reaches all of them once.
- **Embedding.** Mount several roots into several elements of an existing page; or give a
  component a host-owned slot (`c:slot`) and mount anything you like into `renderer.slot(name)`.
- **Server-side.** `loadStore` from `@inferal-oss/semblance/node`, project, `toHTML` / `toText`.
- **Remembering state.** `per:Policy` nodes say what to keep where; attach `Persistence` with
  storage backends before the first projection ([PERSISTENCE.md](../PERSISTENCE.md)).
- **The address.** `nav:Location` and `nav:Dimension`s say which state lives in the URL;
  attach `Navigation` and links can point at resources (`c:to`) instead of addresses.
- **Idle work.** Call `runtime.warm(ms)` in idle time so hidden views are ready before they are
  shown; `sem:warm sem:Eager | sem:OnIntent` says which.

## Where things are

| | |
|---|---|
| `ontology/core.ttl` | rules, renderings, strata, layers |
| `ontology/components/<group>.ttl` | component vocabularies, renderings and reactions |
| `ontology/shapes/components.ttl` | component shapes |
| `ontology/theme/*.ttl` | tokens, styles, themes |
| `ontology/layers/*.ttl` | the layers |
| `src/components/<group>.ts` | function twins and reaction functions |
| `demo/gallery/<group>.ttl` | the Components page's specimens |
