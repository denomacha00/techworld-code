// Pure conversion of the gateway's billing meter into dollars — no vscode, no fetch, so it can be
// unit-tested in isolation. The gateway exposes two OpenAI-style endpoints:
//   GET /v1/dashboard/billing/usage         -> { total_usage: <number> }   (spend so far)
//   GET /v1/dashboard/billing/subscription  -> { hard_limit_usd: <number> } (the key's cap)
// `hard_limit_usd` is unambiguously in DOLLARS (a $1-capped key reports 1, a $5 key reports 5).
// `total_usage` follows the OpenAI convention of CENTS (so $5.00 spent reads as 500) — but a clone
// could report dollars, so the unit is a setting (`meterInCents`, default true) and the raw value is
// surfaced in the UI tooltip so any 100x mismatch is obvious at a glance and one toggle fixes it.

export interface RawBilling {
  /** The gateway's `total_usage` figure, verbatim (cents by OpenAI convention). */
  totalUsage: number;
  /** The gateway's `hard_limit_usd`, verbatim (already dollars), or undefined if absent. */
  hardLimitUsd: number | undefined;
}

export interface BillingUsd {
  /** Real dollars deducted so far for this key. */
  spentUsd: number;
  /** The key's spend cap in dollars, if the gateway reported one (> 0). */
  limitUsd?: number;
}

/** Convert the raw meter into dollars. `meterInCents` divides total_usage by 100 (OpenAI convention);
 *  set it false for a gateway that already reports dollars. A missing/zero/negative cap is dropped. */
export function parseBillingUsd(raw: RawBilling, meterInCents: boolean): BillingUsd {
  const spentUsd = Math.max(0, meterInCents ? raw.totalUsage / 100 : raw.totalUsage);
  const limitUsd = typeof raw.hardLimitUsd === 'number' && raw.hardLimitUsd > 0 ? raw.hardLimitUsd : undefined;
  return { spentUsd, limitUsd };
}
