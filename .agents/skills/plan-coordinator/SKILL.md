---
name: plan-coordinator
description: Act as Semblance's plan coordinator - read the GitHub plan issues and open issues, survey worktrees, branches and pull requests left by earlier agents, and hand each piece of work (partially done first) to its own session or task in its own git worktree, then file new issues and start work for them when asked. Use when asked to coordinate, continue or work through the issues or the plan, to pick up what other agents left, or to "add an issue and start a session/task" for something.
---

# Plan coordinator

You coordinate; you do not do the issues' work yourself. You read the plan, decide what runs next,
hand each piece to a worker of its own, keep the issues current, and check what workers report
before telling the user it is done.

**Workers.** In Claude Code a worker is an individual **session** (`start_session`, its own
worktree: `use_worktree: true`). In Codex a worker is a separate **task** (a new task in its own
worktree or environment). Below, "worker" means either. One worker per independent issue or PR;
never two workers on the same files.

Read `AGENTS.md` first: its "Working in the repository" rules (issues for everything, plan issues,
test queue, worktrees, shipping) are what every worker follows, and what you check.

## 1. Read the plan

```bash
gh issue list -R inferal-oss/semblance --state all --limit 100 \
  --json number,title,state,updatedAt | jq -r '.[] | "\(.number)\t\(.state)\t\(.title)"'
gh issue view 8 -R inferal-oss/semblance   # the Plan: framework, site, examples
gh issue view 9 -R inferal-oss/semblance   # the engine tracker: rdf-engine/
gh issue view <n> -R inferal-oss/semblance --comments   # each open issue
gh pr list -R inferal-oss/semblance --state all --limit 30
```

The plan issues (#8, #9) are meta lists: their lines link the real issues. Read every open issue's
task list and comments, and every open PR (its state and `mergeable`).

## 2. Survey what earlier agents left

```bash
git fetch origin
git worktree list
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  echo "$b ahead $(git rev-list --count origin/main..$b) behind $(git rev-list --count $b..origin/main) $(git log -1 --format='%cr %s' $b | cut -c1-80)"
done
```

- A branch 0 ahead is merged (or abandoned): ignore it.
- A branch ahead of main with no PR, or whose issue names it, is unfinished work.
- Work can land under other SHAs (rebased or squashed): grep `git log origin/main` for the
  feature before treating a branch as unmerged.
- Mismatches are worth fixing at once: an issue closed while its PR is open and unmerged gets
  reopened (with a comment why); boxes for work already on main get ticked (with the commit).
- Don't delete leftover worktrees or branches; offer to clean them up after the work lands.

## 3. Choose and order

1. Open PRs that only need a rebase, conflict resolution and verification.
2. Issues with commits on a branch but no PR, or with some boxes ticked.
3. Bugs, then the plan's "Next", then "Later".

Engine work (`rdf-engine/`, tracker #9) is its own worker, kept apart from framework work. Several
workers at once is fine; the machine-wide test queue (two runs) is the real limit, so more than
about six or seven mostly wait.

## 4. Start a worker per piece

Each brief (it is all the worker knows) says:

- the issue / PR links, the branch it starts from and what is on it (`N ahead, M behind`), and
  that a branch checked out in another worktree is not checked out again: start a new branch from
  it (`origin/<branch>` or the local branch) and push back with `--force-with-lease`;
- setup: symlink `node_modules` from the main checkout, copy `rdf-engine/build/*.wasm` or
  `npm run engine:build`;
- the work: the issue's remaining tasks, in AGENTS.md's terms (SPARQL first, parity, every theme,
  width and language, browser check);
- tests only through `scripts/test-queue.sh npx vitest run --maxWorkers=2 <files>`, the full suite
  before a merge;
- how it ships: a small issue commits and pushes `main`; a larger one opens a PR with
  `Closes #<n>`. Either way, rebase onto the latest `origin/main` right before merging, since
  other workers land too. Then tick the issue's boxes and the plan line (#8 / #9), and close it;
- the background: what Semblance is, which other workers run in parallel and where they may
  overlap (e.g. two branches both touching `src/engine`), and that the user has authorized
  committing, pushing and merging verified work;
- the commit attribution line the environment gives.

In Claude Code: `start_session` with `initiation: "user_asked"`, `context: "fresh"`,
`use_worktree: true`, a short `name` and `branch_name`; when starting several at once, mark a
chapter first and write a bold title line plus one sentence before each call. In Codex: one new task
per piece with the same brief.

## 5. When the user asks for something new

1. Look just enough to write a useful issue (grep the ontology/source for the cause; a sentence of
   diagnosis saves the worker an hour).
2. File it: `gh issue create -R inferal-oss/semblance` with what is wanted, why (the cause if
   known) and a `- [ ]` task list, including the general audit (AGENTS.md rule 5) and the tests.
3. Link it from its plan issue: #8 for the framework, site and examples; #9 for `rdf-engine/`.
   Edit the body (`gh issue view 8 --json body -q .body > f; edit; gh issue edit 8 --body-file f`)
   and put the line in the right section ("In progress", "Next", ...). A UI element goes into #14's
   list too.
4. Start a worker for it (section 4), unless the user only wanted the issue.

## 5a. Record ownership and waits in the tracker

Other coordinators (another session, another agent tool, a person) see only GitHub, so everything
that decides what may start must be written there, not just held in your briefs:

- **The Coordination table in #8** (above "In progress"): one row per piece in flight, with the
  issue/PR, the worker's branch (`claude/<name>-*`), its state, and what it waits on. Update it
  whenever you start a worker, a worker reports, something lands, or a wait clears; remove rows
  for work that landed. Read it first when you take over, and don't start anything a row owns.
- **A `Coordination:` comment on each issue that waits**, naming what it waits on and who owns
  it: another PR or issue landing ("starts after PR #31 merges"), the user's approval ("stays
  uncommitted until the user approves"; "the design needs approval before implementation"), or
  the user's go-ahead for costly work. Post it when the wait is decided, and comment again when it
  clears.
- **Gates the user sets are recorded verbatim in spirit** (approve each refactor first, don't
  commit until approved): they bind every coordinator and worker, not just the session that heard
  them.

## 6. When a worker reports

- A report is not proof. Check the result: the branch or `main` (`git log origin/main`), the PR's
  state, the issue's boxes. Only then tell the user it landed.
- A worker waiting on tests needs nothing from you. A worker that is blocked gets an answer, or
  the question goes to the user.
- Keep #8 (its Coordination table too) and #9 current as things land; when a PR merges, offer to
  archive its worker.
- Report to the user in a line or two per worker: what landed (with links), what is left.
