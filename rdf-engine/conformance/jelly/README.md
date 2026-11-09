# Jelly-RDF conformance tests

The Jelly-RDF test suite of [jelly-protobuf](https://github.com/Jelly-RDF/jelly-protobuf) at
`v1.2.0` (commit `7c3773f6e3704440b445b30faa677516a45d3b60`), `test/rdf/`, as it is there, with
the Protobuf schema (`rdf.proto`). Apache License 2.0: `LICENSE`.

- `v1_2/from_jelly`, `v1_2/to_jelly`: Jelly-RDF 1.2 (version tag 3, the column layout).
- `v1_1/from_jelly`: Jelly-RDF 1.0 and 1.1 streams (the row layout), which a 1.2 reader reads too.
  The 1.1 "to Jelly" tests apply only to writers of 1.1, which Semblance has none of.

`npm run conformance -- --suite jelly --target wat|rust|ts` runs them (`../jelly.ts`).
