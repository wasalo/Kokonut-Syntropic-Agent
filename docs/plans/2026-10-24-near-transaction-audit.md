# Read-Only NEAR Transaction Receipt Audit Implementation Plan

> **For Hermes:** Execute this plan task-by-task with subagent-driven-development and strict test-driven-development.

**Goal:** Add a read-only `near-tx-audit <TX_HASH>` command that retrieves one FastNear transaction and reports receipt-tree execution and raw transfer evidence without claiming payout completion or classifying economics.

**Architecture:** Use FastNear's `/v0/transactions` lookup by transaction hash, matching the existing provider integration. Separate retrieval/validation from a deterministic auditor that reports transaction and receipt provenance, statuses, graph coverage, native `Transfer` actions, `ft_transfer` function-call observations, and raw logs. Missing or inconsistent response layers produce a partial audit, never an implied complete tree.

**Tech Stack:** Node.js ES modules, built-in `node:test`, built-in `fetch`; no new dependencies, persistence, signing, or KI integration.

---

## Scope and invariants

- One transaction per invocation; one provider lookup; no pagination or persistence.
- Provider: `https://tx.main.fastnear.com/v0/transactions`, request body `{ "tx_hashes": [TX_HASH] }`.
- Resolve signer from the returned transaction; do not require a second CLI argument.
- Preserve returned block, transaction, receipt, outcome, status, and raw-log provenance.
- Compare receipt IDs referenced by the root and action-receipt outcomes against **action receipt** and outcome IDs; report missing, duplicate, mismatched, or orphan action receipt entries. Keep FastNear `data_receipts` separate: their `receipt_id` is top-level and the NEAR receipt variant is nested at `receipt: { Data: ... }`; they have no execution outcome and are not action-graph orphans merely because they are absent from `receipt_ids`.
- Preserve data-receipt provenance and distinguish malformed or duplicate data receipt entries from missing execution outcomes.
- Observe native `Transfer` actions from the root transaction and successful action receipts with exact deposit and destination. Missing/invalid transfer fields must be diagnosed and make the report partial. Report root or receipt `ft_transfer` FunctionCalls as calls (not proof of NEP-141 transfer or payout); never expose arbitrary function-call args or memos. Preserve raw logs without economic interpretation.
- Require a valid `transaction.actions` array; a missing or malformed root action collection makes the report partial rather than silently appearing empty.
- Explicitly label output as observational; never say payout/reward/tax completion is verified.
- Do not touch KI schemas/connectors, launch signing/submission, or locker semantic classification.
- Read FastNear credentials only from the existing environment variable; never print or persist credential values.

## Task 1: Add deterministic receipt-tree auditor with TDD

**Files:**
- Create `src/near-transaction-audit.mjs`.
- Create `test/near-transaction-audit.test.mjs`.

**Steps:**
1. Write a fixture with a root transaction, a linked action-receipt chain, a FastNear-shaped data receipt (`data_receipts` row with top-level `receipt_id` and nested `receipt.Data`), statuses, root/receipt native transfer actions, root/receipt `ft_transfer` calls, and raw logs. Assert provenance, action-graph coverage, separate data receipt inventory, exact successful native-transfer destination/deposit, and call-only labels without leaking args/memos.
2. Run `node --test test/near-transaction-audit.test.mjs`; verify the expected missing-export failure.
3. Implement only the pure transform and validation needed by that test.
4. Add failing tests for missing action-receipt/outcome references, duplicate/mismatched IDs, failed receipts, malformed action/data receipt collections, malformed data-receipt rows, missing root actions, and invalid native-transfer fields; each incomplete case must be visible and must not claim graph or transfer completeness. Do not require parsing arbitrary FunctionCall args: omit them and label `ft_transfer` as call-only.
5. Run the focused test after each minimal implementation; then run the full suite.

## Task 2: Add the FastNear transaction lookup with TDD

**Files:**
- Modify `src/near-transaction-audit.mjs`.
- Modify `test/near-transaction-audit.test.mjs`.

**Steps:**
1. Add a failing injected-fetch test asserting exact endpoint, `{ tx_hashes: [hash] }`, optional Bearer header without exposing its value, and one matching transaction returned.
2. Run the focused test to verify it fails for the missing reader.
3. Implement one transaction lookup, exact hash matching, HTTP/JSON/schema error handling, and route the response into the pure auditor.
4. Add tests for HTTP errors, malformed JSON/collections, missing transaction, and provider response containing a different hash.
5. Run focused and full suites.

## Task 3: Expose the CLI and document the limits

**Files:**
- Modify `src/cli.mjs`.
- Modify `test/cli.test.mjs`.
- Modify `README.md`.

**Steps:**
1. Add black-box CLI tests for usage/exit code and for a successful command using an injectable local HTTP test seam or a child-process-safe fixture; verify no live network is needed in unit tests.
2. Run focused CLI tests and verify expected failures.
3. Wire `near-tx-audit <TX_HASH>` to the reader; emit JSON and return nonzero for partial audits while still printing their evidence.
4. Document the command, provider source, raw-only interpretation, completeness limits, and that this is not financial reconciliation.
5. Run CLI tests and the full suite.

## Task 4: Live read-only verification and local commit

**Steps:**
1. Run one smoke audit against a public Nearly transaction obtained from a public FastNear event-history sample; do not represent it as Kokonut activity.
2. Confirm the output reports transaction/receipt provenance, distinguishes a complete versus partial receipt graph, and makes no payout claim.
3. Run `npm test` and `git diff --check`; inspect the final diff and worktree.
4. Commit locally with a descriptive `feat:` message; do not push.
