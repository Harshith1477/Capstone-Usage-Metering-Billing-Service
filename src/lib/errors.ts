export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`Tenant ${tenantId} not found`);
    this.name = "TenantNotFoundError";
  }
}

export interface QuotaExceededDetails {
  eventType: "api_call" | "ai_tokens";
  used: number;
  limit: number;
  quantity: number;
}

export class QuotaExceededError extends Error {
  details: QuotaExceededDetails;

  constructor(details: QuotaExceededDetails) {
    super(
      `Quota exceeded for ${details.eventType}: ${details.used + details.quantity} would exceed limit of ${details.limit}`
    );
    this.name = "QuotaExceededError";
    this.details = details;
  }
}
