# Migrations — naming, ordering, and the rollback contract

Everything here exists because a migration fails quietly. A bad one does not
throw at the door; it runs late, or never, or takes the database with it on the
way back out. The three rules below are each a specific silence that was paid
for.

`scripts/preflight-checks.sh` enforces them (check **B7**), so a commit that
breaks one is refused rather than discovered on a stack later.

## Name a new migration with a timestamp

```
YYYYMMDDHHMMSS_description.sql        20260919143000_document_registry.sql
```

Not `0058_document_registry.sql`. Sequential numbers are allocated **by hand**,
which makes them a coordination problem between branches that never meet until
merge time.

That is not theoretical here. On 2026-09-19 the number `0054` existed three
different ways at once — `0054_companion_bug_reports` on `integration/sprint-6`,
`0054_document_registry` on one feature branch, `0054_organizer_invitations` on
another — and `0055` twice. The repo had already renumbered to escape the same
collision twice before (`2d91519`, `6922dba`), and PR #47 moved `0050` to
`0052`. Three renumbers is enough evidence that the numbering scheme is the
bug.

Two branches would have to be created in the same **second** to collide on a
timestamp. Rails and Django settled here for the same reason.

## Why the cutover is safe, and why ordering still holds

`applyMigrations` (`control-plane/api/src/migrations.ts`) does two things that
make this work with no code change at all:

```js
const files = (await readdir(dir)).filter((n) => /^\d+_.+\.sql$/.test(n)).sort();
```

- The filter is `^\d+_` — **any** run of digits, so a 14-digit timestamp is
  already accepted.
- The sort is a plain lexicographic string sort, and `version` is stored as the
  **whole filename** (`version text PRIMARY KEY`), never a parsed number.

So `"0001_" < "0054_" < "20260919143000_"` as strings, and every legacy
`00xx_` migration still runs before every timestamped one:

```
0001_foundation.sql
0054_companion_bug_reports.sql
20260919143000_document_registry.sql
```

New migrations append. Nothing already applied moves. Nothing needs renaming to
make the scheme work — which is the whole point of choosing it.

## Never rename a migration that production has applied

The version is the filename. Rename an applied migration and the database sees
a row it has never run, and runs it again — against a schema that already has
it.

So legacy `00xx_` names are **grandfathered permanently**. They are not debt to
pay down; renaming them is the damage. B7 only requires the timestamp form of
migrations a change *adds*, which is why `--all` stays quiet on the 50
headerless legacy files in the tree.

## Renaming an *unapplied* migration is a different thing — but not a free one

A migration that has not reached production may legitimately be renamed, and
during the timestamp cutover six of them were. The catch follows from the same
fact: **the version is the filename**, so every dev and test database that
already ran the old name will treat the new name as a new migration and run it
again.

Production is not the risk here; a developer's database is. Before renaming,
choose one and write down which:

- **Make it idempotent** — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
  EXISTS`, `CREATE INDEX IF NOT EXISTS` — where that is safe *and semantically
  correct*. It is not always: a data backfill that runs twice is not the same
  as one that runs once.
- **Reset the affected database.** Dev and test databases are disposable by
  design; `test/support/test-database.ts` refuses any database whose name does
  not say it is for tests, precisely so this is a safe thing to do.

Do not leave it as an assumption that whoever pulls next will work it out.

## Declare the rollback contract on the first line

```sql
-- rollback: compatible — one new table and its indexes; nothing existing changes shape
```

`compatible` means the previous code version runs unchanged against this
schema, so a rollback can keep the data. `breaking` means it cannot.

**Absent is not neutral — it is the destructive answer.** `vm-release.py:299`
treats a migration with no header as `breaking`, which makes
`kinerary-cp-release rollback` restore the pre-upgrade dump instead of keeping
the database, losing every write since the upgrade.

That was live: migrations `0050`–`0054` carried no header, production sat on
`0051`, and the next upgrade would have applied three additive migrations that
a rollback would then have treated as a reason to discard the database.

The parser is `ROLLBACK_HEADER` in `control-plane/deployment/vm-release.py`; it
accepts either a hyphen or an em dash before the reason.

## What B7 refuses

| | Why it is silent otherwise |
|---|---|
| A `.sql` here that does not match `^[0-9]+_` | The migrator **ignores** it. Not an error — it simply never runs, on every stack, forever |
| A newly added migration with a hand-allocated number | Collides with another branch, discovered at merge |
| A newly added migration with no `-- rollback:` header | A future rollback discards the database |

Nothing in `--all` fires on the existing tree; the rules that could are scoped
to migrations a change adds.

## Where B7 is enforced — and the one place it deliberately is not

| Path | Runs | B7 |
|---|---|---|
| `git commit` | `preflight-checks.sh --staged` via `.githooks/pre-commit` | ✅ |
| `git merge` creating a commit | `--staged` via `.githooks/pre-merge-commit` | ✅ |
| `scripts/preflight-deploy.sh` | `--all` | ✅ |
| Claude Code `Write` | `--paths` | ❌ *by design* |
| CI (`control-plane.yml`) | tsc, tests | ❌ *cannot* |

**`git merge` does not run `pre-commit`.** Git fires `pre-merge-commit`
instead, and the repo had only the former until 2026-09-19 — so every blocking
rule had a hole shaped like an integration branch. It matters most for B7,
because a migration arriving by merge is in `HEAD` before anything inspects it
and is grandfathered from then on. The hook closes it; a fast-forward merge
needs no hook, since it creates no commit and moves only commits already
checked where they were written.

The subtle part is that a merge can introduce content that was never committed
anywhere: **conflict resolution**. Those edits are written into the merge
commit without `pre-commit` ever seeing them.

**`--paths` is a fast, non-authoritative steer, not a gate.** It is the Claude
Code `Write` hook, and it returns after B4 so that writing a file stays cheap.
It is safe precisely *because* it is not final: nothing reaches a branch
without passing `--staged` at commit or merge. Do not add B7 to it and do not
treat a clean `--paths` as evidence — testing a migration with
`preflight-checks.sh --paths <file>` will look clean no matter how wrong the
file is. Use `--staged`.

**CI cannot make this judgment, and should not pretend to.** The rule needs to
know whether a migration has *already been applied somewhere*. Git can only
answer "is it new relative to some ref", and on a long-lived integration branch
those differ: measured against `main`, sprint-6's `0050`–`0054` all look new,
and a CI check built that way demands renaming migrations production has
already run — the one thing that breaks it. CI has no database access on
purpose, so it cannot know better. The hooks answer correctly because the ref
they compare against is the branch the file is actually entering.

The residual gap is a clone that never ran `git config core.hooksPath
.githooks`. That is the same single point of failure every rule here shares,
and it is why the setup line is in `CLAUDE.md` rather than a comment.
