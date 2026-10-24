# Decision 0002 — Nearly event semantic evidence

**Status:** Source-verified event meanings recorded; `lock_8` provenance is byte-for-byte matched to its metadata-pinned source/build; `lock2` provenance remains unresolved. No runtime classifier or financial reconciliation is authorized by this note.

## Deployed source anchor

The current factory is `nearlytrade.near`.
A finalized `view_code` read at block **221388304** (`MT6s9LNCykqESsxKaU4RXKLxPY9LZGdETKrDJhdCaWi`) returned a 690,781-byte Wasm whose SHA-256 is `8260ddd1cd0366577f4bd7717a42f9a602707776ea74e6a49f66004a78170496`; its NEAR base58 code hash is `9mwfrbtBbDr3y2t9rHY944qAQTU2PsB5smqsAHZJo4G5`.[3]
The contract's `contract_source_metadata` view at block **221388309** pins the source snapshot to commit `e82bfa013ea380f9dbbcb9d58e9f0af798185eab`.[3]
The hash computed from the fetched on-chain Wasm matches the repository's current hash manifest.[3]
The factory and tax-token source files at that commit also match the later inspected repository tree.[1][2]

The upgrade transaction `2uraygxPDLGtiuY9rHhHGWx2AKG1KNWYCNDnNzk1dfTc` has a `nearlytrade.near` `upgrade_code` receipt at block **220717735** carrying that code hash, followed by a successful `migrate` receipt at block **220717737**.[3]
Use **220717737** as the earliest block for applying this release's semantics.[3]
The queried current code hash proves the code was active at block 221388304; it is not a promise that the same code remains current forever.[3]

The factory emits its own events from `nearlytrade.near` under `standard: "nearpad"`, `version: "2.0.0"`.[1]
The tax token emits NEP-141 events from the *token account*, not the factory.[2]
The event name and standard alone do not prove which historical factory or token code produced a log.[1][2]

## Source-verified meanings and limits

Amounts are raw integer base units.[1][2]
Keep the event's asset and launch context; do not add amounts across different assets or treat seller-reported quantities as independently verified trades.[1][2]

| Event | What the deployed code records | What it does **not** prove by itself |
|---|---|---|
| `tax_collected` [1] | A successful `tax_take` callback returned an amount and the factory added that amount to the launch's pending-tax counter. | A sale, a distribution, or a recipient payment. |
| `tax_to_seller` / `tax_to_seller_failed` [1] | The factory's tax-token transfer to its configured seller succeeded / failed. | That the seller sold the tokens. The success event is a handoff, not sale proceeds. |
| `tax_sold` [1] | The factory accepted a seller settlement after checking `sold` against the outstanding amount, `got > 0`, and the proceeds floor; it then distributes the received amount into accounting buckets. `sold` is seller-reported and bounded, not linked by this event to a particular DCL trade. | Independent proof that the reported token quantity was sold on the exchange. |
| `tax_paid` [1] | The factory calculated and booked platform, creator, and holder shares from the settlement amount. | That all those shares reached their final beneficiaries. Some shares are booked for later processing; asynchronous transfers can fail. |
| `tax_burned` / `tax_burn_failed` [1][2] | The factory's callback reports success / failure for its token `burn` call. | For historical token accounts, the correct token implementation or a complete supply reconciliation. Correlate a successful burn with the exact launch token's `nep141:ft_burn` log and supply state. The current tax-token source reduces total supply before emitting that event. |
| `tax_holders_paid` [1] | An aggregate amount was debited from the holder bucket and per-recipient payout promises were submitted. | Success for every individual payment. A failed holder transfer is booked as `holder_owed`; `owed_paid` is emitted by the later owed-balance push callback when that payment succeeds. |
| `tax_returned` [1] | Tax tokens returned by the seller were moved back to pending tax, with the associated sale floor reduced. | A completed sale or payout. |
| `fees_claimed` [1] | The factory accepted a two-amount result from the launch's selected locker, booked those amounts in its fee counters, and emitted them. | That the locker delivered the same amounts to the factory. The factory trusts the locker result; inspect the receipt tree and exact locker deployment before treating them as received funds. |
| `fees_to_seller` / `fees_to_seller_failed` [1] | A pool-fee slice was removed from its fee bucket and sent to the seller / the send failed and the slice was credited back. `fees_to_seller` is emitted before the asynchronous send result. | A successful sale or settlement. Absence of the failure event is not a substitute for inspecting the receipt tree. |
| `fees_sold` [1] | The factory accepted a bounded seller settlement and credited the received amount to the appropriate creator, holder, or protocol accounting bucket. | That the reported `sold` quantity corresponds to a specific exchange trade. |
| `fees_burned` / `burn_failed` [1][2] | The factory's callback reports success / failure for a token-fee burn. | Historical token-version identity or the complete supply effect without the matching token-account event/state. |
| `holder_owed` / `owed_paid` [1] | A holder payment failure became an owed balance / a later owed payment succeeded. | Any unrelated holder distribution or balance not tied to the event's asset, account, and receipt. |

These factory and tax-token meanings come from the source revision linked by the deployed factory metadata.[1][2]
They define event-level observations, not a ledger.[1][2]
In particular, `tax_paid`, `tax_holders_paid`, fee-split events, and seller handoff events must not be promoted to “payout completed” without validating the relevant receipt outcomes and asset movement.[1][2]

### Locker-dependent fee claims

The factory's `fees_claimed` callback is only as trustworthy as the selected locker: it books the two returned amounts but does not independently inspect the locker-to-factory asset transfers.[1]
At finalized block **221390375**, `get_lockers` returned thresholds that imply launch **1230** uses `lock2.nearlytrade.near` and launch **3435** uses `lock_8.nearlytrade.near`.[1][7]

**`lock_8.nearlytrade.near` provenance is resolved.** At the fee-claim receipt block **221386695** (`iaKXkeZ212W5iYVcFY8DK2LjbJF1qookbJof42XbgQ8`), `view_code` returned 287,404 bytes, NEAR code hash `4CMfhWsUNfXgotni5nnt9vePC1dpb4aQF8x1KQjoyG6u`, and SHA-256 `2f7bd173e4aef59e944d36ae0152d22d7d6a08c3dbac5a9a166eb954db898312`.[7]

The same-block NEP-330 metadata pins source commit `a476bbe47a694e2b24e7060738870065882df011`, `linux/amd64` image `sourcescan/cargo-near:0.22.0-rust-1.97.1@sha256:7467038bdddc86484b73b416eeadce926ff59013e128e53dec5a19e1cb4b2234`, and command `cargo near build non-reproducible-wasm --locked`.[6][7][8]

An independent rebuild from that commit in the pinned image, with the recorded NEP-330 metadata context, produced the same 287,404-byte artifact; SHA-256 matched and `cmp` confirmed byte-for-byte equality.[6][7][8]

A bare build that omitted that metadata context produced a different artifact and is not a valid provenance comparison.[6][7][8] The pinned query and rebuild results are recorded in `docs/evidence/nearly-locker-provenance-2026-10-24.json`.

**`lock2.nearlytrade.near` provenance remains unresolved.** At the fee-claim receipt block **221393047** (`4XZCsEZKiFTt8NNGQd2Qtvi8EEj3pLMGo8usDq4KNVnv`), its code was 154,314 bytes, NEAR code hash `H2hLLyZ9k5Z5SVRBPrj7Ke9NQMpsENqN5SoSMf52gCHe`, SHA-256 `ee2a2d48c807f67bf8af8fdbc29aceffc20bc3218d597326cfc034f6a8868c79`; metadata reports version `0.2.0`, a repository link without a revision, and `build_info: null`.[4][7]

The current-source Linux rebuild from commit `3d59877216c93e56309f7c21568eaa3d17bccfc0` produces a different hash (`0449fb2fc3493e2e42c3c2d8cf8cf5044738baa7d0899991f68aab1ef0e8a2cb`). The deployed Wasm contains `aarch64-apple-darwin` and `/Users/soul/.cargo` paths, while the Linux rebuild contains Linux paths; this supports a host/platform mismatch but does not reproduce the deployed bytes or identify the exact source revision/build.[4][5][7]

Two transaction-scoped receipt audits show matching locker-to-factory observations: transaction `EH5J4bgSdNvJtGrBnmudXkJrnm6MwSiYqdzrEWfYDtiW` for launch 3435 has a successful native `Transfer` matching `fee_near` and a successful token-contract `ft_transfer` receipt whose NEP-141 log amount matches `fee_token`; transaction `BAuSqbnFEq4BHaJ4UcaoCNBn2AT9tWF77LbpwHvaD4KJ` for launch 1230 has the same kinds of amount matches.[7][9] Both receipt graphs were complete with no failed action receipts or diagnostics. These are observations about these two transactions only—not proof for all `fees_claimed` events, not a general locker guarantee, and not a substitute for token balance reconciliation. Raw pinned receipt data is in `docs/evidence/locker-fees-claim-receipt-samples-2026-10-24.json`.

Accordingly, `lock_8` source/build provenance is verified, while `lock2` provenance is not. `fees_claimed` remains a factory-accepted locker report in the general case; classify or reconcile individual transfers only from their exact receipt trees, with verified token identity and asset movement.

## Indexer boundary

`near-account-events` remains a one-page raw reader.
It verifies the actual receipt executor against the requested account, but it does not currently resolve historical code hashes per receipt, map launch IDs to historical token code hashes, or attach these interpretations.
Before runtime classification, build and verify version-to-block/code-hash maps for factory, token, and selected locker; require the event emitter, event envelope, release range, and successful execution outcome; map the event's launch and asset; and inspect receipt-level asset transfers for locker-dependent events. Keep seller-reported fields and pending obligations distinct from completed transfers.
Older factory, token, and locker generations remain unclassified until their own source and deployed code hashes are verified.
KI persistence/reconciliation remains deferred.[1][2]

## Sources

[1] https://raw.githubusercontent.com/sam3dsol/NearlyTrade/e82bfa013ea380f9dbbcb9d58e9f0af798185eab/contracts/factory/src/lib.rs
[2] https://raw.githubusercontent.com/sam3dsol/NearlyTrade/e82bfa013ea380f9dbbcb9d58e9f0af798185eab/contracts/token-tax/src/lib.rs
[3] https://raw.githubusercontent.com/sam3dsol/NearlyTrade/3d59877216c93e56309f7c21568eaa3d17bccfc0/README.md
[4] https://raw.githubusercontent.com/sam3dsol/NearlyTrade/3d59877216c93e56309f7c21568eaa3d17bccfc0/legacy/locker-v2/README.md
[5] https://raw.githubusercontent.com/sam3dsol/NearlyTrade/3d59877216c93e56309f7c21568eaa3d17bccfc0/legacy/locker-v2/src/lib.rs
[6] https://raw.githubusercontent.com/sam3dsol/NearlyTrade/a476bbe47a694e2b24e7060738870065882df011/contracts/locker3/src/lib.rs
[7] https://rpc.mainnet.near.org
[8] https://raw.githubusercontent.com/sam3dsol/NearlyTrade/a476bbe47a694e2b24e7060738870065882df011/contracts/locker3/Cargo.toml
[9] https://tx.main.fastnear.com/v0/transactions
