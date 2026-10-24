<img src="demo/favicon.svg" width="72" height="72" alt="Semblance">

# Semblance

An ontologically defined web UI framework. A UI is a graph of
component instances described with RDF vocabularies. Rendering is an
incremental, stratified rewrite of that graph into an
[RDF/HTML](https://ia2.dev/spec/rdf-html) graph, which is then patched into the DOM.
Cross-cutting concerns (modality, style, positioning, accessibility, behaviour,
provenance, source) are **layers**: vocabularies plus rules that run after the
components and decorate their output. Interaction is recorded as RDF events in
a Linked Data Event Stream, and declarative reactions turn events into state.

**Site:** <https://semblance.dev> - the docs, the component reference, the examples and the
benchmark matrix, running in your browser, itself a Semblance app. GitHub Pages cannot send
COOP/COEP headers, so the page is not cross-origin isolated: timings are coarser (~100 µs) and the
heap meter may read n/a. For precise numbers run `npm run dev`.

**Use it:** [Getting started](docs/GETTING-STARTED.md) builds a small app with a component of its
own; [Building components](docs/COMPONENTS.md) covers rules, reactions, layers and integrating
with your app; [AGENTS.md](AGENTS.md) has the ground rules for working on the framework. The npm
package will be `@inferal-oss/semblance` (not published yet).

```bash
npm install
npm run dev            # the site (http://localhost:5173)
npm test               # unit, integration, cost and soak tests
npm run bench          # Node benchmarks, one process per cell -> bench/results/ (md, json, ttl)
npm run build:single   # one self-contained, shareable file: dist-single/semblance.html (~6 MB)
```

## How it fits together

```
input graph (default graph)            ontology/  (components, layers, theme, rules, reactions)
  ex:add a c:Button ; c:label "Add" ; sty:intent sty:Primary .
        │
        │  Engine (src/engine): per-modality rule selection, stratified, incremental
        │    stratum -20 localization      → labels in the viewer's language
        │    stratum -10 validation layer  → c:error / val:invalid from SHACL shapes
        │    stratum 0   component rules   → RDF/HTML skeleton (+ nested instances)
        │    stratum 10  a11y, keyboard, status layers → ARIA relationships, shortcuts, aria-busy
        │    stratum 20  style hooks       → data-sem-* attributes (CSS compiled from the theme graph)
        │    stratum 90  debug layer       → data-sem-rule / data-sem-focus
        │    stratum 95  source layer      → flip control + "how this view is made" back side
        │    tooltip layer                 → ontological tooltips from rdfs:comment / c:tip
        │    + PROV-O for every rule evaluation (activity, agent, plan = the rule)
        ▼
derived graph (one named graph per projection)
        │  HtmlIndex (src/render): ordering normalization, change tracking, per-renderer dirty sets
        ▼
DomRenderer (keyed patching, host-owned slots)  ·  toHTML (SSR)  ·  toText

DOM interaction ──► EventBus ──► RDF event ──► reactions (SPARQL CONSTRUCT pairs) ──► one delta
                                     └──► member of the beh:ChangeLog LDES (with its effect)
```

### Rules and identity
- **Rules are data** (`sem:Rule`, a `prov:Plan`): a SPARQL `CONSTRUCT` or a
  registered function. Several implementations share a `sem:Rendering` slot and
  the engine picks one by preference and by what the store can run. Tests check
  that SPARQL and function variants render identical HTML.
- **Identity.** Rules mint IRIs as `<focus>/~<local>`, never blank nodes. Node
  identity is stable across re-evaluation, DOM nodes are reused, and the node IRI
  doubles as the DOM `id` (`label for`, `aria-describedby`).
- **Incrementality.** Each (rule, focus) pair owns an output set. Changes mark
  pairs dirty through the focus's own triples, `sem:follows` links, and (for
  functions) data-dependent `watches`. Outputs are diffed and reference-counted.
  A single-item update re-runs exactly one rule.
- **Demand.** A projection has mount roots; foci that are not shown under them
  (hidden tabs, the page you are not on, the unflipped back of a card) are parked,
  not evaluated. Showing them resumes their parked work. In idle time the host
  warms hidden views a slice at a time (`Runtime.warm`), so navigation finds them
  ready and an interaction never pays for them.
- **Member-wise rules** (`sem:forEach <property>`) evaluate once per
  (focus, member), so adding or re-sorting one list item touches only it.
- **Warmth.** In idle time the host evaluates hidden parts ahead of time, but
  only under a component that declares `sem:warm sem:Eager` (inherited down the
  rendered tree); everything else is lazy, evaluated when first shown.
  `sem:OnIntent` is in between: pointing at or focusing a choice (a navigation
  item, a tab) evaluates what it would show, and builds its DOM hidden, before
  the click. What a choice would show is itself graph data: `sem:IntentPreview`
  queries (`src/intent.ts`).
- **Bulk SPARQL.** A rule pending for several foci runs once, with
  `VALUES ?this { … }`, when its template is *attributable*: every triple it
  constructs has `$this`, or an IRI minted from it, as subject, so the rows can
  be split back per focus. Other rules run per focus. `sem:requires` skips a
  rule for a focus without the given property; `sem:inputOnly` keeps a layer
  rule from being re-triggered by derived data.
- **Ordering** uses RDF/HTML flat ordering (`hasChild` plus `ord:precedes` /
  `ord:immediatelyPrecedes`), which CONSTRUCT can emit. Ambiguity is an error.
  Siblings placed member-wise carry `sem:orderKey` and are sorted instead.

### Layers
- **Modality** is substitution: Screen and Text projections of one graph.
- **Style** is semantic: tokens, intents, densities, elevations and color
  schemes, compiled to custom properties, attribute hooks and `@layer`. The
  only style *rule* exposes hookable properties as `data-sem-*`. Subclasses
  inherit their superclass's style rules.
- **Position** is pure vocabulary riding on the style hooks.
- **A11y** decorates (ARIA relationships by IRI).
- **Provenance**: every derived node has `prov:wasGeneratedBy` or
  `prov:wasInfluencedBy` → activity → `prov:hadPlan` → the rule.
- **Source**: `c:Flippable` turns any component over to show the rules that
  made it (found through its PROV-O trail, syntax-colored).
- **Tooltip**: ontological tooltips from `sem:tooltip` annotations.
- **Validation**: fields point at SHACL property shapes (`val:validates`); the
  layer derives `c:error`, which fields already render, and disables buttons
  whose `val:requires` fields are invalid.
- **Keyboard**: `key:shortcut "mod+k"` on any component gives
  `aria-keyshortcuts`, a hint, and activation by key press (through the
  component's own click reactions). `key:Command` is a shortcut that belongs to
  no component: its press is an event its reactions handle (Z pauses the
  inspector). Component classes declare arrow-key navigation patterns
  (`key:navigation`: roving focus for menus, tabs, trees, accordions).
  `c:ShortcutList` lists every shortcut.
- **Component shapes**: SHACL node shapes on component classes
  (`ontology/shapes/components.ttl`); the shapes layer validates every
  component, records `sh:ValidationResult`s, outlines offenders and
  `c:ShapeReport` lists them.
- **Privacy**: `prv:concealed` hides any component (masked if a text field,
  blurred otherwise); `prv:sensitive` ones only in private mode (⌘⇧H).
- **Docs**: under each gallery specimen, the ontology of the classes it uses,
  as Turtle read from the graph that renders them.
- **Status**: `st:busy` marks any component `aria-busy`; the theme shimmers it.
- **Localization**: labels are language-tagged literals; the viewer's language
  (`l10n:language`) is a projection setting; RTL languages flip the page.
- **Motion and contrast**: hookable properties of the shell
  (`mot:preference`, `sty:contrast`) whose values re-value the motion and role
  tokens for the subtree.

- **Drag and drop** (`dnd:`): `dnd:Draggable` components carry a resource,
  `dnd:DropTarget`s receive it, and where it may go is SHACL - the carried
  resource must conform to the target's `dnd:accepts` shapes, and the target
  must still conform to its own (a `sh:maxCount` capacity) with one more member.
  The drag is graph state (`dnd:Current`); every target derives its reception
  (accepted, or refused with the shape's message), the theme shows it, and an
  ordered target marks the insertion point and the order key a drop would take
  (half way between the neighbours'). Over-events are unrecorded; a `dnd:Drop`
  is recorded and handled by the target's own reactions; a refused drop is a
  `dnd:Refusal` they never see, announced. Pointer (a long press on touch) and
  keyboard (Space, arrows, Space/Enter, Escape) drive it alike.
- **Announcements**: reactions say what they mean (`ann:announces`); a
  `c:ToastRegion` reading the change log shows them as toasts.
- **Themes**: `sty:theme` re-values every token for a subtree: Semblance,
  Paper, Terminal, Blueprint, Sunset; contrast and motion compose with them.
- **Network capture**: a host effect (`src/network.ts`) records the page's own
  fetches, WebSockets and the events and spans it reports as members of
  `net:Capture`, a bounded LDES in the network graph
  (`ontology/domain/network.ttl`, aligned with the W3C HTTP vocabulary).
- **Persistence**: `per:Policy` nodes say what to remember, where (this tab,
  this device, the browser database) and whether; a host effect restores them
  before the first render and writes them back; `per:StateLog` records every
  write and restore. See [PERSISTENCE.md](PERSISTENCE.md).
- **Navigation**: where we are is graph data. A `nav:Location` groups the
  dimensions of one app (`nav:Dimension`: a node's property, e.g. the page or the
  docs section), each saying where it is carried (the address's fragment or
  query, or a persistence scope), whether a change makes history (a step Back
  returns to) or not, and when it applies (`nav:parent` / `nav:when`: a docs
  section only on the docs). A host effect (`src/navigation.ts`) reads the address
  before the first render (the best `nav:rank` wins: address, then storage, then
  the graph's default), writes changes back as `#docs/rules`, and records Back,
  Forward and typed addresses as `nav:Navigate` events. A `c:Link` with `c:to` a
  resource goes to the location that shows it, found by walking up the component
  tree to the switches that show it (`#components/inputs/inp-codes-spec`), and the
  target is brought into view once rendered.

Our vocabularies are aligned with DCMI, SKOS, schema.org, ActivityStreams,
PROV-O and others in `ontology/alignments.ttl`, with the strength of each link
stated (equivalence, sub-class / sub-property, or SKOS match).

See [DESIGN.md](DESIGN.md) for the design system: foundations, the shared
variant axes (`sty:tone` × `sty:emphasis` × `sty:size`, `sty:textStyle`), and
the component set. The demo's **Components** page shows all of it.

### Behaviour: events, reactions, LDES
- A relevant interaction becomes an RDF event addressed to the innermost
  component with a matching `beh:Reaction`. The event records the hit RDF/HTML
  node, the value, and whether the control is checked.
- Reactions are `beh:deletes` / `beh:inserts` CONSTRUCTs over `$event` / `$this`,
  with function fallbacks for stores without SPARQL. All matching reactions see
  the pre-event state, and their union is applied as one delta.
- Each event, with the size of the change it caused, becomes an immutable
  member of the `beh:ChangeLog` `ldes:EventStream` (timestamp and sequence
  paths, a SHACL shape, a `tree:view`). The stream names its newest member
  (`beh:latest`), and each member names the one before it (`beh:previous`), so
  the N newest members are read in N steps.
- The log is **bounded**: the view's retention policy is a
  `beh:LatestMembersPolicy` with `ldes:amount 200` (an `ldes:DurationAgoPolicy`
  bounds by age instead). Retirement touches only the members that expire.
  Change the amount in the graph to trade history for per-event cost of the
  views that aggregate it. `c:StreamStats` is a component whose single SPARQL
  rule aggregates that stream.

### Components
Eighty-one component classes in nine groups (layout, type, actions, inputs,
feedback, data, navigation, overlays, disclosure), plus the views and charts
the demo is built from, and the inspection parts (a data grid with a time axis
and filters, split and docked panes, payload views, toolbar pieces; files
`grid`, `panes`, `payload`, `toolbar`, gallery page Inspection) that the
network inspector example is composed of; [DESIGN.md](DESIGN.md) lists them. Each group is one
file of each kind: `ontology/components/<group>.ttl` (the vocabulary,
renderings and reactions), `ontology/theme/<group>.ttl` (its styles),
`src/components/<group>.ts` (function rules and reactions) and
`demo/gallery/<group>.ttl` (its gallery page). The whole demo
(`demo/app.ttl`) is built from these; the host only mounts it and performs
effects of graph state.

A detached tab becomes a `c:Window` minted by its `c:Tabs`, derived from the tab
(`prov:wasDerivedFrom`), and hosted on a `c:Desktop` that is not part of any
page, so it survives navigation. Dock and close follow the provenance back.
Dialogs, drawers and toast regions are hosted there too.

The Playground's **Query** tab is a SPARQL workbench made of components
(`ontology/components/workbench.ttl`): an editor whose highlighting and
completions come from the graph (keywords, functions and every prefixed term the
store knows), sample queries, and results as a table, a graph or Turtle. Selecting
a node of the graph (`c:selectedTerm`, by click or Enter) highlights it and its
neighbourhood and dims the rest: a rule derives each mark's `c:Salience` from the
rendered links, so a selection re-runs that rule only, not the query. Like
any tab it can be detached into a window, and its state is remembered.

Every example on the **Examples** page explains itself with a **walkthrough**
(`ontology/components/walkthrough.ttl`): steps of text whose phrases are mentions of resources,
beside a sticky diagram of those resources and their links in the graph. Scrolling makes a step
current (graph state, unrecorded), its mentions' nodes stand out and curved arrows join each mention
to its node; activating a mention highlights its statement in the example's own Turtle beside the
diagram (each statement's lines are recorded with the source text), and a mention of a framework
term links to its page in the Reference.

The site's **Reference** is built the same way (`ontology/components/reference.ttl`):
a `c:TermTree` derived from the ontology itself (component groups by `sem:group`,
layers by what they render, every `owl:Ontology` by namespace), and views bound to
the selected term (`ui:referenceSubject`): what the ontology says about it and what
points at it, its alignments with the strength of each link (`sem:alignmentStrength`),
its neighbourhood as a graph, and its Turtle.

### Performance as data
Benchmark cells become `sosa:Observation`s. Every chart and table on the
Performance page is a `perf:View` (a SPARQL SELECT), and every insight is a
`perf:Finding` emitted by a `perf:Judgement` (a CONSTRUCT), all declared in
`ontology/perf/perf.ttl`. Each card shows its query on the back.

### Constant cost
The cost of an interaction depends on what it changes, not on how big the app
or its history is:
- demand-driven evaluation (above) keeps hidden views off the critical path;
- read tracing re-runs a function rule only when a triple it read changes;
- immutable LDES members are rendered once, by content-keyed views;
- the change log is bounded and read from its head;
- correlated sub-patterns in SPARQL use `EXISTS` / `LATERAL`, not `OPTIONAL` /
  `UNION`, which Oxigraph plans as scans.

Two tests guard this. `test/cost.test.ts` measures ten interactions (toggle,
type, hover, density, theme, tabs, page, source flip, window move, add) in
work counters: rule runs, derived triples written, triples matched, SPARQL
result rows and DOM operations. They must not grow when the list grows by 300
items and the history by 250 events. `test/soak.test.ts` runs 3,600 events on
the app's store and requires the graph, the engine's bookkeeping, the HTML
index, the DOM renderer and the time per event to stay flat. See
[FINDINGS.md](FINDINGS.md) for what they caught, including Oxigraph's
unpurged deletions and how the hybrid store works around them.

## Layout

| path | what |
|---|---|
| `ontology/core.ttl` | rules, renderings, strata, layers, slots |
| `ontology/layers/*.ttl` | modality, style, position, a11y, behaviour (+ LDES), provenance, tooltip, motion, validation, keyboard, status, l10n, announce |
| `ontology/components/*.ttl` | thin component vocabularies, their rules and reactions |
| `ontology/theme/*.ttl` | the default theme: foundations, variants, per-group styles |
| `ontology/perf/perf.ttl` | observation vocabulary, SPARQL views and judgements |
| `ontology/domain/` | domain vocabularies the demo views (network activity) |
| `ontology/vendor/` | RDF/HTML vocabulary snapshot (`npm run gen:vocab` regenerates `src/vocab`) |
| `src/engine/` | rule registry and incremental engine |
| `src/render/` | HtmlIndex, ordering, DOM patcher, serializers |
| `src/behaviour/` | event bus (LDES), reaction functions |
| `src/components/` | function rules and reactions, one module per group |
| `src/layers/` | function rules of the validation, keyboard, status, l10n and announcement layers |
| `src/store/` | Oxigraph, N3.js and hybrid store adapters |
| `src/persistence.ts`, `src/navigation.ts`, `src/intent.ts`, `src/network.ts` | host effects: remembering state, where we are (the address), intent preloading, network capture |
| `bench/` | scenarios, primitives, observations + judgements, Node runner |
| `demo/` | the demo (boot, playground, performance view, benchmark cells, `gallery/` pages, translations) |

See [FINDINGS.md](FINDINGS.md) for benchmark results and what they imply.

## License

Semblance is dual-licensed under either the [Apache License, Version 2.0](LICENSE-APACHE) or the
[MIT License](LICENSE-MIT), at your option (SPDX: `MIT OR Apache-2.0`). Unless you explicitly
state otherwise, any contribution you submit for inclusion is dual-licensed as above, without any
additional terms or conditions.
