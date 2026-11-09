# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, a minor bump may contain behaviour changes.

## [Unreleased]

## [0.2.0] — 2026-11-09

Fixes four of the five correctness issues reported in #1, plus the `sticky`
configuration semantics from #4. The remaining part of #4 — widening
`parseExplicitMode` to accept "explicit mode prefix + task content" — is still
open.

### Fixed

- **A message appended while a step was running broke that step (#1).** The
  plugin treated `agent/inbox/inserted` as a safe switch point, but that event
  fires from `send()`, which also runs while a step is in flight. Because
  `ToolsService.execute()` re-selects the executor at dispatch time, swapping
  there made the running step dispatch its already-fixed catalog against the
  wrong executor and fail with `UNKNOWN_TOOL` in both directions.

  A turn is now two phases: `inserted` records the decision, and the new
  `agent/inbox/claimed` event commits it. `claimed` is emitted by `preStep()`
  immediately before `tools.resolve()`, which is the only moment a change is
  guaranteed to affect the coming step and unable to affect a running one.
  Every commit path funnels through one gate, including `/mode`.

- **A late classifier verdict could reroute a newer task (#2).** Verdicts and
  parked modes now carry the task revision they were decided under; a result
  whose revision no longer matches is dropped instead of applied.

- **An unparsable model reply was treated as a valid `standard` verdict (#3).**
  `parseClassification` now returns `null` for empty output, non-JSON, failed
  parsing, a non-object value, or a missing/unknown `mode`. Synthesizing a
  verdict made a broken classifier look like a confident opinion.

- **`sticky: false` silently disabled explicit mode selection (#4, part).** The
  whole explicit-choice branch was gated on the config flag, so `/mode minimal`
  was ignored outright instead of merely not being remembered. `sticky` now
  governs only whether a choice is remembered; it always applies to the turn
  that stated it. `forceMode()` follows the same rule — it previously wrote the
  preference unconditionally, so the command path and the text path disagreed.

- **`minimal` could fail to narrow the tool set while still claiming it had
  (#5).** When the allowlist matches nothing or `tools.restrict()` rejects it,
  the degradation is now reported in `/mode`, in the status block, and in the
  prompt guidance — which no longer tells the model that only a few tools are
  visible when the full set is.

### Changed

- `createRouter` exposes 15 methods (adds `handleClaimed`).
- `parseClassification` returns `null` instead of a synthesized fallback verdict.
- `inspect()` reports `requestedMode`, `pendingMode`, `minimalDegraded`,
  `minimalDegradedReason` and `taskRevision`.
- The integration harnesses emit both `inserted` and `claimed` to model a turn.

### Notes

- A mode decided mid-step takes effect at the next step, not immediately. That
  is the point: the running step already committed to a tool catalog.

## [0.1.1] — 2026-11-09

### Fixed

- **PTC silently degraded to standard in every real installation.** The plugin
  activates before its sibling services finish mounting, so the first
  `apply()` always saw `ptcRuntime` missing. The warm-up treated that as "this
  deployment has no PTC", returned early, and never resolved the executor
  class — every `ptc` decision then fell back to `standard`. Sessions showed the
  verdict recorded as `ptc` (`最近判定：+3 批量/逐项处理`) while all tool calls
  still went through `bash`.

  Warm-up now waits (bounded, 4 s) for `ptcRuntime` to mount before importing
  the class, and a failed resolution no longer latches a permanent "resolved"
  flag, so an explicit `/mode ptc` can still recover.

- Declare `@deepseek-ai/dsh-tool-executor-ptc` as an optional peer dependency.
  This is what lets the Harness runtime resolver supply the package to a profile
  bundle; without it the import only worked in a development checkout.

### Documentation

- Add the npm install route to both READMEs. Installation previously documented
  only GitHub and local-directory sources.
- Correct the CLI example: it used `--profile desktop`, which the launcher
  refuses outright (`managed exclusively by the Electron application`).
- Correct the development-overlay description: `dev/dev.patch.yml` is an
  override patch that changes config on an installed row; loading from a
  checkout requires `dev/dev.insert.patch.yml` and a profile without the plugin.
- Note that `dsh plugin add` installs the package but does not update
  `dsh.profile.bundles`, which is the most common reason an installed plugin
  does not load.
- Fix the repository layout: `package.json` carries `dsh.compatibility`, not
  `engines.dsh`, and the tree was missing `.npmrc`, three dev harnesses,
  `run-real.sh`, `verify-profile/` and `docs/LOCAL-VERIFY.md`.

## [0.1.0] — 2026-11-09

Initial release.

### Added

- Per-turn tool-mode routing for DeepSeek Harness: `standard`, `ptc` and
  `minimal`, decided before each turn and applied by swapping the Agent scope's
  tool executor plus a prompt guidance section.
- Four-tier decision order, first match wins: an explicit user choice
  (`/mode ptc`, `用 ptc 模式`) which is sticky; a continuation (`继续`, `ok`)
  which inherits the previous decision; local weighted rules, which decide
  high-confidence turns with no model call; and a small model verdict for the
  rest, falling back to `defaultMode` on any failure.
- Local rules covering batch, iterate, parallel, heavy-loop, bulk-write,
  scripted and whole-repo work → `ptc`; single questions, greetings, one action
  and explanations → `standard`.
- `/mode` command: status, `standard` / `ptc` / `minimal` to pin, `auto` to
  resume automatic routing.
- Sticky preferences that survive resume and fork, recovered from the logged
  `command/run` events.
- Graceful degradation: an unmounted `ptcRuntime` or a failing classifier falls
  back to `standard` without surfacing an error to the session.
- 134 unit tests, four integration harnesses against real DSH services, and a
  real-process verification script.

### Notes

- A model verdict cannot decide the turn that asked for it: DSH fixes a turn's
  tool catalog before any awaited hook runs, and `emit` does not await async
  listeners. Verdicts are therefore parked and consumed by the next turn.
- The `0.1.0` tarball on npm carries the PTC-degradation bug described under
  `0.1.1`. Install `0.1.1` or later.

[Unreleased]: https://github.com/choleraehyq/dsh-turn-preset-router/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/choleraehyq/dsh-turn-preset-router/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/choleraehyq/dsh-turn-preset-router/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/choleraehyq/dsh-turn-preset-router/releases/tag/v0.1.0
