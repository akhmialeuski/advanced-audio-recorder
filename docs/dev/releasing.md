# Release guide

How a version of this plugin is cut, and what each step refuses to do. It is a
developer document: `docs/` proper is the user manual linked from the README and
from the plugin's settings tab, and nothing here is part of it.

Everything below is carried out by `scripts/release.mjs` and exposed as the
`release:*` scripts in `package.json`. What is left to a person is the version
number and the text of the notes.

## 1. What a release consists of

A release is a tag of three integers on `master`. Pushing that tag starts
`.github/workflows/release.yml`, which builds the plugin and publishes a GitHub
release carrying `main.js`, `manifest.json` and `styles.css`, with notes
generated from the commits. Those generated notes are then replaced by the ones
the build itself ships.

The text lives in `src/release/releaseNotes.ts`, one Markdown entry per tag, and
it is what the plugin's **What's new** dialog shows after an update. The release
page and the dialog therefore read from one source and cannot disagree.

## 2. Write the notes first

The entry for the new version reaches `master` through an ordinary pull request,
before anything is bumped. Two checks enforce this rather than leaving it to
memory:

- `tests/unit/releaseNotes.test.ts` fails when the catalogue carries no entry for
  the version in `manifest.json`, so every pull request asks the question.
- `scripts/release.mjs` refuses to preflight or bump a version the bundle cannot
  announce, reading the map through esbuild rather than matching a pattern
  against its source.

The catalogue keeps no more versions than one dialog shows, so the oldest entry
is dropped in the same commit that adds a new one.

## 3. The five commands

Run them in this order, from a clean `master` that is level with `origin`:

```bash
npm run release:status    -- 2.3.3   # what the repo and GitHub say right now
npm run release:preflight -- 2.3.3   # every gate, plus build, lint and tests
npm run release:bump      -- 2.3.3 --trailer "Co-Authored-By: ..."
npm run release:publish   -- 2.3.3   # tag, push, watch the workflow
npm run release:notes     -- 2.3.3   # replace the generated notes
```

`status` and `preflight` change nothing. `bump` writes the version into
`package.json`, `package-lock.json`, `manifest.json` and `versions.json` and
commits those four files and nothing else. `publish` and `notes` are the two
steps that reach the public.

The `--` before the version is npm's separator rather than the script's. Without
it npm keeps the arguments for itself.

## 4. What each step refuses

`preflight` stops on a dirty working tree, on a branch other than `master`, on a
branch out of step with `origin`, on a version that is already tagged, on a
version that does not come after the stored one, on a version the bundle carries
no notes for, on an unauthenticated `gh`, and on a failing build, lint run or
test suite.

`bump` re-asks every one of those, and then refuses a bump that reached anything
beyond its four files, a commit whose subject is not the bump, and a working tree
the pre-commit hook left dirty.

`publish` refuses a HEAD that is not the bump commit, a remote carrying commits
this branch does not, a tag of this version sitting on a different commit, and a
published release built without all three of its assets.

`notes` refuses an origin holding no notes for the version, and a page that did
not come back matching what was sent.

## 5. When a step stops halfway

Each command re-checks the state it needs and asks of each step it takes whether
that step still has work to do, so an interrupted release is resumed by running
the same command again. `publish` is the one where this matters: it cuts the tag,
pushes the branch, pushes the tag, waits for the workflow run to appear and then
watches it, and any of those can fail on its own. A second run tags only if the
tag is absent, and pushes the tag only if the remote does not already carry it.

The one state it cannot resolve is a tag of this version pointing at a commit
other than the one being released. That is a different release wearing the same
name, and the command stops with both commits named.

If the workflow itself goes red, fix the cause on `master` and cut the next patch
version. A tag that has been pushed is public and is not moved.
