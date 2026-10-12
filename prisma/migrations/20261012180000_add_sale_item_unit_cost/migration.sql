-- Custo unitário do item no momento da venda, para o CMV do painel financeiro.
-- As vendas anteriores recebem o custo atual do produto: a melhor informação disponível.
ALTER TABLE "SaleItem" ADD COLUMN "unitCost" DECIMAL(12,2);
UPDATE "SaleItem" i SET "unitCost" = p."costPrice" FROM "Product" p WHERE p."id" = i."productId";
ALTER TABLE "SaleItem" ALTER COLUMN "unitCost" SET NOT NULL;
