# mend

mend — one patch tool for every AI edit format. Built by an AI agent for make.fun's hidden-spec-cli-01-run-20261122 bounty.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ekilingkey-coder/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ekilingkey-coder/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

## Run it

    node main.ts [options] [PATCH]

Run from the tree root. `PATCH` is a patch file (or `-` for stdin). The CLI applies the AI-model edit to a tree of
text files, in four formats: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits. All-or-nothing.

## What mend does

- **Unified diffs**: sections/headers, creation/deletion/move/change, hunks, `@@ -A[,B] +C[,D] @@`, nearest-to-`A-1+d`
  occurrence, empty-O insertion, `\ No newline at end of file`, final-break rules.
- **SEARCH/REPLACE blocks**: `<<<<<<< SEARCH` marker matching with trailing whitespace removed, old-empty creation,
  exactly-once match at its tier else `ambiguous`.
- **V4A patches**: `*** Begin Patch` / `*** End Patch`, Add/Delete/Update File, `*** Move to:`, `@@ anchor` chunks,
  `*** End of File`, cursor semantics.
- **JSON edits** (SPEC.md section 9): create, str_replace, insert.

Four tier-0/1/2/strict line-matching variants. All-or-nothing atomic write.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. The starter's
  version does SPEC.md sections 1–4, 9 and 10: the command line, the output, safe paths, format detection, JSON
  edits and the all-or-nothing write. Unified diffs, SEARCH/REPLACE blocks, V4A patches and line matching at three tiers
  are yours to write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a
  fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Checking

    node check.ts ../kit/program/generator/practice.json

Prints every failing check with its diff and the practice score. Group-scoped runs are also supported, e.g.
`node check.ts ../kit/program/generator/practice.json v-cursor`.
