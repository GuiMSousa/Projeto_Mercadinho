# Tasks

## 1. Backend
- [x] 1.1 `STORE_NAME` na configuração, no `.env.example` e no `docker-compose.yml`
- [x] 1.2 `GET /api/settings` (autenticado) com `storeName`, no `openspec/openapi.yaml`
- [x] 1.3 Teste de integração da rota
- [x] 1.4 Total da venda em centavos: soma dos subtotais arredondados (o recibo fecha a conta)

## 2. Frontend
- [x] 2.1 Recibo no modal de venda confirmada: estabelecimento, data/hora, itens, subtotal, descontos, total e pagamento
- [x] 2.2 "Imprimir recibo" com CSS de impressão para bobina de 58/80 mm
- [x] 2.3 "Enviar por WhatsApp" com o resumo em `https://wa.me/?text=`
- [x] 2.4 Teste E2E do recibo, da impressão e da mensagem
