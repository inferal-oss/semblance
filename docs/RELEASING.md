# Releasing

Semblance is published to npm under the `@semblance-dev` org as four packages, released together
with one version (the GitHub repository is `inferal-oss/semblance`):

| package | what |
|---|---|
| `@semblance-dev/rdf-engine-wat` | Semblance's SPARQL engine, the WAT build (`rdf-engine/wat/`): `.` (its `kind`, the engine `abi` it implements and its `wasm` URL) and `./wasm` (the WebAssembly itself, for a platform that imports `.wasm`, such as a Worker) |
| `@semblance-dev/rdf-engine-rust` | the same engine built from Rust (`rdf-engine/rust/`), the same results (the Engines workflow's parity tests); the same two entries |
| `@semblance-dev/semblance` | the framework: `.` (the core), `./web` (the browser: `mount`, `addEngine`), `./node` (Node: stores, sites, the Vite plugin), `./server` (server rendering), `./views` (maintained views on their own, `docs/VIEWS.md`; a `node` and a browser build), `./virtual` (types of the Vite plugin's module), `./ontology/*` (the Turtle), and the `semblance` command |
| `@semblance-dev/semblance-react` | React as the library under Semblance (`docs/HOSTED.md`): `.`, `./server` and `./views` (the hooks over views) |

Each release is a tag `v<version>`, which the Release workflow publishes from, and a GitHub release
whose notes are the changelog's entry.

## The engines' packages

Each engine package is its build's `.wasm` and a module that names it, its kind and the engine ABI it
was built for. The host that runs a build (`rdf-engine/host/`: strings in and out of linear memory,
the store over it, the `Intl` imports) is one for both builds and stays in the core: the core's own
formatting uses it whatever the store, and two copies of it would be two hosts to keep in step.

- **`@semblance-dev/rdf-engine-wat` is a dependency.** It is the default store (`mount`, `openStore`,
  `loadStore` in the docs, a Worker) and small (about 140 KB, 63 KB gzipped, beside Oxigraph's 8 MB,
  which the core depends on too). Leaving it out would make the common install two packages and every
  bundler configuration cope with its absence.
- **`@semblance-dev/rdf-engine-rust` is an optional peer dependency** (`peerDependenciesMeta`): npm
  does not install it unless the app does. It is three times the size and gives the same results, so
  it is a choice, not a default. In Node the core loads it when it is installed, and a `rust` store
  without it says what to install. In the browser a page adds it,
  `addEngine('rust', () => import('@semblance-dev/rdf-engine-rust'))`, so a bundle carries it only when
  the app asks for it, with no bundler configuration either way.
- **The ABI is checked twice.** Before the core loads a build it compares the package's `abi` with its
  host's `ABI_VERSION` (`rdf-engine/host/engine.ts`) and names the package to install when they
  differ; the engine's instance then checks its own `abi_version` export, which catches a build served
  apart from its package. The pack check fails when an engine package's `abi` is not the host's.
- **The core meets the packages in `src/store/engines/`.** In the repository those modules are the
  packages' own (`packages/rdf-engine-*/src/index.ts`, over `rdf-engine/build/`), so each checkout
  runs its own engine build, never the one a shared `node_modules` links to; in the package
  `build:package` writes them as `export * from '@semblance-dev/rdf-engine-…'`.

## What a package is

Compiled JavaScript and declarations, never the TypeScript sources: a consumer needs no TypeScript
tooling to resolve them. `npm run build:package` (`scripts/build-package.ts`) builds all four, each
package before the ones that import it:

- **One list of entries.** Each package's `exports` (and `bin`) is the list. Every entry has a
  `types` and a `default` condition naming its output (`./lib/src/web/index.js`); the build compiles
  the source at the same path (`src/web/index.ts`) and what it imports, and fails if an export names
  a file it did not make. A new entry is one line in `exports`.
- **The engine packages' `lib/`** is written, not compiled: `index.js` and `index.d.ts` (the kind, the
  ABI as a literal, `new URL('./<kind>.wasm', import.meta.url)`), `wasm.d.ts`, and the build copied
  from `rdf-engine/build/`.
- **The core's `lib/` mirrors the repository.** `lib/src/…`, `lib/rdf-engine/host/…`, `lib/bin/…`,
  and beside them the files the code reads at run time: `lib/ontology/` (less `ontology/vendor/`,
  which is read at build time only) and the layout solver's `.wasm` (`lib/layout-solver/build/`).
  The paths the sources use relative to their own module (`../../ontology/`) hold in the output.
  `semblance-react` builds into `packages/react/lib/`, its imports of the core left as imports of
  the package (a peer dependency).
- **The repository runs from source.** Vite and Vitest resolve the packages by name to their sources
  (`vite.config.ts`), tsx and TypeScript through `tsconfig.json`'s `paths`, and `bin/semblance.mjs`
  runs `bin/semblance.ts` where it is there (in the package it runs `lib/bin/semblance.js`). The two
  engine packages are npm workspaces, so `npm ci` takes the core's dependency on them from the
  repository; `lib/` is never read by the repository's own dev server or tests and is not committed.
- **The tarball carries what runs, nothing else:** `lib/` (and the core's `bin/semblance.mjs`),
  `package.json`, the README and the two licence texts. `npm pack --dry-run` lists it. The types a
  public declaration names (`@rdfjs/types`, `@types/n3`) are dependencies, not dev dependencies.

`npm pack` runs the build first (`prepack`: the engines, the layout solver, then the packages).

## The check

`npm run pack:check` (`scripts/pack-check.ts`; the Package workflow runs it on every pull request
and push to `main` that touches what ships) is the consumer's view:

1. Build, and pack the four packages.
2. Check each tarball: only run-time files, no TypeScript sources, every export's file, both
   licence texts, `publishConfig.access` public; each engine package's `.wasm` is the checkout's build
   and its `abi` the host's; the core carries the ontology (not `ontology/vendor/`) and no engine build.
3. Check the versions: one for all four, the core's engines pinned to it exactly, React's peer range.
4. Install the four tarballs into an empty project with `examples/hello`, with the Vite
   configuration [Getting started](GETTING-STARTED.md) gives an app.
5. `vite build`: the page is rendered beforehand and the bundle has the wat build's WebAssembly.
6. `renderToString` in Node with each engine, from the packages' JavaScript with no TypeScript
   loader (the same page from both); the CLI (`semblance render /`); both React entries in Node.
7. `tsc` over the app, with `skipLibCheck: false`: the declarations of all four type-check in a
   project that has only them and their dependencies (`addEngine` with the rust package, the
   `./wasm` entry).
8. In a second project, the core and its dependencies alone: npm leaves the rust engine out, the
   wat, N3 and Oxigraph stores work, and a rust store says to install it.

The Package workflow then runs the Release workflow's publish as `npm publish --dry-run`, package by
package in its order. It prints the version and the engines' ABI, for the release notes. `--keep`
leaves the tarballs and the projects in place to look at; `--no-build` packs the `lib/` already built.

## Versions

Semantic versioning, in its 0.x form, **one version for the four packages**, released together from
one tag:

- **0.MINOR.0 may break.** Any change a consumer must act on (an export removed or renamed, a
  vocabulary term changed or removed, a rendering whose output changes for the same graph, a
  shape that now rejects what it accepted, an engine ABI change visible through the package's
  API) is a minor release, and its changelog entry says what to change.
- **0.minor.PATCH does not.** Fixes and additions that leave every graph and every call meaning
  what they meant.
- **The core pins the engines exactly**: `@semblance-dev/rdf-engine-wat` at its own version, and
  `@semblance-dev/rdf-engine-rust` as a peer at its own version. The engines' `.wasm` and the host in
  the core move together by the ABI; one version and an exact pin keep a consumer from mixing a
  release's host with another's build, and npm reports a mismatched rust peer at install.
- `semblance-react`'s peer range on the core is `^0.MINOR.0`, raised with every minor.
- `npm run release:version -- <version>` (`scripts/release-version.ts`) sets all of it at once, and
  `--check <version>` (the Release workflow, with the tag's) fails unless it holds and no package is
  private.
- 1.0 comes when the vocabularies are stable; from then on, ordinary semantic versioning.

## The changelog

[`CHANGELOG.md`](../CHANGELOG.md), newest first. Work that lands on `main` adds a line under
**Unreleased** when a consumer would notice it: what changed, for whom, and for a breaking change
what to do (with its issue or pull request). A release renames **Unreleased** to its version and
date, and every entry states:

- the **engine ABI** (`ABI_VERSION` in `rdf-engine/host/engine.ts`, `rdf-engine/ABI.md`; the check
  prints it). The engines' `.wasm` and their host move together, so a consumer who serves the
  WebAssembly themselves (an engine package's `./wasm`, a Worker) must serve the release's own builds;
- breaking changes first, then additions, then fixes.

## Migrations in a release

A breaking change ships with a `chg:Change` in `ontology/changes/` (`AGENTS.md`, "When a component
changes"; [MIGRATIONS.md](MIGRATIONS.md)), so a consumer's move is `semblance migrate`, not a list of
edits. `npm run change -- changelog` prints the unreleased changes as changelog lines: paste them
under **Unreleased**'s breaking changes, with anything else a consumer needs to know.

## Before a publish

On `main`, with every merge of the release in it:

1. `npm ci`, `npm run engine:build`, `npm run layout:build`.
2. `npx tsc --noEmit`.
3. `npm run test:full` (the full suite, AGENTS.md), green, or each failure re-run alone.
4. `npm run engine:check` and the Engines workflow green (parity, conformance, sizes, speed).
5. `npm run pack:check` and the Package workflow green.
6. The changelog's entry written, with the engine ABI and its changes (`npm run change -- changelog`).
7. `npm run versions -- --check` passes. `npm run change -- release <version>`, and commit it: each
   change now says which release it shipped in, and `semblance migrate --from` depends on that.

## Set up on npmjs.com (by hand, once)

The repository cannot do this; an owner of the npm org does, on npmjs.com:

1. **The org.** `@semblance-dev` exists, and whoever publishes for the first time is an owner of it.
2. **A trusted publisher per package.** For each of `@semblance-dev/rdf-engine-wat`,
   `@semblance-dev/rdf-engine-rust`, `@semblance-dev/semblance` and `@semblance-dev/semblance-react`:
   the package's Settings → Trusted publishing → GitHub Actions, with the organization or user
   `inferal-oss`, the repository `semblance`, the workflow filename `release.yml`, and no environment.
   The workflow then publishes with its OIDC token, with provenance, and no npm token is stored.
3. **The first publish.** npm attaches a trusted publisher to a package that exists. If npmjs.com
   does not offer one for a name not yet published, the first release publishes each package once
   with a granular access token limited to `@semblance-dev` (as the secret `NPM_TOKEN`, which the
   workflow's npm reads as `NODE_AUTH_TOKEN`; add `env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }`
   to the publish step for that run), then step 2, then the secret is deleted.
4. **Package settings.** Under each package's Settings → Publishing access: "Require two-factor
   authentication and disallow tokens" once trusted publishing works, so only the workflow publishes.

In the repository, the Release workflow runs only once the Actions variable `NPM_PUBLISHING` is
`enabled` (Settings → Secrets and variables → Actions → Variables); until then a tag publishes
nothing.

## Publishing

The workflow is ready; publishing waits for the maintainer's go-ahead. A release:

1. On `main`, with [Before a publish](#before-a-publish) done: `npm run release:version --
   <version>`, date the changelog's entry, and, for the first release, drop `"private": true` from
   the four `package.json` files. Commit: `Release <version>`.
2. Tag the commit `v<version>` and push the tag. The Release workflow
   (`.github/workflows/release.yml`) checks that every package is the tag's version and none is
   private, runs the typecheck and the pack check, and publishes the four packages with provenance,
   `npm publish --provenance --access public`, the engines first, then the core, then React. A
   re-run skips the packages already on npm at that version.
3. Publish a GitHub release for the tag, its notes the changelog's entry.
4. Check: `npm view @semblance-dev/semblance version` (and the three others), the provenance on the
   packages' npm pages, and an empty project that installs `@semblance-dev/semblance` from the
   registry and builds.
