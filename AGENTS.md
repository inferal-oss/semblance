# AGENTS.md

Guidance for AI agents (and people) building Semblance or building with it. Read
[README.md](README.md) for the architecture, [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) and
[docs/COMPONENTS.md](docs/COMPONENTS.md) for how to build, and [DESIGN.md](DESIGN.md) for the
design system.

## What Semblance is

An interface is an RDF graph. Components, layers, styles, behaviour, navigation, persistence and
validation are ontologies (`ontology/`); the app is instances of their classes wired to its own
vocabulary (the whole site is `demo/app.ttl` plus `demo/gallery/*.ttl`). Rules project the graph
into RDF/HTML, incrementally; a renderer patches it into the DOM, or serializes it as HTML or
text. Interaction becomes RDF events; reactions (`CONSTRUCT` pairs) turn them into one change;
every event is a member of a bounded LDES change log. The host code only mounts projections and
performs the effects of graph state (the address, storage, timers, network capture).

## Ground rules

1. **Ontology first.** A new capability is vocabulary plus rules plus shapes plus styles, in
   Turtle, not host code or a special case in TypeScript. If the host must act (a browser API),
   the graph says what and the host effect does it. State is triples.
2. **SPARQL first.** Every rendering and reaction has a SPARQL implementation for every modality
   it renders in. A function rule is an escape hatch and a test/performance oracle, never the only
   implementation. If SPARQL cannot express something, add a building block (put the input in the
   graph, a maintained view, an engine feature) rather than a function-only rule. The workbench
   sample "Renderings missing a SPARQL or function side" lists the gaps.
3. **Parity.** Where both exist, the SPARQL rule and its function twin render byte-identical HTML,
   and a test checks it after every step of an interaction.
4. **Identity.** Rules mint IRIs as `<focus>/~<local>`; never blank nodes. Exactly one node per
   component `sem:renders` it. Order siblings with `ord:` (an ambiguous order is an error).
5. **General, not local.** Fix the class of problem in the component, layer or theme, not the
   example where it showed up. When one theme or one example misbehaves, audit all of them.
6. **Constant cost.** An interaction costs what it changes, not the size of the app or its
   history. Keep templates attributable to `$this` (bulk evaluation), use `EXISTS` over correlated
   `OPTIONAL`, use member-wise rules (`sem:forEach`) for collections, bound streams with retention
   policies. `test/cost.test.ts` and `test/soak.test.ts` must stay green.
7. **Every theme, every width, every language.** Check new UI in all themes (including the
   structural ones: Classic, Tracker, Doodle, Cupertino, Fluent), light and dark, at phone width,
   and in an RTL language. Theme rules sit in a later cascade layer than component rules: a
   theme that redeclares a component's general property (a window's inset) overrides it everywhere.
   Labels come in English, Ukrainian, German and Arabic (`@en`, `@uk`, `@de`, `@ar`).
8. **Accessible by construction.** Use the WAI-ARIA pattern for the widget; ARIA relationships by
   minted IRI; keyboard patterns via `key:navigation`; announcements via `ann:announces`.
9. **Slugs are global.** `sem:slug` becomes `data-sem-c`; two classes with one slug share styles.
   Prefix slugs outside the framework (`"ex-tally"`).
10. **New ontology files** go into `ONTOLOGY_FILES` (`src/ontology.ts`) in load order; the dev
    server must be restarted to see a new file (Vite's glob is fixed at start).

## Building and testing

```bash
npm install
npm run engine:build   # Semblance's own SPARQL engines (WAT and Rust) into rdf-engine/build/
npm run dev            # the site, http://localhost:5173
npm test               # the suite (queued; see below)
npx tsc --noEmit       # typecheck
```

- **Tests go through the queue: at most two vitest runs at a time, machine-wide, first come first
  served, each with at most 4 workers.** Many concurrent runs have exhausted the machine's memory,
  and a plain lock starves older waiters. Always run tests as
  `scripts/test-queue.sh npx vitest run --maxWorkers=4 <files>` (`npm test` does this), in the
  foreground; from a worktree whose checkout predates the script, use the main checkout's copy by
  its absolute path. Never call `lockf` on the test lock directly: it jumps the queue. Run the files
  your change affects; the full suite runs before a push.
- A test that times out under a full run is re-run alone before it counts as a failure.
- The default store is Semblance's WASM engine (`wat`) with SPARQL rules preferred. A new query
  shape can be checked quickly with `npx tsx rdf-engine/host/parse-check.ts wat` and
  `test/rdf-engine.test.ts`. `rdf-engine/` is developed in its own session and branch; report
  engine gaps there rather than working around them silently.
- Drive features through events in tests (linkedom; `test/harness.ts`), as a person would, and
  assert both the DOM and the graph.
- Check visual work in the browser (`npm run dev`), not only in tests.

## Working in the repository

- Several agents often work at once. Do non-trivial work in your own git worktree
  (`git worktree add <dir> HEAD`, symlink `node_modules`, copy `rdf-engine/build/*.wasm`), and
  rebase onto `main` before committing.
- In a shared checkout, stage only your own hunks (`git add -p`, or `git apply --cached` of your
  patch); never `git add -A` / `git commit -a`.
- Commit at every verified step (typecheck and the relevant tests green) with a message that says
  what changed and why. Push `main` to `origin` (github.com/inferal-oss/semblance) when the full
  suite passes; GitHub Pages deploys the site from `main` to <https://semblance.dev>.
- Licence: `MIT OR Apache-2.0`. The npm package is `@inferal-oss/semblance`.

## Map

| path | what |
|---|---|
| `ontology/core.ttl` | rules, renderings, strata, layers |
| `ontology/components/` | component vocabularies, renderings, reactions |
| `ontology/layers/` | modality, style, position, a11y, behaviour, validation, keyboard, l10n, navigation, persistence, … |
| `ontology/shapes/` | SHACL shapes of components |
| `ontology/theme/` | tokens, component styles, themes |
| `src/engine/` | the incremental, stratified rule engine |
| `src/render/` | HtmlIndex, ordering, DOM patcher, HTML / text serializers |
| `src/behaviour/` | event bus, reactions, scheduler, clock |
| `src/view/` | maintained views (IVM, `docs/IVM.md`) |
| `src/components/`, `src/layers/` | function twins and reaction functions |
| `src/web/`, `src/node/` | store loading per platform; `mount` |
| `src/store/` | store adapters (Oxigraph, N3, hybrid); `rdf-engine/` has Semblance's own engines |
| `demo/` | the site (`app.ttl`, `gallery/`, `main.ts` is the host) |
| `examples/hello/` | the Getting started example |
| `test/` | unit, integration, parity, cost and soak tests |
