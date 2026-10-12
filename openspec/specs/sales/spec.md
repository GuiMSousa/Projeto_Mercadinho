# sales Specification

## Purpose
Ponto de venda (caixa): registro de vendas com baixa automática do estoque, comprovante, histórico com visibilidade por perfil e cancelamento pelo administrador com devolução ao estoque. Contrato HTTP: operações da tag `Sales` em `openspec/openapi.yaml`.

## Requirements

### Requirement: Registro de venda
`POST /api/sales` SHALL aceitar, de qualquer usuário autenticado, de 1 a 100 itens `{ productId, quantity }` com quantidade maior que zero (até 10.000). O preço unitário MUST ser o preço de venda atual do produto e o vendedor MUST ser o usuário da sessão, nunca valores enviados pelo cliente. Cada subtotal MUST ser arredondado ao centavo e o `totalAmount` MUST ser a soma desses subtotais, para o recibo fechar a conta. A venda MUST ser atômica: ou todos os itens são gravados com baixa de estoque pelos lotes, na ordem PVPS, ou nada é.

#### Scenario: Venda concluída
- **WHEN** um caixa vende 2 unidades de um produto de R$ 5,49
- **THEN** a API responde 201 com `totalAmount` 10,98 e os itens com preço e subtotal para o comprovante
- **AND** o saldo do produto diminui 2, com uma movimentação SALE no extrato

#### Scenario: Quantidade fracionada
- **WHEN** a venda tem três produtos de R$ 1,99 o quilo, 0,333 kg de cada
- **THEN** cada subtotal é R$ 0,66 e o `totalAmount` é R$ 1,98, a soma deles

#### Scenario: Cliente tenta impor o preço
- **WHEN** o corpo da venda inclui um preço ou outro vendedor
- **THEN** esses campos são ignorados e o total é calculado com o preço do cadastro

### Requirement: Rejeição de itens inválidos
Uma venda MUST ser recusada por inteiro, sem baixar estoque, quando algum produto não existe ou está desativado (404), quando o mesmo produto aparece em mais de um item (400) ou quando algum item não tem saldo suficiente (409, com o nome do produto e o saldo disponível).

#### Scenario: Estoque insuficiente
- **WHEN** um item pede mais unidades do que o saldo disponível
- **THEN** a API responde 409 e nenhum item da venda é baixado

#### Scenario: Vendas simultâneas além do estoque
- **WHEN** 20 vendas de 1 unidade chegam ao mesmo tempo para um produto com saldo 10
- **THEN** exatamente 10 são aceitas e o saldo termina em 0, nunca negativo

### Requirement: Teto de valor da venda
O sistema MUST recusar com 400, sem gravar nada, uma venda em que o subtotal de um item ou o total passe de R$ 5.000.000.

#### Scenario: Valor absurdo
- **WHEN** a soma dos itens ultrapassa R$ 5.000.000
- **THEN** a API responde 400 com `{ "error": "O valor da venda excede o limite permitido pelo sistema." }`

### Requirement: Histórico de vendas por perfil
`GET /api/sales` SHALL listar as vendas não canceladas da mais recente para a mais antiga, paginadas (`pageSize` padrão 20, máximo 100) e filtráveis por `from` e `to`. Um CASHIER MUST ver somente as próprias vendas; o ADMIN vê todas.

#### Scenario: Caixa consulta o histórico
- **WHEN** um CASHIER chama `GET /api/sales`
- **THEN** a resposta contém apenas vendas em que ele é o vendedor

### Requirement: Detalhe da venda
`GET /api/sales/{id}` SHALL devolver vendedor, data, total, status de cancelamento e itens. Um CASHIER MUST receber 403 ao pedir a venda de outro vendedor, e venda inexistente MUST receber 404.

#### Scenario: Caixa acessa venda alheia
- **WHEN** um CASHIER pede o detalhe de uma venda de outro vendedor
- **THEN** a API responde 403

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

### Requirement: Forma de pagamento
A venda SHALL aceitar `paymentMethod` igual a `CASH` (dinheiro, padrão quando omitido), `PIX`, `DEBIT_CARD` ou `CREDIT_CARD`, e a forma de pagamento MUST aparecer na resposta da venda, no histórico e no detalhe. Valor fora da lista MUST receber 400.

#### Scenario: Venda no Pix
- **WHEN** a venda é enviada com `paymentMethod: "PIX"`
- **THEN** ela fica registrada como Pix e não entra no dinheiro esperado do caixa

#### Scenario: Cliente sem forma de pagamento
- **WHEN** a venda é enviada sem `paymentMethod`
- **THEN** ela é registrada como `CASH`

### Requirement: Dados do estabelecimento para o recibo
`GET /api/settings` SHALL estar disponível a qualquer usuário autenticado e devolver `{ storeName }`, o nome do estabelecimento impresso no recibo da venda, lido da configuração `STORE_NAME` (padrão "Mercadinho"). Sem sessão MUST receber 401.

#### Scenario: Caixa abre o PDV
- **WHEN** um CASHIER autenticado pede `GET /api/settings`
- **THEN** recebe o `storeName` configurado no servidor

#### Scenario: Sem sessão
- **WHEN** a requisição chega sem o cookie de sessão
- **THEN** a API responde 401
