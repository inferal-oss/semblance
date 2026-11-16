// Where the core meets @semblance-dev/rdf-engine-wat. In this repository: the package's own module,
// over rdf-engine/build/ (each checkout runs its own engine build, never one a shared node_modules
// links to). In the package, scripts/build-package.ts writes this module as
// `export * from '@semblance-dev/rdf-engine-wat'`.
export * from '../../../packages/rdf-engine-wat/src/index.ts'
