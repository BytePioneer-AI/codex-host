## 1. Current Desktop Feasibility Gates

- [ ] 1.1 Read the command-catalog main specs, predecessor Renderer/Model designs and verification records, owning modules, and focused tests required by the implementation-context rule; report any conflict before editing production code.
- [ ] 1.2 Extract and analyze the current supported Desktop `26.727.40816` Renderer asset, record the active slash registry/store candidates and structural signatures, and prove whether the mounted page instance can be uniquely adapted without dynamic re-import.
- [ ] 1.3 Locate one structurally verified authoritative cwd for a new logical Composer, test project changes and multiple mounted targets, and record a blocker rather than using Host process cwd if no unique value exists.
- [ ] 1.4 Run a hard-coded current-build behavioral PoC with a deliberate Codex/Pi same-name command and verify keyboard selection, mouse selection, exact manual input, Codex handler suppression, Composer insertion, Agent switching, and disposal.
- [ ] 1.5 Record the Gate decision to use the active native registry/store or a versioned Pi-only autocomplete controller, including fail-closed signatures and sanitized evidence; stop implementation if neither mechanism proves behavioral isolation.

## 2. Shared And Adapter Contracts

- [ ] 2.1 Add strict browser-safe command descriptor/catalog types and schemas with bounded fields, unique names, exact kinds, and rejection of native provenance or undeclared fields.
- [ ] 2.2 Extend fixed Harness inspection params/results for command inclusion with exact-cwd validation and add the fixed live Thread command-list params/result schemas.
- [ ] 2.3 Add focused Shared Contracts tests for valid mixed catalogs, duplicates, bounds, leading slash/whitespace, missing draft cwd, structured discovery failure, native method injection, and browser-safe exports.
- [ ] 2.4 Add `getCommandCatalog({refresh?})`, command-discovery capability, and inspection catalog result semantics to HarnessAdapter without adding `executeSlashCommand`, `executeNative`, or Renderer types.
- [ ] 2.5 Update Fake HarnessAdapters and compile-time contract tests for supported and unsupported command discovery while preserving existing Turn, Snapshot, configuration, Usage, and close behavior.

## 3. Pi Command Discovery

- [ ] 3.1 Add private Pi RPC schemas and correlated transport support for `get_commands`, Prompt response `agentInvoked`, `compact`, `get_state.autoCompactionEnabled`, and `set_auto_compaction` without exporting native types.
- [ ] 3.2 Extend ephemeral Pi inspection to query Models and commands in one bounded process for the exact cwd/configuration and close it on success, parse failure, timeout, and process failure without creating a durable Native Session.
- [ ] 3.3 Implement live Pi Session command discovery through its existing RPC process and a lazy-Session path that does not create a durable Native Session solely for autocomplete.
- [ ] 3.4 Normalize Extension, Prompt, and Skill sources; strip provenance; prepend compact/autocompact; de-duplicate collisions deterministically; and exclude TUI-only built-ins.
- [ ] 3.5 Add focused Pi discovery tests for all sources, malformed and private fields, duplicate extension suffixes, enhanced-control collisions, stable ordering, exact cwd separation, refresh, and bounded cleanup.

## 4. Pi Command Execution And Settlement

- [ ] 4.1 Parse accepted slash text inside PiAdapter and route only `/compact` and `/autocompact` to explicit control handlers while leaving all other and unknown slash input unchanged for Pi Prompt.
- [ ] 4.2 Implement `/compact [instructions]` through Pi RPC compact with ordered compaction/status projection, cancellation/failure handling, and exactly one Host Turn terminal.
- [ ] 4.3 Implement `/autocompact [on|off|toggle]` through state readback and `set_auto_compaction`, including argument errors and confirmed displayable results.
- [ ] 4.4 Correlate Prompt responses to accepted Turns and implement the `agentInvoked=false` idle barrier without racing or duplicating the normal Agent settlement path.
- [ ] 4.5 Preserve no-Agent-loop notifications and existing select/confirm/input/editor Question interactions, and return an explicit failure for unrepresentable required custom TUI behavior.
- [ ] 4.6 Add focused Pi execution tests for Extension local completion, Prompt and Skill Agent Turns, unknown commands, early Interaction, Agent-start races, missing correlation, compact/autocompact success and failure, cancellation, and Session reuse.

## 5. Generic Host Command Routing

- [ ] 5.1 Extend `codexhost/harness/inspect` handling to pass command inclusion and exact normalized draft configuration through the registered HarnessAdapter and validate the independent catalog result.
- [ ] 5.2 Add the fixed `codexhost/thread/commands/list` Host method and route loaded and persisted external Threads through generic ownership and `getCommandCatalog()` without Pi branches.
- [ ] 5.3 Add bounded in-flight coalescing or short process-local caching keyed by complete draft context or live Session identity, with refresh and Model/Thinking/Session invalidation and no persisted cache.
- [ ] 5.4 Reject missing cwd, malformed catalogs, Codex-owned Threads, unknown Threads, and unsupported Sessions explicitly without forwarding custom methods or slash content to official Codex.
- [ ] 5.5 Add hermetic Host tests with two Fake HarnessAdapters for draft/live ownership, unloaded resume, cross-Harness isolation, invalid boundary data, response ordering, cache separation, diagnostics privacy, and Codex transparency.

## 6. Renderer Command Projection

- [ ] 6.1 Add a narrow runtime-validating Renderer command client for extended Harness inspection and fixed live Thread command listing without exposing the request manager or a generic request API.
- [ ] 6.2 Add logical-Composer command state and request generations for draft cwd, live Thread identity, loading, ready, empty, refresh, error, Agent changes, replacement, navigation, and disposal.
- [ ] 6.3 Implement the Gate-selected versioned slash mechanism with structural uniqueness checks and no dynamic asset re-import, permanent global mutation, ASAR change, command-order override, DOM text scraping, or CSS-only isolation.
- [ ] 6.4 Render untrusted normalized descriptions and hints as escaped text, filter and rank Pi commands, and exclude codexhost application commands and Pi TUI-only commands.
- [ ] 6.5 Implement canonical slash-token replacement and keyboard/mouse behavior so selection and manual input both use normal submission, preserve arguments, and never call Pi or Host execution directly.
- [ ] 6.6 Prevent hidden Codex handlers from consuming Pi same-name or unknown slash input, and fail slash submission explicitly when behavioral isolation is unavailable.
- [ ] 6.7 Restore untouched stock command behavior for Codex Composers and preserve correct Pi state across only the existing valid logical Composer replacement/revisit rules.
- [ ] 6.8 Add focused Renderer tests for same-name collisions, hidden keyboard state, manual input, insertion, stale catalogs, ambiguous cwd/Thread, draft-to-conversation transfer, Pi-to-Codex restoration, cleanup, bounds, and accessibility behavior.

## 7. Validation And Baseline Updates

- [ ] 7.1 Run focused Shared Contracts, HarnessAdapter, PiAdapter, Host Runtime, Renderer Extension, and Desktop Control tests plus affected typecheck, lint, and builds.
- [ ] 7.2 Run a bounded real Pi RPC Gate that discovers one project Extension, Prompt Template, and Skill, proves source normalization and path omission, and executes no-Agent-loop plus compact/autocompact scenarios without recording user content.
- [ ] 7.3 Run the current-build Desktop collision Gate and prove by sanitized route evidence that mouse, keyboard, and manual `/compact` cannot emit an official Codex compact action in a Pi Composer.
- [ ] 7.4 Run the real Pi Desktop Gate for draft and existing Thread catalogs, Extension/Prompt/Skill execution, unknown slash ownership, compact/autocompact, same Native Session continuation, and stale-result isolation.
- [ ] 7.5 Run the symmetric Codex Gate and prove stock commands are restored, no Pi catalog is queried or injected, and official Codex behavior remains transparent.
- [ ] 7.6 Update the Renderer verification record, affected architecture/Adapter docs, and `docs/开发步骤清单.md` only with behaviors and Gates actually completed.
- [ ] 7.7 Run full repository checks required for this cross-package change, `openspec validate project-pi-slash-commands-into-codex-renderer --strict`, and `git diff --check`; record any skipped real platform Gate and its reason.
