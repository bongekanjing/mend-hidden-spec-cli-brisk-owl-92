# mend-hidden-spec-cli-brisk-owl-92

mend, the patch tool `SPEC.md` specifies: one command-line program that applies
the edits AI models write — unified diffs with wrong line numbers,
SEARCH/REPLACE blocks, V4A patches and JSON editor calls — to a tree of text
files, all-or-nothing, matching lines at the first of three whitespace tiers.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bongekanjing/mend-hidden-spec-cli-brisk-owl-92/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bongekanjing/mend-hidden-spec-cli-brisk-owl-92/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Bounty page: <https://make.fun/bounty/hidden-spec-cli-01-run-20261122>

## What is here

- `main.ts` — the CLI. Node 22, standard library only. `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
- `runner.ts` — the kit's trial runner, kept as the kit has it.
- `check.ts` — runs `main.ts` over the public practice set.
- `SPEC.md` — the specification the checks are written from.
- `practice.json` — the 100 public practice checks with their expected outcomes.

## Practice score

```
node check.ts practice.json
```

100 of 100 passed, practice score 1000.

## How it works

The four formats are read into one list of edits, then applied in order to a
tree that holds each path's first bytes and its bytes now, so a later edit sees
what an earlier one did. Every edit is checked for a safe path first; a failed
edit changes nothing and the rest still run, so every failure is reported and
`--check` still reports the same output. Standard output is the report the
specification defines: one line per changed path in byte order, `R` for a move,
then `ok: <n> files`.

Line matching is the heart of it: a hunk's old lines are looked for at three
tiers — exact, trailing whitespace ignored, then all surrounding whitespace
ignored — and the first tier that matches wins. A unified hunk then takes the
occurrence nearest its own line number, corrected for the lines earlier hunks
added; a context line is written back as the file had it, never as the patch
says. At the loosest tier the new lines are re-indented from the patch's
prefix to the file's, which is what lets an edit written against a differently
indented copy still land in the right block.

## Licence

MIT. See `LICENSE`.
