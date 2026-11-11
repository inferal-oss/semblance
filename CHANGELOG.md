# Changelog

`@inferal-oss/semblance` and `@inferal-oss/semblance-react`, released together with one version.
Versions are 0.x: a minor release may break, a patch does not ([docs/RELEASING.md](docs/RELEASING.md)).
Each entry states the engines' ABI version (`rdf-engine/ABI.md`).

## Unreleased

- `semblance migrate` moves a project's Turtle across framework versions, forward and back, including the SPARQL it holds, and reports what it cannot reach; `semblance changes` says what changed and why, for people and agents ([docs/MIGRATIONS.md](docs/MIGRATIONS.md), `@inferal-oss/semblance/migrate`, #473).
- Each component has a version, and a retired term is reported at run time, moved on the way in where it was renamed.

- A static build writes `semblance-graphs.json` beside its pages (the graphs each page names). A
  click while the rest of the graphs arrive takes in what the page reached names first, and the
  rest in slices, instead of everything in one long task (`arrive`, `src/slices.ts`).
- Maintained views: a template (`iv:targets`, `iv:perReferrer`) that arrives after start, before
  its referrers, now hears of the referrers rules derive.

## 0.1.0 (not yet published)

Engine ABI: 3.

The first release.

- `@inferal-oss/semblance`: compiled JavaScript with declarations for `.`, `./web`, `./node`,
  `./server` and `./virtual`; the ontologies (`./ontology/*`), the engines' WebAssembly
  (`./wasm/*`), the Vite plugin (`semblance` from `./node`) and the `semblance` command.
- `@inferal-oss/semblance-react`: React as the library under Semblance, `.` and `./server`.
