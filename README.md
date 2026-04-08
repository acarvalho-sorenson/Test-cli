# ghprai

AI-powered CLI for pull request creation, PR review, and GitHub release automation using `gh` + AI backends.

## Requirements

- Node.js 20+
- GitHub CLI authenticated (`gh auth login`)
- At least one AI backend:
  - `ANTHROPIC_API_KEY`, or
  - `OPENAI_API_KEY` (requires `openai` package installed), or
  - CLI backend available in PATH (`claude`, `cursor`, `opencode`, `codex`, or `llm`)

## Install and Build

```bash
pnpm install
pnpm run build
```

Install as a global command (`ghprai`):

```bash
pnpm run install:global
ghprai --help
```

If you update the CLI often during development:

```bash
pnpm run reinstall:global
```

Remove the global command:

```bash
pnpm run uninstall:global
```

Run locally:

```bash
pnpm run dev --help
```

Run built CLI:

```bash
node dist/index.js --help
```

Alternative without global install:

```bash
pnpm exec ghprai --help
```

If `ghprai` is not found after global install, ensure your package manager global bin is in `PATH`.
You can always run with `pnpm exec ghprai --help` as a fallback.

## Commands Overview

```text
version                       Verify CLI version and GitHub CLI availability
pr <target-branch>            Generate and create a PR from current branch
review <pr>                   Review a PR with AI suggestions and optional submit
release create                Create a release tag and GitHub release notes
```

## Version Check

```bash
ghprai version
```

Outputs the current `ghprai` version and installed GitHub CLI version.

## PR Creation

Generate a PR title/body from your branch diff and commit history, then optionally edit before submit.

### Dry run (recommended first)

```bash
ghprai pr main --dry-run
```

Dry run prints the generated PR title/body and does not call `gh pr create`.

### Interactive PR creation

```bash
ghprai pr main
```

Default flow:

- Verifies `gh` authentication
- Detects AI backend
- Collects branch diff + commit log against target branch
- Loads repository PR template when present (`.github/pull_request_template.md`, `docs/pull_request_template.md`, etc.)
- Generates title/body with AI
- Lets you submit, edit title, edit body in `$EDITOR`, or cancel

## PR Review

Use AI to review a pull request with clean-code and security-oriented suggestions.

### Dry run

```bash
ghprai review 123 --dry-run
```

This generates:

- Friendly review summary
- Suggested improvements
- Security concerns (if detected)
- Recommended action (`comment`, `approve`, or `request-changes`)

No review is submitted in dry-run mode.

### Interactive suggestion mode (default)

```bash
ghprai review 123
```

After generation, you can:

- Submit review
- Change review mode
- Edit review message in `$EDITOR`
- Ignore suggestion (no review submitted)

### Review options

```bash
ghprai review 123 --instruction "Focus on test coverage and naming clarity"
ghprai review 123 --mode request-changes
ghprai review 123 --inline
ghprai review 123 --inline --dry-run
```

- `--instruction <text>`: custom reviewer focus/tone
- `--mode <mode>`: force review mode (`comment`, `approve`, `request-changes`)
- `--inline`: try to post inline comments on changed lines

When `--inline` is enabled:

- Invalid file/line suggestions are dropped
- Contradictory “missing token” claims near existing tokens are dropped
- If no valid inline locations remain, it falls back to general review
- If some inline submissions fail GitHub validation, failed items are appended to the general review body

Security behavior during review:

- Scans diff for high-risk patterns (`eval`, shell execution, SQL interpolation)
- Redacts possible secrets before sending diff content to AI
- Truncates very large diffs for safer prompt limits

## Release Tagging

Create release tags and GitHub releases with notes generated from commits.

### Dry run release

```bash
ghprai release create --dry-run
```

This shows:

- Suggested semantic version tag
- Commit type summary
- Generated release notes preview

No release is created in dry-run mode.

### Create release interactively

```bash
ghprai release create
```

Interactive selection includes:

- Recommended tag
- Patch, minor, major alternatives
- Custom tag (`vX.Y.Z`)

### Common release options

```bash
ghprai release create --base main --from v1.2.3 --tag v1.3.0 --yes
```

- `--base <branch>`: base branch to release from
- `--from <ref>`: commit start reference
- `--tag <tag>`: explicit tag (`vX.Y.Z`)
- `--lang <code>`: force release note language (example: `en`, `pt-BR`)
- `--yes`: skip confirmation prompt
- `--dry-run`: generate suggestion/notes without creating release

Release notes behavior:

- Parses conventional commit types (`feat`, `fix`, `perf`, `docs`, etc.)
- Suggests semantic bump (`major`, `minor`, `patch`) from commit content
- Detects language from commit text (English/Portuguese) unless overridden by `--lang`
- Publishes with `gh release create` using generated notes and changelog compare link

## AI Backend Resolution Order

Backend auto-detection priority:

1. `ANTHROPIC_API_KEY` (Anthropic SDK)
2. `OPENAI_API_KEY` (OpenAI SDK)
3. `claude` CLI
4. `cursor` CLI
5. `opencode` CLI
6. `codex` CLI
7. `llm` CLI

If no backend is available, the CLI exits with setup instructions.
