// Where the core meets @semblance-dev/rdf-engine-rust. In this repository: the package's own module,
// over rdf-engine/build/ (each checkout runs its own engine build, never one a shared node_modules
// links to). In the package, scripts/build-package.ts writes this module as
// `export * from '@semblance-dev/rdf-engine-rust'`.
export * from '../../../packages/rdf-engine-rust/src/index.ts'
