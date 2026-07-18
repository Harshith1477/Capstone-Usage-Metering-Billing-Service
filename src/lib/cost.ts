/**
 * Pinned billing rates (test-mode project — figures are illustrative, not real
 * Stripe/Anthropic/OpenAI prices). All rates are integer cents so that cost
 * math can be done with exact integer arithmetic and asserted with no
 * floating-point tolerance in tests.
 */
export const RATES_CENTS = {
  API_CALL: 1, // cents per api_call event
  AI_TOKENS_PER_1000: {
    FRESH_INPUT: 3, // cents per 1000 fresh (non-cached) input tokens
    CACHED_INPUT: 1, // cents per 1000 cached input tokens (cheaper than fresh)
    // Output tokens. Reasoning tokens are billed here too — they are NOT a
    // separate billable category, they are part of output per the spec.
    OUTPUT: 15,
  },
} as const;

export type TokenType = "fresh_input" | "cached_input" | "output" | "reasoning";

export interface UsageEventLike {
  eventType: "api_call" | "ai_tokens";
  quantity: number;
  metadata?: { token_type?: TokenType } | null;
}

/**
 * Maps a token_type from event metadata onto its billing rate.
 * reasoning -> OUTPUT: the spec requires reasoning tokens to be folded into
 * the output bucket rather than tracked/billed as their own category.
 */
function tokenRateCentsPer1000(tokenType: TokenType | undefined): number {
  switch (tokenType) {
    case "cached_input":
      return RATES_CENTS.AI_TOKENS_PER_1000.CACHED_INPUT;
    case "output":
    case "reasoning":
      return RATES_CENTS.AI_TOKENS_PER_1000.OUTPUT;
    case "fresh_input":
    case undefined:
    default:
      return RATES_CENTS.AI_TOKENS_PER_1000.FRESH_INPUT;
  }
}

export interface CostBreakdown {
  apiCallCostCents: number;
  aiTokenCostCents: number;
  totalCostCents: number;
}

/**
 * Computes cost in integer cents for a batch of usage events. Uses
 * Math.round only at the per-event boundary so repeated small events don't
 * accumulate drift beyond standard cents rounding.
 */
export function computeCostCents(events: UsageEventLike[]): CostBreakdown {
  let apiCallCostCents = 0;
  let aiTokenCostCents = 0;

  for (const event of events) {
    if (event.eventType === "api_call") {
      apiCallCostCents += event.quantity * RATES_CENTS.API_CALL;
    } else if (event.eventType === "ai_tokens") {
      const rate = tokenRateCentsPer1000(event.metadata?.token_type);
      aiTokenCostCents += Math.round((event.quantity * rate) / 1000);
    }
  }

  return {
    apiCallCostCents,
    aiTokenCostCents,
    totalCostCents: apiCallCostCents + aiTokenCostCents,
  };
}
