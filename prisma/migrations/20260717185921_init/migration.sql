-- CreateTable
CREATE TABLE "plans" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "api_call_limit" INTEGER NOT NULL,
    "ai_token_limit" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "stripe_price_id" TEXT,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "plan_id" INTEGER NOT NULL,
    "stripe_customer_id" TEXT,
    "subscription_status" TEXT NOT NULL DEFAULT 'inactive',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "stripe_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_email_key" ON "tenants"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripe_customer_id_key" ON "tenants"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_tenant_id_idempotency_key_key" ON "usage_events"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_stripe_event_id_key" ON "webhook_events"("stripe_event_id");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
