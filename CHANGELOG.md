# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, a minor bump may contain behaviour changes.

## [Unreleased]

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

[Unreleased]: https://github.com/choleraehyq/dsh-turn-preset-router/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/choleraehyq/dsh-turn-preset-router/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/choleraehyq/dsh-turn-preset-router/releases/tag/v0.1.0
