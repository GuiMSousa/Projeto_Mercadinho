# Spec Delta

## MODIFIED Requirements

### Requirement: Registro de venda
`POST /api/sales` SHALL aceitar, de qualquer usuário autenticado, de 1 a 100 itens `{ productId, quantity }` com quantidade maior que zero (até 10.000). O preço unitário MUST ser o preço de venda atual do produto e o vendedor MUST ser o usuário da sessão, nunca valores enviados pelo cliente. A venda MUST ser atômica: ou todos os itens são gravados com baixa de estoque pelos lotes, na ordem PVPS, ou nada é.

#### Scenario: Venda concluída
- **WHEN** um caixa vende 2 unidades de um produto de R$ 5,49
- **THEN** a API responde 201 com `totalAmount` 10,98 e os itens com preço e subtotal para o comprovante
- **AND** o saldo do produto diminui 2, com uma movimentação SALE no extrato

#### Scenario: Cliente tenta impor o preço
- **WHEN** o corpo da venda inclui um preço ou outro vendedor
- **THEN** esses campos são ignorados e o total é calculado com o preço do cadastro

### Requirement: Cancelamento com devolução ao estoque
`POST /api/sales/{id}/cancel` (somente ADMIN) SHALL marcar a venda como cancelada e devolver cada item aos mesmos lotes de onde saiu, inclusive de produtos já desativados, registrando por item uma movimentação ADJUSTMENT "Cancelamento da venda <id>". Venda já cancelada MUST receber 409. Vendas canceladas MUST sair do histórico, dos relatórios e da previsão de demanda.

#### Scenario: Cancelamento
- **WHEN** o administrador cancela uma venda de 3 unidades
- **THEN** o saldo do produto sobe 3 e a venda deixa de aparecer em `GET /api/sales`

#### Scenario: Devolução ao lote de origem
- **WHEN** a venda cancelada tinha baixado 2 unidades de um lote e 1 de outro
- **THEN** o primeiro lote volta a ter 2 unidades a mais e o segundo, 1

#### Scenario: Cancelar duas vezes
- **WHEN** o administrador cancela uma venda já cancelada
- **THEN** a API responde 409 e o estoque não muda de novo

## ADDED Requirements

### Requirement: Forma de pagamento
A venda SHALL aceitar `paymentMethod` igual a `CASH` (dinheiro, padrão quando omitido), `PIX`, `DEBIT_CARD` ou `CREDIT_CARD`, e a forma de pagamento MUST aparecer na resposta da venda, no histórico e no detalhe. Valor fora da lista MUST receber 400.

#### Scenario: Venda no Pix
- **WHEN** a venda é enviada com `paymentMethod: "PIX"`
- **THEN** ela fica registrada como Pix e não entra no dinheiro esperado do caixa

#### Scenario: Cliente sem forma de pagamento
- **WHEN** a venda é enviada sem `paymentMethod`
- **THEN** ela é registrada como `CASH`
