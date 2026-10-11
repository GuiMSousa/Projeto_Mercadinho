-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'PIX', 'DEBIT_CARD', 'CREDIT_CARD');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "cashSessionId" TEXT,
ADD COLUMN     "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH';

-- CreateTable
CREATE TABLE "StockBatch" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "remaining" DECIMAL(12,3) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovementBatch" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,

    CONSTRAINT "StockMovementBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashSession" (
    "id" TEXT NOT NULL,
    "isOpen" BOOLEAN DEFAULT true,
    "openingAmount" DECIMAL(12,2) NOT NULL,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "countedAmount" DECIMAL(12,2),
    "expectedAmount" DECIMAL(12,2),
    "notes" TEXT,

    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockBatch_productId_idx" ON "StockBatch"("productId");

-- CreateIndex
CREATE INDEX "StockBatch_expiryDate_idx" ON "StockBatch"("expiryDate");

-- CreateIndex
CREATE INDEX "StockMovementBatch_movementId_idx" ON "StockMovementBatch"("movementId");

-- CreateIndex
CREATE INDEX "StockMovementBatch_batchId_idx" ON "StockMovementBatch"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "CashSession_isOpen_key" ON "CashSession"("isOpen");

-- CreateIndex
CREATE INDEX "CashSession_openedAt_idx" ON "CashSession"("openedAt");

-- CreateIndex
CREATE INDEX "Sale_cashSessionId_idx" ON "Sale"("cashSessionId");

-- AddForeignKey
ALTER TABLE "StockBatch" ADD CONSTRAINT "StockBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovementBatch" ADD CONSTRAINT "StockMovementBatch_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovementBatch" ADD CONSTRAINT "StockMovementBatch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preenchimento: o estoque que já existia vira um lote por produto, com a
-- validade que estava no produto (que passa a ser derivada dos lotes).
INSERT INTO "StockBatch" ("id", "productId", "quantity", "remaining", "expiryDate", "createdAt")
SELECT gen_random_uuid()::text, "id", "currentStock", "currentStock", "expiryDate", CURRENT_TIMESTAMP
FROM "Product"
WHERE "currentStock" > 0;

-- Sem saldo não há lote, e sem lote não há validade.
UPDATE "Product" SET "expiryDate" = NULL WHERE "currentStock" <= 0;
