# Semblance

A spike for an ontologically-defined web UI framework. A UI is a graph of
component instances described with RDF vocabularies. Rendering is an
incremental, stratified rewrite of that graph into an
[RDF/HTML](https://ia2.dev/spec/rdf-html) graph, which is then patched into the DOM.
Cross-cutting concerns (modality, style, positioning, accessibility, behaviour,
provenance, source) are **layers**: vocabularies plus rules that run after the
components and decorate their output. Interaction is recorded as RDF events in
a Linked Data Event Stream, and declarative reactions turn events into state.

```bash
npm install
npm run dev            # demo: Playground + Performance (http://localhost:5173)
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
- **Tooltip**: ontological tooltips from `rdfs:comment` / `c:tip`.
- **Validation**: fields point at SHACL property shapes (`val:validates`); the
  layer derives `c:error`, which fields already render, and disables buttons
  whose `val:requires` fields are invalid.
- **Keyboard**: `key:shortcut "mod+k"` on any component gives
  `aria-keyshortcuts`, a hint, and activation by key press (through the
  component's own click reactions). `c:ShortcutList` lists them all.
- **Status**: `st:busy` marks any component `aria-busy`; the theme shimmers it.
- **Localization**: labels are language-tagged literals; the viewer's language
  (`l10n:language`) is a projection setting; RTL languages flip the page.
- **Motion and contrast**: hookable properties of the shell
  (`mot:preference`, `sty:contrast`) whose values re-value the motion and role
  tokens for the subtree.

See [DESIGN.md](DESIGN.md) for the design system: foundations, the shared
variant axes (`sty:tone` × `sty:emphasis` × `sty:size`), and the component set.

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
Containers and controls: `c:Stack`, `c:Card`, `c:AppBar`, `c:Tabs` (detachable),
`c:Window`, `c:Desktop`, `c:Switch`, `c:Flippable`, `c:Heading`, `c:Button`,
`c:TextField`, `c:List`/`c:ListItem`, `c:Toggle`, `c:Progress`, and four controls
editing one property of one node with options drawn from its `rdfs:range`:
`c:Segmented`, `c:ThemeSwitcher`, `c:Choice` (dropdown) and `c:Chips` (pills).
Views: `c:Metrics`, `c:QueryView`, `c:Highlight`, `c:StreamStats`,
`c:StreamMembers`, `c:TriplesView`, `c:ProjectionView`, `c:BarChart`,
`c:Heatmap`, `c:LineChart`, `c:FindingList`. The whole demo (`demo/app.ttl`) is
built from these; the host only mounts it and performs effects of graph state.

A detached tab becomes a `c:Window` minted by its `c:Tabs`, derived from the tab
(`prov:wasDerivedFrom`), and hosted on a `c:Desktop` that is not part of any
page, so it survives navigation. Dock and close follow the provenance back.

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
| `ontology/layers/*.ttl` | modality, style, position, a11y, behaviour (+ LDES), provenance, tooltip |
| `ontology/components/*.ttl` | thin component vocabularies, their rules and reactions |
| `ontology/theme/default.ttl` | the default theme |
| `ontology/perf/perf.ttl` | observation vocabulary, SPARQL views and judgements |
| `ontology/vendor/` | RDF/HTML vocabulary snapshot (`npm run gen:vocab` regenerates `src/vocab`) |
| `src/engine/` | rule registry and incremental engine |
| `src/render/` | HtmlIndex, ordering, DOM patcher, serializers |
| `src/behaviour/` | event bus (LDES), reaction functions |
| `src/components/` | function implementations of rules (controls, views, charts, containers) |
| `src/store/` | Oxigraph, N3.js and hybrid store adapters |
| `bench/` | scenarios, primitives, observations + judgements, Node runner |
| `demo/` | the demo (boot, playground, performance view, benchmark cells) |

See [FINDINGS.md](FINDINGS.md) for benchmark results and what they imply.
