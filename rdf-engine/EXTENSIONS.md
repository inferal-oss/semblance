# SPARQL extensions (draft)

Semblance's engines (Rust and WAT) understand a few things standard SPARQL 1.2
leaves out: extension functions, which the standard allows by IRI (SPARQL 1.1
§17.6), and *magic relations*, triple patterns the engine computes instead of
looking up. Queries using them are still syntactically standard SPARQL; only
the evaluation is ours. Oxigraph's JavaScript API has no hook for custom
functions, so on Oxigraph and N3 a rule that needs an extension is not
eligible and its function implementation runs instead.

Namespace: `PREFIX sx: <https://semblance.dev/ns/sparql#>`.

## Not extensions

Two limitations listed under `sem:functionOnly` need no engine support:

- **A query held in the data** (charts, Formula, Table, the result views). The
  runtime, or a function rule, writes the view's result into the graph as RDF
  rows; the rules that draw it are then plain SPARQL over those rows.
- **Paths over a predicate named in the data** (Breadcrumbs, Tree, link
  destinations). One hop with the predicate in a variable is a plain pattern
  (`?tree c:parentProperty ?prop . ?c ?prop ?p`); a helper rule mints a
  fixed-predicate edge (per tree, if trees can share nodes) and the walking
  rule follows it with `*`.

## Capabilities

Extensions come in groups, instances of `sx:Group`. A store says which it has; a
SPARQL rule says which it needs; the rule engine picks a rule only when the store
has all of them.

| group | IRI | contents |
|---|---|---|
| Math | `sx:Math` | `sx:log` … `sx:pi` |
| Text | `sx:Text` | `sx:codepoint` … `sx:fnv1a` |
| Locale | `sx:Locale` | `sx:formatNumber`, `sx:formatDateTime`, `sx:collated`, `sx:sortKey` |
| Matches | `sx:Matches` | `sx:matches`, `sx:chars` |
| JSON | `sx:Json` | `sx:json` |

- **Engine.** An optional export `extensions() -> i32`, a bit set in table
  order (Math = 1, Text = 2, Locale = 4, Matches = 8, JSON = 16). Absent means 0.
- **Store.** `GraphStore.extensions?: ReadonlySet<string>`, the group IRIs.
  Absent means none (N3, Oxigraph, hybrid).
- **Rule.** `sem:needsExtension sx:Math` (repeatable; domain `sem:Rule`, range
  `sx:Group`) on a rule with a `sem:construct`. (`sem:requires` is taken: it
  names a property the focus must have.) Rule selection goes by preference,
  then skips a rule whose groups the store lacks, so the next rule runs. A
  rendering whose SPARQL rule needs an extension still needs a function rule,
  for stores without it; `sem:functionOnly` is then dropped, and
  `test/implementations.ts` checks that both exist. A `beh:Reaction` may carry
  `sem:needsExtension` too, falling back to its `sem:function`.
- Queries using extensions are standard SPARQL syntax, so every parser (and
  `rdf-engine/host/parse-check.ts`) accepts them.
- An engine never rejects an `sx:` IRI it does not implement at prepare time:
  an unknown function is an expression error (standard behaviour) and an
  unknown magic relation is an ordinary predicate. The capability check is
  what keeps such rules off stores that lack them.

## Functions

Arguments are evaluated as in SPARQL; a wrong type, an unbound argument or a
value outside the domain is an expression error (unbound in BIND, false in
FILTER), as for the built-ins.

### `sx:Math`

All take numerics (any numeric datatype, converted to a double) and return
`xsd:double`. A result that is NaN is an error; infinities are values.

| function | |
|---|---|
| `sx:log(x)`, `sx:log10(x)`, `sx:log2(x)` | natural, base 10, base 2; error for x ≤ 0 |
| `sx:exp(x)`, `sx:pow(x, y)`, `sx:sqrt(x)` | `sqrt` errors for x < 0 |
| `sx:sin(x)`, `sx:cos(x)`, `sx:tan(x)` | radians |
| `sx:asin(x)`, `sx:acos(x)`, `sx:atan(x)`, `sx:atan2(y, x)` | |
| `sx:pi()` | |

The engines compute these with the host's `Math` (one more `env` import,
`math(op, x, y) -> f64`; ABI.md), so a SPARQL rule and its JavaScript function
twin get the same bits: `op` 0 `log`, 1 `log10`, 2 `log2`, 3 `exp`, 4 `pow`,
5 `sin`, 6 `cos`, 7 `tan`, 8 `asin`, 9 `acos`, 10 `atan`, 11 `atan2`, each `Math.<op>(x, y)` with the function's arguments in
order (`y` is 0 for one argument).
and 12 `sqrt`, which is correctly rounded (`Math.sqrt` is WebAssembly's own
`f64.sqrt`, which an engine may use instead); `pi` is the constant `Math.PI`.

### `sx:Text`

Positions are 1-based and count code points, as in `SUBSTR`. String arguments
are string literals (`xsd:string` or language-tagged); integer arguments are
literals of `xsd:integer` or a type derived from it.

| function | returns |
|---|---|
| `sx:codepoint(s, i)` | `xsd:integer`, the code point at position `i`; error out of range |
| `sx:char(n)` | `xsd:string` of the one code point `n`; error if not a Unicode scalar value (0 … 0x10FFFF, no surrogates) |
| `sx:utf8Hex(s)` | `xsd:string`: each UTF-8 byte of `s` as two lowercase hex digits, space-separated (`"€"` → `"e2 82 ac"`, `""` → `""`) |
| `sx:decodeURI(s)` | `xsd:string`: `%XX` sequences (either case) decoded as UTF-8, everything else kept (`+` too); error if a `%` is not followed by two hex digits or the bytes are not UTF-8 |
| `sx:fnv1a(s)` | `xsd:string`: FNV-1a 32-bit hash (offset basis `811c9dc5`, prime `01000193`) of the UTF-8 bytes, 8 lowercase hex digits |

String results are simple literals (no language tag) whatever the input.

### `sx:Locale`

Formatting is done by the host's `Intl`, so results follow the host's locale
data. `lang` is a BCP 47 tag string; `options` an optional string of
`key=value` pairs separated by `;`, with the keys and values of the `Intl`
constructor's options (`"style=currency;currency=EUR;maximumFractionDigits=0"`);
`true` and `false`, and values that are numbers, are passed as such. An
invalid tag or option (`Intl` throws) is an error. Results are simple literals.

| function | |
|---|---|
| `sx:formatNumber(n, lang [, options])` | `Intl.NumberFormat`, of `n` (any numeric) as a JavaScript number (`INF`, `-INF`, `NaN` as `Infinity`, `-Infinity`, `NaN`) |
| `sx:formatDateTime(dt, lang [, options])` | `Intl.DateTimeFormat`, of `dt` (`xsd:dateTime`, `xsd:dateTimeStamp` or `xsd:date`; a value without a timezone is UTC, a date is its midnight); `timeZone=…` in the options, else the store's |
| `sx:collated(s, lang)` | as an `ORDER BY` key, `s` is compared with `Intl.Collator(lang)` (the left key's `lang`; when either key is not a string literal, the two compare as SPARQL orders them); anywhere else it is `s` |
| `sx:sortKey(s, lang)` | `xsd:string` that sorts by code point close to how `Intl.Collator(lang)` sorts `s`: case folded and accents stripped (`s.normalize("NFD")`, combining marks (`\p{M}`) removed, then `toLocaleLowerCase(lang)`). `Intl` has no collation-key API, so this is the weaker key; for `sem:orderKey`, where ORDER BY does not apply |

The time zone `sx:formatDateTime` uses when the options name none is a store
option (`timeZone`, default the host's own), so tests can fix it (`"UTC"`).

The engines reach `Intl` through one more `env` import (ABI.md):
`intl(op, in_ptr, in_len, out_ptr, out_cap) -> i32`, with UTF-8 arguments
separated by NUL; it returns the result's length, or minus the length needed
when `out_cap` is too small (the engine calls again with room). `op` 0 is
number formatting (the number's lexical form, `lang`, `options`), 1 date-time
formatting (the lexical form, `lang`, `options`), 2 comparison (`lang`, `a`,
`b`; returns -1, 0 or 1), 3 the sort key (`s`, `lang`). An absent `options`
is passed as an empty string. When `Intl` throws, ops 0, 1 and 3 return
-2147483648 (`i32` minimum): an error.

## Magic relations

A magic relation is a triple pattern whose subject is a list of inputs and
whose object is a list of outputs. Inputs must be bound when the pattern is
reached (the planner puts it after the patterns that bind them); outputs are
variables (or terms, which then filter). Each call yields zero or more rows.
They may appear wherever a triple pattern may, except in a property path or a
CONSTRUCT template. The engines recognize one when its predicate is the
relation's IRI and its subject and object are both collections written in the
pattern (`( … )`, not `()`), and evaluate it after the other triple patterns
of its basic graph pattern; a group's earlier patterns (`BIND`, `VALUES`, an
earlier block) and the variables bound by the host bind inputs too. An input
that is unbound, or of the wrong kind, yields no rows. Outputs bound already
(or written as terms) must equal what the relation yields; a list shorter than
what the relation yields drops the rest, a longer one leaves the extra
variables unbound.

### `sx:matches` (`sx:Matches`)

```sparql
(?text ?pattern) sx:matches (?match ?start ?g1 ?g2)
(?text ?pattern "i") sx:matches (?match ?start)
```

One row per non-overlapping match of the XPath regular expression `?pattern`
(flags as in `REGEX`) in `?text`, left to right, as JavaScript's `matchAll`:
an empty match is a row, and the next search starts one code point further.
`?match` is the matched string (`xsd:string`), `?start` its 1-based position
in code points (`xsd:integer`), `?g1` … the capture groups (`xsd:string`;
unbound for a group that did not take part). An invalid pattern yields no rows. With an
alternation that also matches whatever falls between tokens, this is a
tokenizer:

```sparql
(?src '(#[^\n]*)|("[^"]*")|(\\?\\w+)|([A-Za-z_]\\w*)|(\\s+)|(.)') sx:matches (?tok ?at ?comment ?string ?var ?word ?space ?other)
```

### `sx:chars` (`sx:Matches`)

```sparql
(?text) sx:chars (?char ?index)
```

One row per code point of `?text`: `?char` the code point as an `xsd:string`,
`?index` its 1-based position (`xsd:integer`).

### `sx:json` (`sx:Json`)

```sparql
(?payload) sx:json (?path ?parent ?key ?kind ?value)
```

Parses `?payload` as JSON (RFC 8259) and yields one row per value, in document
order: `?path` is its JSON Pointer (`""` for the root, `"/items/0/name"`),
`?parent` its parent's pointer (unbound for the root), `?key` the member name or
array index (`xsd:string` or `xsd:integer`; unbound for the root), `?kind` one
of `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"`, `"null"`, and
`?value` the scalar's value (unbound for objects, arrays and null): a string as
`xsd:string`; a number with its JSON spelling as the lexical form, as
`xsd:integer` (no fraction or exponent), `xsd:decimal` (a fraction, no exponent)
or `xsd:double` (an exponent); `true` and `false` as `xsd:boolean`. Pointer
tokens escape `~` as `~0` and `/` as `~1`. Invalid JSON (including a lone
surrogate escape, and nesting deeper than 512) yields no rows; whitespace
around the value is allowed. Rules mint IRIs from `?path`.

## Status

Implemented in both engines (#5), which pass the same tests
(`test/rdf-engine-extensions.test.ts`). Compiled queries (ABI.md) hand magic
relations to the engine's interpreter (`cq_eval`) and evaluate the functions
as the interpreter does.
