# Changelog

`@inferal-oss/semblance` and `@inferal-oss/semblance-react`, released together with one version.
Versions are 0.x: a minor release may break, a patch does not ([docs/RELEASING.md](docs/RELEASING.md)).
Each entry states the engines' ABI version (`rdf-engine/ABI.md`).

## Unreleased

## 0.1.0 (not yet published)

Engine ABI: 3.

The first release.

- `@inferal-oss/semblance`: compiled JavaScript with declarations for `.`, `./web`, `./node`,
  `./server` and `./virtual`; the ontologies (`./ontology/*`), the engines' WebAssembly
  (`./wasm/*`), the Vite plugin (`semblance` from `./node`) and the `semblance` command.
- `@inferal-oss/semblance-react`: React as the library under Semblance, `.` and `./server`.
