-- CreateTable
CREATE TABLE "price_list_source" (
    "shop" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "updated_by_name" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_checked_at" TIMESTAMP(3),
    "last_check_status" TEXT,
    "last_check_detail" TEXT,

    CONSTRAINT "price_list_source_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "price_list_import" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "etag" TEXT,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sheet_name" TEXT NOT NULL,
    "columns" TEXT[],
    "row_count" INTEGER NOT NULL,
    "trigger" "ScanTrigger" NOT NULL,
    "triggered_by_id" TEXT NOT NULL,
    "triggered_by_name" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_list_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_item" (
    "id" SERIAL NOT NULL,
    "import_id" INTEGER NOT NULL,
    "item_number" TEXT NOT NULL,
    "upc" TEXT,
    "product_name" TEXT,
    "collection" TEXT,
    "category" TEXT,
    "wholesale_cents" INTEGER,
    "drop_ship_fee_cents" INTEGER,
    "total_price_cents" INTEGER,
    "map_cents" INTEGER,
    "ship_method" TEXT,
    "shipping_class" TEXT,
    "box_size" TEXT,
    "shipping_weight" DECIMAL(10,2),
    "data" JSONB NOT NULL,

    CONSTRAINT "price_list_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_list_import_shop_imported_at_idx" ON "price_list_import"("shop", "imported_at");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_import_shop_sha256_key" ON "price_list_import"("shop", "sha256");

-- CreateIndex
CREATE INDEX "price_list_item_item_number_idx" ON "price_list_item"("item_number");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_item_import_id_item_number_key" ON "price_list_item"("import_id", "item_number");

-- AddForeignKey
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "price_list_import"("id") ON DELETE CASCADE ON UPDATE CASCADE;

