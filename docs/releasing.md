# Releasing Conduit

A release happens when a maintainer merges a release PR. Nothing releases on an
ordinary merge to `main`, and the maintainer picks the version.

## Cut a release

1. Make sure `CHANGELOG.md` has the entries you want under `## [Unreleased]`.
   The changelog is written by hand; the release tooling only moves it.
2. In GitHub, open **Actions > Prepare release > Run workflow** and enter the
   version as `MAJOR.MINOR.PATCH` with no leading `v` (for example `2.0.0`).
   It must be greater than the newest `v*` tag. Choose it by
   [Semantic Versioning](https://semver.org/): anything under a `### Breaking`
   heading means a major bump.
3. The workflow opens a PR titled `chore(release): X.Y.Z` from
   `release/vX.Y.Z`. It changes two files: `package.json` gets the new version,
   and `CHANGELOG.md` gets an empty `## [Unreleased]` above
   `## [X.Y.Z] - <today>`, plus updated compare links at the bottom.
4. Review the PR. To change the release notes, edit `CHANGELOG.md` on the
   release branch. The PR runs the same required checks as any other.
5. Squash-merge it. The **Release** workflow sees the `package.json` version
   change on `main`, runs the test gates again, creates the `vX.Y.Z` tag and
   GitHub release with that changelog section as the notes, and publishes the
   `ghcr.io/theaiteam-dev/conduit-engine` image as `X.Y.Z`, `X.Y`, `X` and
   `latest`.

To abandon a release, close the PR and delete the `release/vX.Y.Z` branch.
Prepare release refuses to run while that branch exists.

To retry a release that failed after merge (a flaky gate, a registry outage),
re-run the failed jobs of that Release run. It uses the same commit. If the
tag already exists at that commit, the run skips the tag and release and only
publishes the image again; it does that only while the tag is still the newest
release, so an old run cannot move `latest` backwards.

## What runs where

| File | Trigger | Does |
|---|---|---|
| `.github/workflows/prepare-release.yml` | manual, with `version` | runs `bun scripts/release.ts prepare`, pushes `release/vX.Y.Z`, opens the PR |
| `.github/workflows/release.yml` | push to `main` | if the `package.json` version changed and has no tag: gates, tag, GitHub release, image |
| `scripts/release.ts` | both | `prepare <version>` edits the two files; `notes <version>` prints a changelog section |

You can run the prepare step locally to preview a release without committing
it:

```sh
bun scripts/release.ts prepare 2.0.0 --date 2026-10-15
git diff package.json CHANGELOG.md
git checkout package.json CHANGELOG.md
```

## Setup the workflows need

Prepare release opens the PR with a GitHub App token, because a PR opened with
the built-in `GITHUB_TOKEN` triggers no workflows and its required checks would
never report. The App must be installed on this repository with **Contents:
write** and **Pull requests: write**, and the repository needs:

- variable `RELEASE_APP_CLIENT_ID`: the App's client ID
- secret `RELEASE_APP_PRIVATE_KEY`: a private key for the App

The Release workflow uses only `GITHUB_TOKEN`. It creates tags and releases
through the API and never pushes to `main`, so the `main` ruleset needs no
bypass.
