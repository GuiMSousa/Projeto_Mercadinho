# Delta for products

## MODIFIED Requirements

### Requirement: Consulta do catálogo
`GET /api/products` SHALL estar disponível a qualquer usuário autenticado e listar os produtos ativos em ordem alfabética, com filtros opcionais `query` (trecho do nome, sem diferenciar maiúsculas, ou o código de barras exato), `category` (valor exato) e `lowStock=true` (saldo menor ou igual ao mínimo). `includeInactive=true` SHALL incluir os desativados somente para ADMIN.

#### Scenario: Busca por nome
- **WHEN** um caixa busca `query=arroz`
- **THEN** recebe os produtos ativos cujo nome contém "arroz", em qualquer combinação de maiúsculas

#### Scenario: Busca por código de barras
- **WHEN** o leitor do balcão envia `query=7891234567895`
- **THEN** recebe o produto ativo cujo código de barras é exatamente esse, e um trecho do código não basta

#### Scenario: Caixa pede produtos desativados
- **WHEN** um CASHIER envia `includeInactive=true`
- **THEN** a resposta contém apenas produtos ativos
