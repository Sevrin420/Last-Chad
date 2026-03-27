# Sync to Main

## How it works

The repo has a GitHub Actions workflow called **"Sync Main Branch"** (`/.github/workflows/create-main.yml`) that force-pushes a source branch onto `main`.

## Triggering from Claude Code

Use the `GITHUB_TOKEN` environment variable (available in the session) to dispatch the workflow via the GitHub API:

```bash
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/Sevrin420/Last-Chad/actions/workflows/create-main.yml/dispatches" \
  -d '{"ref":"<source-branch>","inputs":{"source_branch":"<source-branch>"}}'
```

- Replace `<source-branch>` with the current feature branch (e.g. `claude/craps-game-onchain-SDPba`)
- HTTP 204 = success (workflow accepted)
- The `ref` field and `source_branch` input should match

## Why this is needed

The Claude Code git token only has permission to push to `claude/` branches. Pushing directly to `main` returns 403. This workflow runs with `contents: write` permission on GitHub's side, bypassing that restriction.
