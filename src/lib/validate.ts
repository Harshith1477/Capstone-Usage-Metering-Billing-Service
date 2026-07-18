export interface UsageBody {
  tenant_id: string;
  event_type: "api_call" | "ai_tokens";
  quantity: number;
  idempotency_key: string;
  metadata?: Record<string, unknown>;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUsageBody(body: unknown): ValidationResult<UsageBody> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.tenant_id !== "string" || !UUID_RE.test(b.tenant_id)) {
    return { ok: false, error: "tenant_id must be a valid UUID string" };
  }
  if (b.event_type !== "api_call" && b.event_type !== "ai_tokens") {
    return { ok: false, error: "event_type must be 'api_call' or 'ai_tokens'" };
  }
  if (typeof b.quantity !== "number" || !Number.isInteger(b.quantity) || b.quantity <= 0) {
    return { ok: false, error: "quantity must be a positive integer" };
  }
  if (typeof b.idempotency_key !== "string" || b.idempotency_key.length === 0) {
    return { ok: false, error: "idempotency_key must be a non-empty string" };
  }
  if (b.metadata !== undefined && (typeof b.metadata !== "object" || b.metadata === null)) {
    return { ok: false, error: "metadata must be an object if provided" };
  }

  return {
    ok: true,
    value: {
      tenant_id: b.tenant_id,
      event_type: b.event_type,
      quantity: b.quantity,
      idempotency_key: b.idempotency_key,
      metadata: b.metadata as Record<string, unknown> | undefined,
    },
  };
}
