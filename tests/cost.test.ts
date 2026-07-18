import { describe, expect, it } from "vitest";
import { computeCostCents, RATES_CENTS, type UsageEventLike } from "../src/lib/cost.js";

describe("computeCostCents", () => {
  it("matches an exact, hand-computed total for a fixed mixed input (no floating tolerance)", () => {
    const events: UsageEventLike[] = [
      { eventType: "api_call", quantity: 250 }, // 250 * 1c = 250c
      { eventType: "ai_tokens", quantity: 4000, metadata: { token_type: "fresh_input" } }, // 4000/1000 * 3c = 12c
      { eventType: "ai_tokens", quantity: 10000, metadata: { token_type: "cached_input" } }, // 10000/1000 * 1c = 10c
      { eventType: "ai_tokens", quantity: 3000, metadata: { token_type: "output" } }, // 3000/1000 * 15c = 45c
      { eventType: "ai_tokens", quantity: 1000, metadata: { token_type: "reasoning" } }, // 1000/1000 * 15c = 15c (billed as output)
    ];

    const result = computeCostCents(events);

    // apiCallCostCents: 250
    // aiTokenCostCents: 12 + 10 + 45 + 15 = 82
    // totalCostCents: 332
    expect(result.apiCallCostCents).toBe(250);
    expect(result.aiTokenCostCents).toBe(82);
    expect(result.totalCostCents).toBe(332);
  });

  it("bills reasoning tokens at the OUTPUT rate, not as a separate category", () => {
    const reasoning = computeCostCents([
      { eventType: "ai_tokens", quantity: 2000, metadata: { token_type: "reasoning" } },
    ]);
    const output = computeCostCents([
      { eventType: "ai_tokens", quantity: 2000, metadata: { token_type: "output" } },
    ]);
    expect(reasoning.aiTokenCostCents).toBe(output.aiTokenCostCents);
    expect(reasoning.aiTokenCostCents).toBe((2000 / 1000) * RATES_CENTS.AI_TOKENS_PER_1000.OUTPUT);
  });

  it("bills cached input tokens at a strictly lower rate than fresh input tokens", () => {
    const fresh = computeCostCents([
      { eventType: "ai_tokens", quantity: 5000, metadata: { token_type: "fresh_input" } },
    ]);
    const cached = computeCostCents([
      { eventType: "ai_tokens", quantity: 5000, metadata: { token_type: "cached_input" } },
    ]);
    expect(cached.aiTokenCostCents).toBeLessThan(fresh.aiTokenCostCents);
    expect(fresh.aiTokenCostCents).toBe(15);
    expect(cached.aiTokenCostCents).toBe(5);
  });

  it("treats ai_tokens with no token_type as fresh input", () => {
    const untyped = computeCostCents([{ eventType: "ai_tokens", quantity: 4000 }]);
    expect(untyped.aiTokenCostCents).toBe(12);
  });
});
