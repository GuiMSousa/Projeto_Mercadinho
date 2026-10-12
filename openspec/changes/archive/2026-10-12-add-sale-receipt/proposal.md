# Proposal

## Why

No fim da venda o balcão precisa entregar um comprovante: impresso na bobina térmica (58 mm ou 80 mm) ou mandado pelo WhatsApp do cliente. O comprovante atual não traz o nome do estabelecimento — o sistema nem guarda esse nome — nem subtotal e descontos, e não sai formatado para bobina.

## What Changes

- Nova configuração `STORE_NAME` (nome do estabelecimento, padrão "Mercadinho") e `GET /api/settings`, que a devolve a qualquer usuário autenticado.
- Frontend (fora do contrato HTTP): o modal de venda confirmada vira um recibo com nome do estabelecimento, data/hora, itens, subtotal, descontos, total e forma de pagamento (com valor recebido e troco em dinheiro), com os botões "Imprimir recibo" (CSS de impressão para bobina) e "Enviar por WhatsApp" (`https://wa.me/?text=`).
- O PDV não tem desconto hoje: a linha "Descontos" é a diferença entre a soma dos itens e o total gravado, e sai R$ 0,00.

## Capabilities

### Modified Capabilities
- `sales`: dados do estabelecimento para o recibo da venda; total da venda como soma dos itens arredondados.

## Impact

- `src/config.js`, `src/routes/settings.js`, `src/app.js`, `openspec/openapi.yaml`, `.env.example`, `docker-compose.yml`.
- `public/app.html`, `public/js/app.js`, `public/css/style.css`; testes de integração e E2E.
