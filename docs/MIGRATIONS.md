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

Several old terms that converge on one need a discriminator to come back, as above. Plain renames
onto one term fail the check unless the migration states `mig:loses`.

## From code

```ts
import { frameworkChanges, migrate, verify } from '@inferal-oss/semblance/migrate'

const { files, findings } = await migrate({ files: sources, changes: frameworkChanges(), from: '0.2.0' })
```
