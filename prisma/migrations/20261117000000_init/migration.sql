-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ANALYST', 'APPROVER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('STARTING', 'RUNNING', 'PROCESSING', 'FINISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanTrigger" AS ENUM ('CRON', 'MANUAL');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('FLAGGED', 'CRITICAL');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_member" (
    "shop" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'ANALYST',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_member_pkey" PRIMARY KEY ("shop","user_id")
);

-- CreateTable
CREATE TABLE "settings_version" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "target_margin" DECIMAL(6,4) NOT NULL,
    "flag_threshold" DECIMAL(6,4) NOT NULL,
    "critical_threshold" DECIMAL(6,4) NOT NULL,
    "max_discount" DECIMAL(6,4) NOT NULL,
    "dim_divisor" DECIMAL(10,2) NOT NULL,
    "reprice_max_increase" DECIMAL(6,4) NOT NULL,
    "surcharge_max" DECIMAL(10,2) NOT NULL,
    "override_is_per_box" BOOLEAN NOT NULL DEFAULT false,
    "tiers" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "settings_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "trigger" "ScanTrigger" NOT NULL,
    "triggered_by_id" TEXT NOT NULL,
    "triggered_by_name" TEXT NOT NULL,
    "products_scanned" INTEGER NOT NULL DEFAULT 0,
    "variants_scanned" INTEGER NOT NULL DEFAULT 0,
    "flags_found" INTEGER NOT NULL DEFAULT 0,
    "settings_version_id" INTEGER NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'STARTING',
    "bulk_operation_id" TEXT,
    "result_url" TEXT,
    "lines_processed" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "data_health" JSONB,
    "monthly_loss_cents" INTEGER,
    "error" TEXT,

    CONSTRAINT "scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flag" (
    "id" SERIAL NOT NULL,
    "scan_id" INTEGER NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "product_title" TEXT NOT NULL,
    "variant_title" TEXT,
    "image_url" TEXT,
    "tier" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "unit_cost_cents" INTEGER NOT NULL,
    "freight_cents" INTEGER NOT NULL,
    "landed_cost_cents" INTEGER NOT NULL,
    "margin_pct" DECIMAL(10,6) NOT NULL,
    "margin_at_discount_pct" DECIMAL(10,6) NOT NULL,
    "severity" "Severity" NOT NULL,
    "suggested_fix" TEXT NOT NULL,
    "exclude_from_discounts" BOOLEAN NOT NULL,
    "suggested_value_cents" INTEGER,
    "units_sold_30d" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_issue" (
    "id" SERIAL NOT NULL,
    "scan_id" INTEGER NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "product_title" TEXT NOT NULL,
    "variant_title" TEXT,
    "missing" TEXT[],
    "has_map" BOOLEAN NOT NULL,

    CONSTRAINT "data_issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT NOT NULL,
    "actor_name" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "product_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "inputs" JSONB,
    "reason" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "settings_version_shop_created_at_idx" ON "settings_version"("shop", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "scan_bulk_operation_id_key" ON "scan"("bulk_operation_id");

-- CreateIndex
CREATE INDEX "scan_shop_started_at_idx" ON "scan"("shop", "started_at");

-- CreateIndex
CREATE INDEX "flag_scan_id_severity_idx" ON "flag"("scan_id", "severity");

-- CreateIndex
CREATE INDEX "flag_product_id_idx" ON "flag"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "flag_scan_id_variant_id_key" ON "flag"("scan_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_issue_scan_id_variant_id_key" ON "data_issue"("scan_id", "variant_id");

-- CreateIndex
CREATE INDEX "audit_log_shop_at_idx" ON "audit_log"("shop", "at");

-- CreateIndex
CREATE INDEX "audit_log_shop_product_id_idx" ON "audit_log"("shop", "product_id");

-- CreateIndex
CREATE INDEX "audit_log_shop_actor_id_idx" ON "audit_log"("shop", "actor_id");

-- CreateIndex
CREATE INDEX "audit_log_shop_event_type_idx" ON "audit_log"("shop", "event_type");

-- AddForeignKey
ALTER TABLE "scan" ADD CONSTRAINT "scan_settings_version_id_fkey" FOREIGN KEY ("settings_version_id") REFERENCES "settings_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag" ADD CONSTRAINT "flag_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_issue" ADD CONSTRAINT "data_issue_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- audit_log is append only. Reject any UPDATE or DELETE at the database level.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
