# dashboard Specification

## Purpose
Painel inicial exibido após o login: concentra os alertas de reposição e de validade para todos os perfis e, só para o administrador, os números financeiros do dia e do mês e os produtos parados. Contrato HTTP: `GET /api/dashboard` (tag `Dashboard`) em `openspec/openapi.yaml`.

## Requirements

### Requirement: Alertas de estoque e validade
`GET /api/dashboard` SHALL devolver a qualquer usuário autenticado: `lowStock` (produtos ativos com saldo menor ou igual ao mínimo), `soonOut` (produtos acima do mínimo com previsão de esgotar em até 7 dias) e `expiring` (produtos ativos com validade até hoje mais `EXPIRY_ALERT_DAYS` dias, incluindo os já vencidos, ordenados pela validade).

#### Scenario: Produto abaixo do mínimo
- **WHEN** um produto ativo tem saldo 3 e mínimo 10
- **THEN** ele aparece em `lowStock` e não em `soonOut`

#### Scenario: Produto vencendo
- **WHEN** a validade de um produto ativo cai dentro dos próximos `EXPIRY_ALERT_DAYS` dias
- **THEN** ele aparece em `expiring` com a data de validade e o saldo

### Requirement: Indicadores financeiros só para o administrador
Para ADMIN a resposta SHALL incluir `today` e `month` (total e quantidade de vendas não canceladas desde 00:00 do dia e desde o dia 1 do mês, no fuso do servidor) e `slowMoving` (produtos parados há 60 dias). Para CASHIER esses campos MUST ser omitidos.

#### Scenario: Painel do caixa
- **WHEN** um CASHIER abre o painel
- **THEN** a resposta não contém `today`, `month` nem `slowMoving`

#### Scenario: Painel do administrador
- **WHEN** o ADMIN abre o painel
- **THEN** a resposta inclui o total vendido hoje e no mês e a lista de produtos parados
