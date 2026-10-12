# Proposal

## Why

O balcão precisa achar o produto pelo código de barras: o leitor pela câmera (Etapa 3) e as pistolas USB entregam só os dígitos. A busca do PDV promete "nome ou código de barras", mas `GET /api/products?query=` só procura no nome — ler um código não encontrava nada.

## What Changes

- `query` passa a casar também com o código de barras **exato** do produto, além do trecho do nome. Sem campo novo, sem quebra de resposta.
- Frontend (fora do contrato HTTP): botão de câmera no PDV e na Entrada de Estoque, com `BarcodeDetector` nativo e fallback `@zxing/library` servido pelo próprio app (a CSP só aceita scripts de `'self'`).

## Capabilities

### Modified Capabilities
- `products`: o filtro `query` da listagem também encontra o produto pelo código de barras exato.

## Impact

- `src/routes/products.js` (filtro), `openspec/openapi.yaml` (descrição do parâmetro), teste de integração novo.
- `src/app.js` serve `/vendor/zxing/` a partir da dependência `@zxing/library`.
