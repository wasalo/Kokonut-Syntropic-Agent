# Decision 0001: Follow Nearly's deployed creator pool-fee share

- **Status:** Accepted
- **Date:** 2026-10-24
- **Decision owner:** Kokonut Core Team

## Context

The supplied Nearly launch PRD specified a **7,000 bps creator pool-fee share**. That value conflicts with public state returned by the deployed NEAR mainnet factory. At final block height `221331059` (`86sFn72nvAjpFivqt141ZUyDMU2DtCNSsuCYEXhuJ8Qc`), account `nearlytrade.near` returned `creator_fee_share_bps = 6000` from `get_config` and `[6000, 6000]` from `get_creator_share_bounds`. The factory code hash at that same block was `9mwfrbtBbDr3y2t9rHY944qAQTU2PsB5smqsAHZJo4G5`.

## Decision

Use **6,000 bps** as the creator pool-fee share in the Nearly launch configuration model and readiness check. The deployed contract state is authoritative over conflicting documentation. Continue to fail closed if a fresh final-block read does not report 6,000 bps or the allowed bounds do not include it; recheck the factory immediately before any launch.

The original 7,000 bps PRD figure is superseded for the *creator pool-fee share* only.

## Scope distinction

This decision does **not** change the separate token-tax model: 3% buy/sell tax and the documented creator-controlled tax allocation. In `nearly-economics-preview.mjs`, the 7,000 bps creator share is the portion of token tax allocated to the creator-controlled pool before its 80/10/10 mission/holder/burn split. It is not the factory's creator pool-fee share. Do not merge these two settings.

## Safety

This decision updates a local model; it is not launch approval or a promise that factory state cannot change. The readiness command remains read-only and leaves legal, recipient, security, and token-specific gates for human review. Launch remains a human-authorized action through Nearly's UI and wallet.
