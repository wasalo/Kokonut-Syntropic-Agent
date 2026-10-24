# Decision 0003 — Nearly tax-allocation contract compatibility

**Status:** The PRD's 70/20/10 gross tax allocation remains the product target only. It is not supported by the currently observed factory tax bound. Launch is blocked until contract support and human approval are established.

## Verified contract state

At finalized block **221413865** (`DUKj6196K6H37rJRb1mnNg5s9Eoke3eyAa2KqU55YTjy`), `nearlytrade.near` had code hash `9mwfrbtBbDr3y2t9rHY944qAQTU2PsB5smqsAHZJo4G5`.[2]

At the same block, `get_config.creator_fee_share_bps` was **6000** and `get_creator_share_bounds` returned **[6000, 6000]**. This is the creator's separate pool-fee share—not the token-tax allocation.[2]

`get_tax_bounds` returned **[400, true, 4000]**: the factory reports a 400-bps tax ceiling, tax code installed, and `platform_tax_bps=4000`.[1][2] The deployed source sets the platform total to the sum of protocol, holders-pot, and referral-pot constants; those constants are 2000, 1000, and 1000 bps respectively.[1] The target external split is 70% creator-controlled / 20% Nearly / 10% referrals, with the proposed holder allocation nested inside the creator-controlled share. The current platform-level holders pot is an additional component absent from that target, so the observed 4000-bps platform total does not support the target's 3000-bps non-creator share.[1][2]

Existing launches also have distinct stored tax settings. At the same block, launch **3435** reported 100-bps buy/sell rates, creator/holders/burn weights **3300/3400/3300**, and `platform_bps=4000`; launch **1230** reported `platform_bps=2000` and a different split.[2] These historical per-launch values must not be treated as defaults for a future launch.

## Decision and launch gate

Preserve the 70/20/10 gross tax split and its proposed 80/10/10 creator-side allocation as product targets, not as claims about current deployed behavior. Do not submit or approve a launch against a factory that cannot demonstrate the target allocation in its deployed code and final launch terms. The launch remains blocked until compatible contract support is deployed or independently verified, the final payload and receipt-level asset routing match the approved target, and required human/legal approvals are recorded.

The read-only `near-readiness` check compares the pinned `get_tax_bounds` result with preliminary target conditions: tax code must be installed, the maximum rate must support 300 bps, and `platform_tax_bps` must equal 3000. Any mismatch is a blocker. A match is only a necessary factory-level condition, not proof that the full split is implemented or approved. Passing still does not authorize a launch; the report keeps payload, recipient, legal, security, and token-specific review gates open.

The 6000-bps `creator_share_bps` pool-fee setting remains separate and contract-aligned. Do not relabel it as a token-tax setting or use it to imply the tax target is supported.

Raw pinned RPC observations: `docs/evidence/nearly-tax-config-snapshot-2026-10-24.json`.

A later live `near-readiness` run on finalized block **221417620** again returned the 6000-bps pool-fee share and `[400, true, 4000]` tax bounds across six reads pinned to that block; the report is blocked and `launchAuthorized=false`. Its exit code 1 is the CLI's expected blocked-report status, not a provider or parsing failure. The captured report is `docs/evidence/nearly-readiness-live-2026-10-24.json`.[2]

This decision records a read-only compatibility gate; it does not authorize signing or launch.

## Sources

[1] https://raw.githubusercontent.com/sam3dsol/Nearlytrade/e82bfa013ea380f9dbbcb9d58e9f0af798185eab/contracts/factory/src/lib.rs — Nearly factory deployed-source snapshot at e82bfa0
[2] https://rpc.mainnet.near.org — NEAR mainnet RPC snapshots at finalized blocks 221413865 and 221417620
