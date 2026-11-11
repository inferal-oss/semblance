# Releasing

Semblance is published to npm as two packages, released together with one version:

| package | what |
|---|---|
| `@inferal-oss/semblance` | the framework: `.` (the core), `./web` (the browser: `mount`), `./node` (Node: stores, sites, the Vite plugin), `./server` (server rendering), `./views` (maintained views on their own, `docs/VIEWS.md`; a `node` and a browser build), `./virtual` (types of the Vite plugin's module), `./ontology/*` (the Turtle), `./wasm/*` (the engines' WebAssembly), and the `semblance` command |
| `@inferal-oss/semblance-react` | React as the library under Semblance (`docs/HOSTED.md`): `.`, `./server` and `./views` (the hooks over views) |

Each release is a tag `v<version>` and a GitHub release whose notes are the changelog's entry.

## What a package is

Compiled JavaScript and declarations, never the TypeScript sources: a consumer needs no TypeScript
tooling to resolve them. `npm run build:package` (`scripts/build-package.ts`) compiles them:

- **One list of entries.** Each package's `exports` (and `bin`) is the list. Every entry has a
  `types` and a `default` condition naming its output (`./lib/src/web/index.js`); the build compiles
  the source at the same path (`src/web/index.ts`) and what it imports, and fails if an export names
  a file it did not make. A new entry is one line in `exports`.
- **`lib/` mirrors the repository.** `lib/src/…`, `lib/rdf-engine/host/…`, `lib/bin/…`, and beside
  them the files the code reads at run time: `lib/ontology/` (less `ontology/vendor/`, which is read
  at build time only), the engines' `.wasm` (`lib/rdf-engine/build/`) and the layout solver's
  (`lib/layout-solver/build/`). The paths the sources use relative to their own module
  (`../../ontology/`, `import.meta.glob('../../rdf-engine/build/*.wasm')`) hold in the output.
  `semblance-react` builds into `packages/react/lib/`, its imports of the core left as imports of
  the package (a peer dependency).
- **The repository runs from source.** Vite and Vitest resolve the packages by name to `src/`
  (`vite.config.ts`), tsx and TypeScript through `tsconfig.json`'s `paths`, and `bin/semblance.mjs`
  runs `bin/semblance.ts` where it is there (in the package it runs `lib/bin/semblance.js`). `lib/`
  is never read by the repository's own dev server or tests; it is not committed.
- **The tarball carries what runs, nothing else:** `lib/`, `bin/semblance.mjs`, `package.json`, the
  README and the two licence texts. `npm pack --dry-run` lists it. The types a public declaration
  names (`@rdfjs/types`, `@types/n3`) are dependencies, not dev dependencies.

`npm pack` runs the build first (`prepack`: the engines, the layout solver, then the packages).

## The check

`npm run pack:check` (`scripts/pack-check.ts`; the Package workflow runs it on every pull request
and push to `main` that touches what ships) is the consumer's view:

1. Build, and pack both packages.
2. Check each tarball: only run-time files, no TypeScript sources, every export's file, both
   licence texts, every `.wasm` built in the checkout, not `ontology/vendor/`.
3. Install the tarballs into an empty project with `examples/hello`, with the Vite configuration
   [Getting started](GETTING-STARTED.md) gives an app.
4. `vite build`: the page is rendered beforehand and the bundle has an engine's WebAssembly.
5. `renderToString` in Node, from the package's JavaScript with no TypeScript loader; the CLI
   (`semblance render /`); both React entries imported in Node.
6. `tsc` over the app, with `skipLibCheck: false`: the declarations of both packages type-check
   in a project that has only them and their dependencies.

It prints the engines' ABI version, for the release notes. `--keep` leaves the project in place to
look at; `--no-build` packs the `lib/` already built.

## Versions

Semantic versioning, in its 0.x form:

- **0.MINOR.0 may break.** Any change a consumer must act on (an export removed or renamed, a
  vocabulary term changed or removed, a rendering whose output changes for the same graph, a
  shape that now rejects what it accepted, an engine ABI change visible through the package's
  API) is a minor release, and its changelog entry says what to change.
- **0.minor.PATCH does not.** Fixes and additions that leave every graph and every call meaning
  what they meant.
- Both packages share the version. `semblance-react`'s peer range on the core is `^0.MINOR.0`,
  raised with every minor.
- 1.0 comes when the vocabularies are stable; from then on, ordinary semantic versioning.

## The changelog

[`CHANGELOG.md`](../CHANGELOG.md), newest first. Work that lands on `main` adds a line under
**Unreleased** when a consumer would notice it: what changed, for whom, and for a breaking change
what to do (with its issue or pull request). A release renames **Unreleased** to its version and
date, and every entry states:

- the **engine ABI** (`ABI_VERSION` in `rdf-engine/host/engine.ts`, `rdf-engine/ABI.md`; the check
  prints it). The engines' `.wasm` and their host move together, so a consumer who serves the
  WebAssembly themselves (`./wasm/*`, a Worker) must serve the release's own builds;
- breaking changes first, then additions, then fixes.

## Before a publish

On `main`, with every merge of the release in it:

1. `npm ci`, `npm run engine:build`, `npm run layout:build`.
2. `npx tsc --noEmit`.
3. `npm run test:full` (the full suite, AGENTS.md), green, or each failure re-run alone.
4. `npm run engine:check` and the Engines workflow green (parity, conformance, sizes, speed).
5. `npm run pack:check` and the Package workflow green.
6. The changelog's entry written, with the engine ABI.

## Publishing

1. Set the version in both `package.json` files and `semblance-react`'s peer range
   (`npm version <version> --no-git-tag-version`, there and in `packages/react`), and date the
   changelog's entry. Commit: `Release <version>`.
2. Tag the commit `v<version>` and push the tag.
3. Publish a GitHub release for the tag, its notes the changelog's entry. The Release workflow
   (`.github/workflows/release.yml`) checks that both versions are the tag's, runs the typecheck
   and the pack check, and publishes both packages with provenance, the core first
   (`publishConfig.access` is `public`). npm authenticates the workflow through trusted publishing
   (configured for both packages on npmjs.com, naming this repository and `release.yml`); a package
   not yet on npm has no trusted publisher, so its first publish uses the `NPM_TOKEN` secret.
4. Check: `npm view @inferal-oss/semblance version`, the provenance on the packages' npm pages, and
   an empty project that installs `@inferal-oss/semblance` from the registry and builds.

Until the first publish the root `package.json` keeps `"private": true`; dropping it is part of
that release.
