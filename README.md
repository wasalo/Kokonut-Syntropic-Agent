# Kokonut Syntropic Agent

A NEAR-anchored, chain-agnostic coordination agent for Kokonut Network. This repository implements agent-specific orchestration and tooling; it does not replace Kokonut Intelligence (KI) as the canonical system of record or Kokonut Protocol as the cross-chain policy and execution control plane.

## Development status

Current slices:

- **Agent manifest primitives:** validate a proposed version-1.0 manifest and produce deterministic canonical JSON/SHA-256 content hashes.
- **Nearly model validator and tax preview:** validate the local contract-aligned configuration and show exact-rational token-tax examples; these functions do not query contracts or authorize launch.
- **Nearly factory readiness observer:** read public mainnet factory state at one pinned final block, compare verifiable settings with the contract-aligned model, and report unresolved legal/recipient/token-specific gates. It is read-only and never authorizes launch.
- **Nearly launch-state observer:** read one launch's factory record, per-launch fee settings, tax view, token state, locker and DCL position at one pinned final block. It reports current state only; it does not index historical events or prove completed payouts.
- **NEAR event-log batch indexer core:** parse `EVENT_JSON:` logs from caller-supplied, contiguous NEAR block messages compatible with the NEAR Lake streamer shape, preserve block/shard/execution/receipt/log provenance, and quarantine malformed event payloads. It does not fetch historical data or infer tax/reward/burn/fee business meaning.

These are foundations, not complete epics or production integrations. The manifest does not establish identity or register anything on-chain. The factory observer does not inspect a launched token. The launch-state observer does not prove historical event completeness, completed treasury receipts, beneficiary control, legal signoff, or security approval. The event-log indexer is an offline parser for supplied data, not a configured backfill/indexing service.

The PRD's KI-dependent work is intentionally deferred until the KI refactor is complete. No KI schema, migration, connector, data model, or financial reconciler is included here.

## Current safety boundaries

- The agent may prepare and validate proposals; it must not self-approve or autonomously launch a token.
- Cross-chain execution belongs to Kokonut Protocol; do not add a parallel signer, relayer, or nonce manager here.
- Nearly owns its native token tax, holder rewards, and burns. This project must not add a Kokonut holder-claims vault, snapshot engine, or payout contract.
- The NEAR token and the existing Base/Virtuals token remain distinct instruments with separate rights and accounting.
- A config matching the local model is not proof that live factory or launch-specific settings match. Re-verify the deployed factory, exact launch terms, payout routing, legal approvals, and signed transaction before any real launch.
- IDs and external account references remain pending until their authoritative owners approve them; do not invent KI or Protocol identifiers.

## Local development

Requires Node.js 20 or later. No third-party dependencies are needed for the current slices.

```sh
npm test
npm run agent -- manifest examples/agent-manifest.example.json
npm run agent -- nearly examples/nearly-launch-model.example.json
npm run agent -- preview 10000
npm run agent -- near-readiness
npm run agent -- near-economics LAUNCH_ID
npm run agent -- near-events examples/near-event-message.synthetic.json
```

`near-readiness` reads public NEAR mainnet factory state at a pinned final block. A blocking mismatch is printed as JSON and exits nonzero. The report is observational only and never authorizes a launch.

`near-economics` takes a decimal Nearly launch ID and reads that launch's current factory, token, locker, and DCL position state at one pinned final block. It reports the current factory fee default separately from the specific launch's stored fee options; older launches may retain different settings. Unclaimed DCL position fees are raw balances, not proof of creator payout or realized treasury receipts. Historical events and completed payout verification are not included. Replace `LAUNCH_ID` with the numeric ID returned by Nearly; this command is read-only.

`near-events <message.json> [accountId ...]` parses local NEAR block-message JSON; input may be one message or an ordered JSON array of messages. Arrays must contain contiguous, increasing block heights. Optional account IDs filter by the emitting `executor_id`. The indexer validates the `EVENT_JSON:` envelope, preserves raw logs and block/shard/execution/receipt/log provenance, deduplicates event IDs, and quarantines malformed event JSON. It does not fetch NEAR block data, infer that an event represents tax/reward/burn/fee activity, reconstruct transaction trees, prove payouts, or write to KI. The checked-in example is synthetic and is not a Nearly launch or on-chain observation.

The example manifest's UUID and hashes are illustrative only, not registered Kokonut identity or approved policy. The Nearly example is a local product-model fixture, not deployable factory input or launch approval. `preview` expects taxable token base units as an integer string.

## License

Apache License 2.0. Copyright 2026 Kokonut Onchain Network; see `NOTICE` and `LICENSE`.

## Agent manifest

`src/agent-manifest.mjs` exports:

- `validateAgentManifest(input)` — returns human-readable issues for malformed or unknown fields, invalid UUID/hash formats, and duplicate chain-qualified instance identities.
- `canonicalManifestJson(manifest)` — recursively sorts object keys while preserving array order.
- `manifestSha256(manifest)` — returns a `sha256:<hex>` digest of that canonical JSON; it does not sign or publish the manifest.

## Nearly configuration model

`src/nearly-launch-config.mjs` exports `validateNearlyLaunchConfig(input)`. It returns an array of human-readable issues; an empty array means only that the input matches the contract-aligned product model. The pool-fee creator share is set to 6,000 bps, matching the factory configuration observed on NEAR mainnet; the tax model separately retains 3% buy/sell tax and the 80/10/10 split of the creator-controlled tax share. This validator does not query live state. See [decision record 0001](docs/decisions/0001-nearly-creator-pool-fee-share.md) for the pinned evidence and rationale. Unresolved launcher/creator details remain placeholders and deployment identifiers remain unset pre-launch.

`src/nearly-economics-preview.mjs` exports `previewNearlyTaxAllocation(taxableAmountUnits)`. It uses `BigInt` and reduced rational results to illustrate tax allocations without inventing Nearly's rounding behavior. It does not calculate pool fees, realized NEAR proceeds, USD value, or live contract outcomes.

`src/nearly-readiness.mjs` exports `readNearlyFactorySnapshot()` and `evaluateNearlyFactorySnapshot(snapshot)`. The reader calls public NEAR mainnet view methods at a single pinned final block; the evaluator fails closed if current factory state diverges from the contract-aligned model and leaves legal, recipient, token-specific, and approved-code-baseline checks for human review. This read-only check never authorizes or submits a launch. Recheck live state immediately before launch; the recorded evidence and decision are in [decision record 0001](docs/decisions/0001-nearly-creator-pool-fee-share.md).

See the NEAR Universal Orchestrator, Native Economy & Multichain Growth PRD supplied by the project owner for the governing architecture, requirements, open approvals, and release gates.
