# hidden-spec-cli

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DimasPutera/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DimasPutera/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend: one command-line tool that applies AI-written edits in four formats —
unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches,
and JSON tool calls — to a tree of files, to one written specification
(`SPEC.md` in the kit). It finds the lines an edit names at the first of
three matching tiers (exact, trailing-whitespace, trimmed), re-indents added
lines at tier 2, and writes every change or none.

`main.ts` (Node 22, standard library only) is the CLI, run as
`node main.ts [options] [PATCH]`; `runner.ts` is the kit's trial runner, kept
as it is. Practice set: 100 of 100 checks, score 1000.

Entry for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
