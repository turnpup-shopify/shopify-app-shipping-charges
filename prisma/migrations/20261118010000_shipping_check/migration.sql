-- CreateTable
CREATE TABLE "shipping_check" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" "ScanTrigger" NOT NULL,
    "triggered_by_id" TEXT NOT NULL,
    "triggered_by_name" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "freight_profile_id" TEXT,
    "counts" JSONB NOT NULL,
    "to_add" JSONB NOT NULL,
    "to_remove" JSONB NOT NULL,
    "not_physical" JSONB NOT NULL,
    "protected_profile" JSONB NOT NULL,
    "rate_warnings" TEXT[],
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "shipping_check_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipping_check_shop_checked_at_idx" ON "shipping_check"("shop", "checked_at");

