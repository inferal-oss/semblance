# Migrations

Components change and get renamed. Each change ships with what it takes to move across it, written
as data, so an app's Turtle moves by tooling and comes back the same way.

```bash
semblance migrate --check
```

```bash
semblance migrate
```

`--check` says what would happen and writes nothing; it exits non-zero if anything would change or
is left to settle. Without it the files are rewritten in place. Everything else in them stays as it
was written: comments, order and layout.

## What the tool reaches

- **Instances in Turtle**, in every file it is given, across files.
- **The SPARQL an app writes** in literals: rules, reactions, views, shapes. A template takes the step
  forward. A pattern that reads an old shape is rewritten to read the new one and keeps its meaning.
- **Turtle held in literals**, such as a live example's source.
- **Slugs** and `[data-sem-c=…]` in CSS held in the graph.

Everything else is reported, each finding with the change that explains it:

| finding | meaning |
|---|---|
| `migrated` | done |
| `review` | needs judgement: a query writes half of what moved, a class can't be proved, a migration applies only to some values |
| `manual` | a retired term is named where the tool cannot reach (TypeScript, a `FILTER`) |
| `meaning` | a change of meaning or behaviour, which leaves no trace in the source: read it |
| `prose` | named in a comment or text, left as written |

## Which changes apply

`semblance.lock.ttl`, written by the tool, says what a project is written against:

```turtle
<#project> sem:writtenAgainst "0.2.0" ; chg:applied change:radio-into-choice .
```

With a release stated, everything after it applies. With none, a change applies when a term it
retires occurs in your files, which is safe because a retired name is never used again. A change of
meaning leaves nothing to find, so it is listed; pass `--from <release>` to say what you were written
against.

## Going back

Going forward and back returns what was there.

```bash
semblance migrate --to 0.2.0
```

A migration that cannot come back says what it loses. Going back lists every such step before
anything is written, and proceeds only with `--accept-loss`. Data that exists only in the new form
is left alone.

## For people and agents

```bash
semblance changes --since 0.2.0 --json
```

Each change has its motivation, its substance in full and a guide for each direction. An agent can
read the guide for a finding, settle what the tool reported, and then have the tools decide:

```bash
semblance migrate --verify
```

It checks that no retired term is left, every file and query parses, and everything applied comes
back. The text is for judgement; the check is what counts. It does not run SHACL shapes.

## Data outside your Turtle

| data | what happens |
|---|---|
| remembered state (`per:`) | moved across a rename on restore; discarded when it names a term that went with no new name |
| authored graphs (`mount({ authored })`) | renamed terms are read under their new names at load, and reported through `onRefused` |
| a remote store | a store that names a retired term is refused and reported on `src:lastError`. `semblance migrate --update` prints the SPARQL Update that takes it across |
| server-rendered HTML | no migration: takeover already corrects what differs |
| rules at run time | a rule that still produces a retired term is reported once per term, never repaired |

## Changing a component

For framework work, `AGENTS.md`, "When a component changes", is the guide: every change to a
component's definition is a version step with a stated reason, and `npm run versions -- --check`
enforces it.

A `chg:Change` (`ontology/changes/<slug>.ttl`) is what happened; each `mig:Migration` in it is one
mechanical step:

```turtle
change:radio-into-choice a chg:Change ;
    rdfs:label "Radio groups become c:Choice"@en ;
    chg:motivation """Why.""" ;
    chg:substance """What changed, in full.""" ;
    chg:forwardGuide """How to move, and how to settle what is reported.""" ;
    chg:backwardGuide """How to move back, and what does not return.""" ;
    chg:affects c:RadioGroup , c:Choice ;
    chg:migrations ( change:radio-to-choice ) .

change:radio-to-choice a mig:Migration ;
    mig:of c:RadioGroup ; mig:from 5 ; mig:to 6 ;
    mig:forward  """DELETE { ?x a c:RadioGroup } INSERT { ?x a c:Choice ; c:variant "radio" } WHERE { ?x a c:RadioGroup }""" ;
    mig:backward """DELETE { ?x a c:Choice ; c:variant "radio" } INSERT { ?x a c:RadioGroup } WHERE { ?x a c:Choice ; c:variant "radio" }""" ;
    mig:discriminator c:variant .
```

A rename is one line, `mig:renames [ mig:old c:a ; mig:new c:b ]`, and is its own reverse.

Several old terms that converge on one need a discriminator to come back, as above.

## How it works

The examples below use invented terms. Their output is what the tool writes.

### The records

| file | what | written by | loaded with the framework |
|---|---|---|---|
| `ontology/versions.ttl` | each component's version, a hash of its definition, and what accounts for its last step | `npm run versions` | no |
| `ontology/terms.ttl` | every name a consumer states or reads, and every name retired | `npm run versions` | no |
| `ontology/changes/*.ttl` | one file per change, with its text and its migrations | a person or an agent | no |
| `ontology/layers/retired.ttl` | the retired names and their names now, for a page to read | `npm run versions` | yes |

### What a version covers

A component's version covers its **closure**: its own description, and every rule, reaction, style
and shape about it, grouped the way the subset of an app's ontology is grouped
([SUBSET.md](SUBSET.md)). A rule reaches its component through the rendering it implements.

The closure is hashed. File order and blank node labels don't affect the hash, and a change to a
mixin steps the mixin, not everything that uses it. Besides every `sem:Component` subclass, anything
rules, reactions, styles or shapes are about has a version too.

A closure that differs from the recorded hash needs a **version step**, and a step records what
accounts for it: `sem:changedBy` a change whose `chg:affects` names the component, or
`sem:internal "why"` when nothing a consumer would notice changed. A step with neither can't be made.

### What the check fails on

`npm run versions -- --check`, `test/versions.test.ts` and the Versions workflow fail when:

- a definition changed without a version step, or a step has no reason;
- a term is new and not listed, or gone with no change retiring it, even with a stated reason;
- a retired name is defined again;
- a change is unfinished: `TODO` in its text, or a required field missing;
- a `mig:forward` has neither `mig:backward` nor `mig:loses`;
- two renames land on one term and neither states `mig:loses`.

Against the branch a pull request merges into, the workflow also fails a closure that differs at the
same version, a version that went down, and a term dropped from the list. Each failure says what to do.

A **term** is a class, a property or an individual. Rules, renderings, reactions, shapes and phrases
are implementation, and may come and go without a change.

### A rename

A rename substitutes tokens. It reaches every position a term can stand in: a subject, a predicate,
an object, a term held as data (`c:property c:value`), `sh:path`, a query's triple patterns, property
paths and `FILTER`s, and Turtle inside a literal. The prefix a file used is kept; a new name with no
prefix in scope is written in full. Everything else stays byte for byte, so going back returns the
same bytes.

### A change of shape, in Turtle

The tool reads the files as written, with the place of every statement. It loads their triples
into the engine, runs the SPARQL Update, and compares: only the triples that changed are edited, in
the files that held them.

```sparql
DELETE { ?f c:width ?w ; c:height ?h }
INSERT { ?f c:size ?sz . ?sz c:w ?w ; c:h ?h }
WHERE  { ?f a c:Frame ; c:width ?w ; c:height ?h
         BIND(IRI(CONCAT(STR(?f), "/~size")) AS ?sz) }
```

```turtle
# A frame
ex:f a c:Frame ;  # kept
    c:width 10 ;
    c:height 20 ;
    c:label "Main" .
```

becomes

```turtle
# A frame
ex:f a c:Frame ;  # kept
    c:size <https://example.org/x#f/~size> ;
    c:label "Main" .
<https://example.org/x#f/~size> c:w 10 ;
    c:h 20 .
```

A collection `( … )` is not edited from inside, and a file using RDF 1.2 syntax takes renames only.
Both are reported.

### A change of shape, in SPARQL

A query can't be migrated by running it. Instead, the migration's own pattern runs in the engine
over the query, as a graph whose variables stand as terms.

**Writes.** A template is matched against the step in the direction of travel. Its triples are
swapped, and the migration's `BIND`s move into the `WHERE`.

```sparql
CONSTRUCT { ?f a c:Frame ; c:width ?w ; c:height ?h }
WHERE { $this ex:box ?f . ?f ex:w ?w ; ex:h ?h }
```

becomes

```sparql
CONSTRUCT {
  ?f a c:Frame ; c:size ?sz .
  ?sz c:w ?w ; c:h ?h .
}
WHERE { $this ex:box ?f . ?f ex:w ?w ; ex:h ?h
  BIND(IRI(CONCAT(STR(?f), "/~size")) AS ?sz)
}
```

**Reads.** A pattern asks the old shape, and the data will be in the new one, so it takes the
opposite direction's pattern: `mig:backward`'s `INSERT` is the old shape and its `WHERE` the new.
Patterns inside `OPTIONAL`, `UNION`, `MINUS` and `EXISTS` are reached too.

```sparql
CONSTRUCT { $this c:shown ?v }
WHERE { ?f a c:Frame ; c:width ?v ; c:height ?h ; c:of $this }
```

becomes

```sparql
CONSTRUCT { $this c:shown ?v }
WHERE { ?f a c:Frame ; c:of $this ; c:size ?sz .
  ?sz c:w ?v ; c:h ?h . }
```

**A value known only at run time.** A migration can map some values and leave others:
`c:align "left"` becomes `c:justify "start"`, and `"center"` stays. A constant goes through the table.
A variable can't, so the query is **composed**: both shapes stay, each gated. A triple with an
unbound variable is dropped from a template, so only one of the two is ever written.

```sparql
CONSTRUCT {
  ?b c:align ?keep ; c:justify ?new .
} WHERE { ?b ex:side ?a
  BIND(IF(?a = "left", "start", IF(?a = "right", "end", ?unbound)) AS ?new)
  BIND(IF(?a IN ("left", "right"), ?unbound, ?a) AS ?keep)
}
```

A read becomes a `UNION` of the mapped values and the ones that did not move. A composed query keeps
its original in a comment on its first line, and is restored from it going back, unless it was
edited since.

**A rule's class.** A rule's `$this` takes its class from what holds the query: `sem:targets`, or
`beh:sourceClass`, through `sem:implements`. So a query need not state the class for a migration to
apply. When the class itself moves, the holder moves with the query:

```turtle
ex:R sem:targets c:Radio .
ex:r sem:implements ex:R ; sem:construct """CONSTRUCT { ?root sem:renders $this } WHERE { $this c:label ?l }""" .
```

becomes

```turtle
ex:R sem:targets c:Choice .
ex:r sem:implements ex:R ; sem:construct """CONSTRUCT { ?root sem:renders $this } WHERE {
  $this c:variant "radio" . $this c:label ?l }""" .
```

**What is reported instead.** Rather than guess, the tool leaves the query and says why when:

- a template writes only part of what moves, since the rest may come from elsewhere;
- a pattern reads only part of what moves;
- the query doesn't state the class a migration applies to, and nothing holding it does;
- a migration has a `FILTER`, so it applies only to some values;
- a query can't be parsed.

A `VALUES` or a `FILTER` that names a retired term is left as written and reported with the terms
still named after the run.

### Convergence

When several components become one, plain renames would lose which each instance was: a read of one
old class would return both. So each old class gets its own migration, which writes down what it
was, as `c:variant "radio"` does above. That also makes the convergence reversible. Where the
difference truly doesn't matter, the migration says so with `mig:loses`.

### What going back guarantees

| what | guarantee |
|---|---|
| a rename | the same bytes |
| data, a change of shape | the same graph, unless the migration states `mig:loses` |
| a query, a change of shape | the same template and `WHERE`; a `BIND` nothing reads any more is removed |
| a composed query | restored exactly, unless edited since |
| data that exists only in the new form | left alone going back, and unchanged coming forward again |

`semblance migrate --verify` tests this on your project: it takes what was applied back and forward
again in memory, and compares the graphs.

## From code

```ts
import { frameworkChanges, migrate, verify } from '@inferal-oss/semblance/migrate'

const { files, findings } = await migrate({ files: sources, changes: frameworkChanges(), from: '0.2.0' })
```
