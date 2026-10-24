# Engine ABI (version 1)

The contract every engine build implements: Rust (`rust/`) and hand-written
WebAssembly (`wat/`). One host adapter (`host/`) drives any of them, so the
conformance runner, Semblance's tests and the benchmarks see no difference
between them except speed and size.

The ABI is designed around what [FINDINGS.md](../FINDINGS.md) measured on
Oxigraph: crossing the boundary with strings and objects costs more than the
work behind it (4.4 µs to read a term, 16.7 µs to add and delete a quad, against
0.6 µs and 2.6 µs in N3.js), every per-focus query is re-parsed, and deleted
quads are never purged. So:

- **Terms cross once.** The engine interns every term and hands out a `u32` id.
  Strings cross the boundary when a term is first interned or first read; after
  that the host works with ids only.
- **Calls take and return integers.** Quads are four ids. Results are arrays of
  ids in linear memory that the host reads through a `Uint32Array` view.
- **Queries are prepared once** and run many times with variables bound to
  terms, replacing Semblance's textual `$this` substitution.
- **Deletes are real.** A deleted quad leaves no trace that later lookups pay for.

## Module

- Core WebAssembly 1.0 plus mutable globals, sign extension, bulk memory and
  non-trapping float-to-int. No threads, no GC proposal, no component model.
- One instance is one store. To start empty, instantiate the module again.
- Exports `memory`. The host must recreate its views after any call, since
  memory may have grown (and old `ArrayBuffer`s detached).
- Imports nothing except, from module `env`:
  - `now() -> f64`: milliseconds since the Unix epoch (`NOW()`).
  - `random() -> f64`: uniform in [0, 1) (`RAND()`, `UUID()`, `STRUUID()`, fresh blank nodes).

## Conventions

- All integers are `i32` on the wire. Ids and counts are unsigned. A negative
  return value is an error: `error_ptr()` and `error_len()` then describe it in
  UTF-8 until the next call.
- **Input buffer.** `input(len) -> ptr` returns a buffer of at least `len` bytes
  that the host fills before a call taking `*_len` arguments. Strings are UTF-8
  and laid out back to back in argument order (e.g. `prepare(text_len, base_len)`
  reads the query text, then the base IRI right after it). Id arrays are
  little-endian `u32`. The buffer stays valid until the next `input` call.
- **Result buffer.** Calls that produce lists write them at `result_ptr()` as
  `u32`s and return the count. It stays valid until the next call that writes
  results.
- **String accessors** return a pointer into the engine's own storage, valid
  until the next call that may allocate.

## Terms

Id `0` means "none": a wildcard in patterns, an unbound variable in solutions.
Id `1` is always the default graph.

| kind | `term_kind` | parts |
|---|---|---|
| IRI | 1 | value |
| blank node | 2 | value (label) |
| literal | 3 | value (lexical form), datatype id, language, direction |
| triple term | 4 | subject, predicate, object ids |
| default graph | 5 | none |

Literals keep their lexical form: `"01"^^xsd:integer` and `"1"^^xsd:integer`
are different terms (Oxigraph canonicalizes them; the W3C tests do not).
A language-tagged literal has datatype `rdf:langString`, or `rdf:dirLangString`
with a direction. Language tags are stored lowercased. Blank node labels are
scoped to the instance: interning the same label twice gives the same node.

| export | |
|---|---|
| `intern_iri(len) -> id` | IRI from the input buffer. Not validated (the host's terms are trusted). |
| `intern_bnode(len) -> id` | Blank node with that label. |
| `fresh_bnode() -> id` | A new blank node. |
| `intern_literal(len, datatype) -> id` | `datatype` is an IRI id; `0` means `xsd:string`. |
| `intern_lang_literal(len, lang_len, dir) -> id` | Value, then language tag. `dir`: 0 none, 1 `ltr`, 2 `rtl`. |
| `intern_triple(s, p, o) -> id` | |
| `lookup_*` | Same arguments as `intern_*`; returns the id or `0` without interning. |
| `term_kind(id)` | 0 for a free id. |
| `term_value_ptr(id)`, `term_value_len(id)` | |
| `term_datatype(id) -> id` | Literals. |
| `term_lang_ptr(id)`, `term_lang_len(id)` | Literals; length 0 when none. |
| `term_direction(id)` | Literals: 0, 1 or 2. |
| `triple_subject(id)`, `triple_predicate(id)`, `triple_object(id)` | Triple terms. |
| `term_count()` | Live terms, counting the default graph and the three built-in datatype IRIs (`xsd:string`, `rdf:langString`, `rdf:dirLangString`): 4 on a fresh instance. |

## Store

| export | |
|---|---|
| `add(s, p, o, g) -> 0 \| 1` | 1 if the quad was new. |
| `remove(s, p, o, g) -> 0 \| 1` | 1 if the quad was present. |
| `has(s, p, o, g) -> 0 \| 1` | |
| `match(s, p, o, g) -> n` | Quads matching the pattern (`0` = any; `g = 1` = default graph only, `g = 0` = all graphs), as `n × 4` ids. Order unspecified. |
| `apply(removes, adds) -> 0` | Batch: the input buffer holds `removes` quads, then `adds` quads (4 ids each). Removes first. |
| `quad_count() -> n` | |
| `load(format, text_len, base_len, graph) -> n` | Parse and add. `format`: 1 N-Triples, 2 N-Quads, 3 Turtle, 4 TriG. Triples go to `graph`; quads keep theirs. Blank node labels are scoped to this document. Returns the number of statements parsed, duplicates included. On a syntax error nothing is added. |
| `collect() -> n` | Free terms that no quad, prepared query or pending result uses; their ids are listed in the result buffer and may be reused afterwards. Hosts must forget them. |

## Queries (SPARQL 1.2)

| export | |
|---|---|
| `prepare(text_len, base_len) -> handle` | Parse and plan a query. |
| `query_form(h)` | 1 SELECT, 2 CONSTRUCT, 3 ASK, 4 DESCRIBE. |
| `query_var_count(h)`, `query_var_ptr(h, i)`, `query_var_len(h, i)` | SELECT projection, in order. |
| `bind(h, name_len, id) -> 0` | Bind a variable (name without `?`/`$`) to a term until rebound; `id = 0` unbinds. |
| `run(h, graphs) -> n` | Evaluate. The input buffer holds `graphs` graph ids whose union is the default graph (`graphs = 0`: the default graph alone); every named graph stays visible to `GRAPH`. `FROM` / `FROM NAMED` in the query take precedence. SELECT writes `n` rows of `query_var_count` ids; CONSTRUCT and DESCRIBE write `n` triples of 3 ids; ASK returns 0 or 1. |
| `release(h)` | |
| `parse_update(text_len, base_len) -> 0` | Syntax check only. |
| `update(text_len, base_len) -> 0` | Parse and apply SPARQL Update. All or nothing. |

**Bound variables** are substituted: running with `?this` bound to `<x>` gives the
results of the query with `<x>` written in place of `?this` wherever it occurs
(including `SELECT ?this`, which then projects `<x>`). This is what Semblance's
per-focus rules do textually today; unbound, the same handle evaluates the bulk
form. An engine may re-plan on binding or plan with parameter slots; only the
results are specified.

Terms computed by a query (`CONCAT`, `IRI()`, `BNODE()`, aggregates, CONSTRUCT
blank nodes) are interned and appear in results like any other term.

## Housekeeping

| export | |
|---|---|
| `abi_version() -> 1` | |
| `input(len) -> ptr` | |
| `result_ptr() -> ptr` | |
| `error_ptr() -> ptr`, `error_len() -> n` | |

## Changing the ABI

Both engines and the host move together: an ABI change is a commit that edits
this file and `host/`, bumps `abi_version`, and states what each engine needs to
do. Neither engine adds exports the host relies on without it.
