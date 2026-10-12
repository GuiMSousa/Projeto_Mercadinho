# Delta for sales

## ADDED Requirements

### Requirement: Dados do estabelecimento para o recibo
`GET /api/settings` SHALL estar disponível a qualquer usuário autenticado e devolver `{ storeName }`, o nome do estabelecimento impresso no recibo da venda, lido da configuração `STORE_NAME` (padrão "Mercadinho"). Sem sessão MUST receber 401.

#### Scenario: Caixa abre o PDV
- **WHEN** um CASHIER autenticado pede `GET /api/settings`
- **THEN** recebe o `storeName` configurado no servidor

#### Scenario: Sem sessão
- **WHEN** a requisição chega sem o cookie de sessão
- **THEN** a API responde 401

## MODIFIED Requirements

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
