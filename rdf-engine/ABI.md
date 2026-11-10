# Engine ABI (version 3)

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
  - `math(op, x: f64, y: f64) -> f64`: the host's `Math` function `op` of `x`
    (and `y`), for the `sx:Math` extension (EXTENSIONS.md).
  - `intl(op, in_ptr, in_len, out_ptr, out_cap) -> i32`: the host's `Intl`,
    for the `sx:Locale` extension (EXTENSIONS.md). The pointers are into the
    engine's `memory`.

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
| `load(format, text_len, base_len, graph) -> n` | Parse and add. `format`: 1 N-Triples, 2 N-Quads, 3 Turtle, 4 TriG, 5 Jelly (a whole delimited stream, or one bare frame, of `text_len` bytes; `base_len` is 0; see "Jelly"). Triples go to `graph`; quads keep theirs. Blank node labels are scoped to this document. Returns the number of statements parsed, duplicates included. On a syntax error nothing is added. |
| `collect() -> n` | Free terms that no quad, prepared query or pending result uses; their ids are listed in the result buffer and may be reused afterwards. Hosts must forget them. |

## Queries (SPARQL 1.2)

| export | |
|---|---|
| `prepare(text_len, base_len) -> handle` | Parse and plan a query. |
| `query_form(h)` | 1 SELECT, 2 CONSTRUCT, 3 ASK, 4 DESCRIBE. |
| `query_var_count(h)`, `query_var_ptr(h, i)`, `query_var_len(h, i)` | SELECT projection, in order. |
| `bind(h, name_len, id) -> 0` | Bind a variable (name without `?`/`$`) to a term until rebound; `id = 0` unbinds. |
| `bind_values(h, count, name_len) -> 0` | Bind a variable to several terms: the input buffer holds `count` ids, then the name. `run` then returns the results of running once with each term bound (CONSTRUCT and DESCRIBE triples deduplicated across runs). This is how Semblance evaluates one rule for several foci. |
| `run(h, graphs) -> n` | Evaluate. The input buffer holds `graphs` graph ids whose union is the default graph (`graphs = 0`: the default graph alone); every named graph stays visible to `GRAPH`. `FROM` / `FROM NAMED` in the query take precedence. SELECT returns the number of solutions `n` and writes `n` rows of `query_var_count` ids (none when it projects no variables); CONSTRUCT and DESCRIBE write `n` triples of 3 ids; ASK returns 0 or 1. |
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

## Jelly

[Jelly-RDF](https://w3id.org/jelly) streams, read and written frame by frame (JELLY.md has the
design). A reader reads 1.2 (the column layout) and 1.0/1.1 (the row layout); a writer writes
1.2. A frame on the wire is a bare `RdfStreamFrame`; the writer's output is delimited (each frame
after its length as a varint). Readers and writers are handles, released with `jelly_release`.

| export | |
|---|---|
| `jelly_reader(graph) -> h` | A reader of one stream. The statements of a TRIPLES stream (and the default graph of a GRAPHS one) go to `graph` (0: the default graph). Blank node labels are the stream's own (FLAT) or each message's (MESSAGES). |
| `jelly_frame(h, len, mode) -> n` | Read one frame: `len` bytes of the input buffer. `mode` bit 1 adds its statements to the store, bit 2 lists them at `result_ptr()` as `n × 4` ids, in stream order (duplicates kept). All or nothing: on an error nothing of the frame is added, and the reader refuses every later frame. |
| `jelly_ends(h) -> k` | The RDF Messages that ended in the last frame read: `k` positions at `result_ptr()`, each the number of the frame's statements before that end (an end before any statement is 0; restated stream options end a message too). |
| `jelly_finish(h) -> 0 \| 1` | The end of the stream: 1 when the message in progress had statements and so ends here. |
| `jelly_writer(physical, stream_type, rdf_version, max_names, max_prefixes, max_datatypes, frame_rows) -> h` | A writer of one stream, with these stream options (`physical` 1 triples, 2 quads; `stream_type` 0 FLAT, 1 MESSAGES; `rdf_version` 0-3; `max_names` at least 128; `frame_rows` statements per frame, 0 for 4,096). |
| `jelly_write(h, count) -> n` | Add `count` statements (the input buffer holds `count × 4` ids, in order); returns `n` bytes at `result_ptr()`: the frames they completed (often none). A statement the stream cannot hold (a literal subject, a triple term in RDF 1.1, a typed literal without a datatype lookup) is an error, after which the writer must be released. |
| `jelly_message(h) -> 0` | End the current RDF Message (MESSAGES streams). |
| `jelly_flush(h) -> n` | The statements and message ends since the last frame, as a frame: `n` bytes at `result_ptr()`. The first frame also carries the stream options, so a writer that wrote nothing flushes the options alone. Nothing pending later: 0 bytes. |
| `jelly_release(h)` | |

The writer's choices (IRI split, least-recently-used lookups, runs) are fixed (JELLY.md,
"Decisions"), so both builds write the same bytes from the same statements.

## Housekeeping

| export | |
|---|---|
| `abi_version() -> 3` | Version 2 added the `math` and `intl` imports and `extensions`; version 3 added Jelly (`load` format 5 and the `jelly_*` exports). |
| `extensions() -> bits` | Optional: the SPARQL extension groups the engine implements (EXTENSIONS.md, "Capabilities"); absent means none. |
| `input(len) -> ptr` | |
| `result_ptr() -> ptr` | |
| `error_ptr() -> ptr`, `error_len() -> n` | |

## Optional: compiled queries

An engine may compile a prepared query into a WebAssembly module of its own,
whose `run` replaces the interpreter's for that query. Results are the same;
only speed differs. Hosts check for the `compile` export and fall back to
`run` whenever it is missing, declines, or a compiled run fails. The
interpreter stays complete: correctness never depends on what compiles.
(Experimental; measured in [results/compiled.md](results/compiled.md).)
When to compile is the host's choice: `host/engine.ts` compiles a query on its
n-th run with the same variables bound (`autoCompile`), or in idle time the
ones whose timed runs say a module pays for itself (`idleCompile`,
`compileIdle`), dropping a module that then runs slower than the interpreter did.

| export | |
|---|---|
| `compile(h) -> n` | A module for query `h` as its variables are bound now (which variables, not their values): `n` bytes of a WebAssembly binary at `result_ptr()`. Negative: not compiled; the error starts with `not compilable:` when the query uses what the compiler does not handle. |

The module:

- imports `memory` and functions only from module `engine`, by the names of
  the engine's own exports (so the host instantiates it with
  `{ engine: instance.exports }`), and only those listed below;
- exports `run(graphs) -> n`: the same contract as `run(h, graphs)` (graph ids
  in the input buffer, results at `result_ptr()`, a negative value an error);
- stays valid until `release(h)`. Binding values may change between runs;
  binding a different set of variables makes `run` fail (`cq_begin` returns an
  error), and the host compiles again for the new set or runs interpreted.

A compiled run keeps its variables in a row frame (one id per variable of the
query, 0 = unbound) in the engine's memory, at an address the engine chose when
compiling. Lists it asks the engine for go on a stack of words in engine memory:
the caller passes `at`, the word where the list starts (everything below it
stays put), and reads it at `cq_stack() + 4 * at`. The engine functions a
compiled module may import:

| import | |
|---|---|
| `cq_begin(h, shape, graphs) -> n` | Start a run of query `h` compiled for the bound-variable set `shape` (an engine-chosen number baked into the module): read the graphs as `run` does, clear the results; `n` is the number of binding combinations (`bind_values`), or negative if `h` is now bound differently. |
| `cq_combo(i)` | Set the frame for combination `i` (`0 <= i < n`): bound variables to their values, the rest to 0. |
| `cq_scan(s, p, o, at) -> n` | Triples matching `(s, p, o)` (0 = any) in the run's default graph (the union of its graphs, each triple once): `n` triples of 3 ids from `at`. |
| `cq_path(k, s, o, at) -> n` | Pairs for the module's property path pattern `k`, its ends `s` and `o` given (0 = free): `n` entries of 3 ids `(start, 0, end)` from `at`. |
| `cq_eval(k, at) -> n` | The engine's own evaluation of the module's pattern `k` against the frame (which of the frame's bindings it sees is the engine's business, as its interpreter would do it there): `n` rows of one id per variable of the query from `at`, which the module joins with the frame. |
| `cq_stack() -> ptr` | Where the stack is; valid until the next `cq_scan`, `cq_path` or `cq_eval`. |
| `cq_test(k) -> 0 \| 1 \| 2` | The module's expression `k` over the frame, as a condition: false, true, or an error. |
| `cq_value(k) -> id` | The module's expression `k` over the frame: its value as a term (interned), 0 on an error. |
| `cq_solution()` | The frame is a solution: SELECT appends its projected row (with DISTINCT, unless already seen in this combination); ASK counts it. |
| `cq_triple(s, p, o)` | A CONSTRUCT template triple: appended unless a position is 0 or invalid (a literal subject, a non-IRI predicate) or it was produced before in this run. |
| `cq_end() -> n` | End the run: the value `run` returns. |
| `fresh_bnode`, `term_kind`, `term_datatype`, `term_lang_len`, `has` | As above. |

Beyond these, an engine may export more `cq_*` functions for its own modules
to import; what they do is between the engine and the code it generates (the
host passes every export through). The WAT engine's: `cq_sub`, `cq_keep`,
`cq_group` (a subquery whose WHERE runs in the module, finished by the
engine), `cq_room` (stack room a module writes itself), and helpers for typed
expressions (`cq_str`, `cq_iri`, `cq_num`, `cq_tonum`, `cq_term`, `cq_cplen`,
`cq_cpoff`, `cq_strfn`, `cq_ebv`); `rdf-engine/wat/cx-header.ts` lists them.
The Rust engine's: helpers for typed expressions (`cq_lex`, `cq_num`,
`cq_numterm`, `cq_strterm`, `cq_iri`, `cq_strfn`, `cq_cplen`, `cq_substr`,
`cq_tonum`, `cq_ebv`); `rust/src/sparql/compile.rs` lists them.

A compiled run is budgeted as an interpreted one is (`set_deadline`,
`set_fuel`): `cq_begin` starts the budget, and `cq_end` returns -2 with the
error `interrupted` once it is spent (the host then throws rather than
running the query again interpreted). The module takes a step per quad it
scans, path node it walks and row it joins, at the head of each loop: it
counts down a word in engine memory whose address the engine baked into the
module, and at 0 calls `cq_bu_event() -> 0 | 1`, which reads the clock or
the fuel and says whether the budget is spent; once it is, every later step
ends its loop, so the run unwinds to `cq_end`. What the module asks the
engine for (`cq_scan`, `cq_path`, `cq_eval`, ...) steps in the engine.

A module may also read the engine's own structures in its memory directly
(the WAT engine's compiled triple patterns and path walks read its store's
lists in line, and its typed expressions read term records and write a string
buffer): that is between an engine and the code it generates, and stays valid
only within one run.

What `k` and `shape` mean is the engine's business: it records them when it
compiles. The two engines compile the same queries (BGPs, OPTIONAL, UNION,
VALUES, LATERAL, FILTER, BIND, property paths through `cq_path`, the rest of a
group's patterns through `cq_eval`); they decline DESCRIBE, aggregates,
ORDER BY / LIMIT / OFFSET of the query itself, and triple terms in templates.
The WAT engine also compiles subqueries (any modifiers; the engine finishes
them) and typed expressions in the module; the Rust engine follows.

## Optional: fetching (`SERVICE` and `LOAD`)

An engine has no network, and a run is synchronous: it cannot wait for a
response. A browser cannot block its main thread on one either (no
`Atomics.wait` there, and JSPI is not in every browser), so the engine does not
call out to fetch. **A run that needs something from elsewhere stops, says what,
and is run again once the host has it.**

- `run` and `update` return **-3, "waiting"**, when the query or update needs a
  `SERVICE` result or a `LOAD`ed document the engine has not been given. Nothing
  was changed, and nothing was written to the result buffer. Evaluation goes on
  past the first missing answer (as if it had no solutions), so one round names
  every request it can.
- The host reads the **requests** (below), fetches them as it likes (in
  parallel, asynchronously, under its own policy), gives the engine each answer
  or failure, and calls the same `run` or `update` again. The engine then reads
  the answers instead of asking. A request that needs an earlier answer (a
  `SERVICE ?endpoint` whose endpoint another `SERVICE` binds) shows up in a
  later round; the rounds end when the call returns anything but -3.
- Answers stay until `fetch_clear()`, which the host calls when the operation is
  over. The table is the instance's, not the query's: an answer serves any run
  that asks the same request. Its terms are in use until then (the host does not
  `collect` while a fetch is in flight).

Requests are numbered from 0 in the order the engine made them, and keep their
numbers until `fetch_clear`. **The host fetches only what its own call asked
for** (`asked`, read right after that call returns -3): a request another run
left waiting (a rule's, between two rounds of the host's operation) is not
the host's to fetch, and a synchronous call that waits clears the table when
no operation is in flight.

| export | |
|---|---|
| `fetch_count() -> n` | Requests made since `fetch_clear`, answered or not. |
| `fetch_request(i) -> n` | Request `i` at `result_ptr()`: `state` (0 waiting, 1 answered, 2 failed), `kind` (1 `SERVICE`, 2 `LOAD`), `target` (the endpoint's or the document's IRI id), `width` (variables), `asked` (1 if the last `run` or `update` waited on it), then `n` binding rows of `width` ids. |
| `fetch_text_ptr(i)`, `fetch_text_len(i)` | `SERVICE`: the query to send, `SELECT * WHERE { … }` with the pattern as written, after the `BASE` and `PREFIX` declarations it was parsed under (and `BASE <base>` first when `prepare` had one). `LOAD`: empty. |
| `fetch_var_ptr(i, j)`, `fetch_var_len(i, j)` | `SERVICE`: variable `j` (name without `?`): the pattern's in-scope variables, those `SELECT *` returns. |
| `fetch_answer(i, n) -> 0` | Answer request `i`: the input buffer holds `n` rows of `width` ids (`SERVICE`: the endpoint's solutions, 0 = unbound) or `n` triples of 3 ids (`LOAD`: the document's triples). |
| `fetch_fail(i, len) -> 0` | Request `i` failed: the input buffer holds why, `len` bytes of UTF-8. |
| `fetch_clear() -> 0` | Forget every request and answer. |

**`SERVICE [SILENT] (<iri> | ?var) { P }`** evaluates, for a solution `μ` of
what is joined before it (the left side passes its bindings in, as it does to a
basic graph pattern):

1. The endpoint: the IRI, or `μ(?var)` when `?var` is in scope before
   `SERVICE` in its own group (as BIND's scope rule counts it), or else the
   value a parameter (`bind`) gives `?var`. A binding from outside the group
   does not reach it: each engine passes outer bindings into a nested group
   its own way, and this rule keeps them equal. No IRI there (unbound, a
   literal, a blank node): no solutions (`SILENT`: `μ` alone), not an error,
   so the result does not depend on whether a `FILTER` on the endpoint ran
   before `SERVICE` or after.
2. The **binding row**: `μ` restricted to `P`'s variables, leaving out blank
   nodes and triple terms (they cannot be sent). The bound positions are the
   row's *domain*.
3. The request is `(endpoint, text, domain)`; rows of one request share their
   domain. The host sends the text with `VALUES (?domain …) { (row) … }` after
   it when the domain is not empty, so the endpoint joins the rows after
   evaluating `P` (a `FILTER` in `P` does not see them, as SPARQL scopes it).
4. Answered: the answer rows compatible with `μ`, merged into it. Failed: an
   error, the run fails with it (`SILENT`: `μ` alone, as one empty solution
   joined). Not yet asked or answered: no solutions, and the run returns -3.

So rows of one request with the same domain are answered by one fetch, and
an answer row belongs to the row it agrees with. Results do not depend on how
the evaluator orders a join: `SERVICE` with the left side's bindings passed in
equals `SERVICE` evaluated alone and joined. Which bindings reach a `SERVICE`
(and so the `VALUES` a request carries) is each evaluator's own: WAT passes a
nested group only the variables it certainly binds and applies a `FILTER` as
soon as its variables are bound, Rust passes what a join may substitute. The
two builds give the same results, not always the same requests.

**`LOAD [SILENT] <iri> [INTO GRAPH <g>]`**: answered, the document's triples
are added to `g` (the default graph without `INTO`), in the order of the
update's operations; failed, the update fails (`SILENT`: the operation does
nothing); not answered, the whole update returns -3 and changes nothing.
The host parses the document: an answer is triples of ids, whatever the format
was (blank nodes fresh per document).

`compile` declines a query with `SERVICE` (`not compilable: SERVICE`). Each
round is a run like any other, budgeted by `set_deadline` / `set_fuel`; the
time between rounds, the fetch itself, is the host's to bound
(`rdf-engine/host/fetching.ts`: a deadline for the whole operation, a timeout
and a size limit per request, a cap on rounds).

These exports are optional, as `compile` is: the host checks for
`fetch_count`, and the ABI version does not change for them. A host that does not fetch sees -3
as an error ("waiting: …"), which is what a rule or view running such a query
should see: **only the host's own asynchronous calls fetch** (`GraphStore.fetching`),
never a synchronous `run` or `update`, so nothing a graph says can reach the
network on its own.

## Changing the ABI

Both engines and the host move together: an ABI change is a commit that edits
this file and `host/`, bumps `abi_version`, and states what each engine needs to
do. Neither engine adds exports the host relies on without it.
