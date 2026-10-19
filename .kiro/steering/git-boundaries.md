---
inclusion: always
---

# Git is the user's domain — NEVER run git write operations

The user is the ONLY one who runs git. This is an absolute, non-negotiable rule.
It applies to the main agent AND to every workflow/sub-agent it launches.

## Forbidden without an explicit, in-the-moment user instruction

Do NOT run, and do NOT instruct a workflow/sub-agent to run, any of:

- `git add` / `git stage`
- `git commit` (including `--amend`)
- `git push`
- `git pull` / `git fetch` / `git merge` / `git rebase`
- `git reset` / `git revert` / `git restore` / `git checkout -- <file>`
- `git stash`
- `git tag`, `git branch`, `git switch -c`, `git worktree add/remove`
- `git config`
- any other command that creates commits, moves refs, stages files, or changes
  working-tree/branch/remote state.

"Explicit, in-the-moment instruction" means the user, in the current request,
tells you to run that specific git operation (e.g. "commit this", "push now").
A past approval, a general goal, or "it would help to commit" is NOT enough.
When in doubt, do not run it — ask.

## Allowed (read-only inspection only)

Read-only git commands are fine without asking, because they change nothing:
`git status`, `git log`, `git diff`, `git show`, `git branch --list`,
`git ls-files`, `git rev-parse`, `git remote -v`. Use these to inspect state.

## When a commit/push WOULD help

State that the change is ready and give the user the exact commands to run
themselves — then stop. Do not run them. Example:

> The change is ready. When you want to commit and push, run:
> `git add <files>` · `git commit -m "..."` · `git push`

## Workflows and sub-agents inherit this rule

When launching any workflow or sub-agent, the brief MUST explicitly forbid git
write operations (add/commit/push/etc.) and tell the agent to leave all git
actions to the user. Never assume a sub-agent will not commit — say it plainly
in every brief. If a workflow needs its work "saved", it saves by editing files
in the working tree only; the user handles git afterward.

## If a git write already happened by mistake

Do not try to "fix" it with more git commands (no reset/revert/amend). Tell the
user exactly what git state exists (via read-only inspection) and let them
decide how to handle it.
