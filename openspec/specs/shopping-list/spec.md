# shopping-list Specification

## Purpose
Lista de compras gerada automaticamente a partir do estoque mínimo de cada produto, para o dono repor antes de faltar e mandar o pedido ao fornecedor pelo WhatsApp.

## Requirements

### Requirement: Lista de compras automática
`GET /api/shopping-list` SHALL estar disponível a qualquer usuário autenticado e listar todos os produtos ativos com saldo menor ou igual ao estoque mínimo, ordenados por categoria e nome, com unidade, saldo, mínimo, média diária de vendas e previsão de dias até esgotar. A lista MUST NOT trazer preço de custo.

#### Scenario: Produto no mínimo
- **WHEN** um produto ativo tem saldo 10 e mínimo 10
- **THEN** ele aparece na lista de compras

#### Scenario: Produto acima do mínimo ou desativado
- **WHEN** um produto tem saldo maior que o mínimo ou está desativado
- **THEN** ele não aparece na lista

### Requirement: Lista em texto para WhatsApp
Com `format=text`, a mesma lista SHALL ser devolvida como texto puro em pt-BR, com a data, os produtos agrupados por categoria e uma linha por produto com saldo e mínimo, pronta para colar no WhatsApp. Sem produtos a repor, o texto MUST dizer que não há nada para comprar. Outro valor de `format` MUST receber 400.

#### Scenario: Envio ao fornecedor
- **WHEN** o dono pede `GET /api/shopping-list?format=text`
- **THEN** recebe `text/plain` com uma linha por produto a repor, agrupada por categoria

#### Scenario: Nada para repor
- **WHEN** nenhum produto ativo está no mínimo ou abaixo dele
- **THEN** o texto informa que não há nada para comprar
