# cash-register Specification

## Purpose
Controle do caixa físico da loja: abertura com fundo de troco, vendas registradas no caixa aberto com a forma de pagamento e fechamento que compara o dinheiro contado com o esperado, apontando sobra ou falta.

## Requirements

### Requirement: Abertura de caixa
`POST /api/cash-sessions` SHALL abrir o caixa da loja para qualquer usuário autenticado, registrando o fundo de troco (maior ou igual a zero), quem abriu e quando. Só pode haver um caixa aberto por vez: abrir com outro já aberto MUST receber 409, inclusive com aberturas simultâneas.

#### Scenario: Início do dia
- **WHEN** o funcionário abre o caixa com R$ 100,00 de fundo de troco
- **THEN** a API responde 201 com o caixa aberto

#### Scenario: Caixa já aberto
- **WHEN** alguém tenta abrir um caixa com outro ainda aberto
- **THEN** a API responde 409

### Requirement: Vendas entram no caixa aberto
Toda venda registrada com um caixa aberto MUST ficar ligada a ele, com sua forma de pagamento. Uma venda feita sem caixa aberto SHALL ser aceita, mas fica fora de qualquer conciliação.

#### Scenario: Venda com caixa aberto
- **WHEN** uma venda em dinheiro é registrada com o caixa aberto
- **THEN** o valor dela entra no dinheiro esperado daquele caixa

#### Scenario: Venda com o caixa fechado
- **WHEN** uma venda é registrada sem nenhum caixa aberto
- **THEN** a venda é aceita e não entra em nenhum fechamento

### Requirement: Caixa atual
`GET /api/cash-sessions/current` SHALL devolver o caixa aberto a qualquer usuário autenticado, ou 404 se não houver. Para ADMIN a resposta SHALL incluir o dinheiro esperado até o momento e os totais de venda por forma de pagamento; para CASHIER esses valores MUST ser omitidos.

#### Scenario: Consulta pelo administrador
- **WHEN** o ADMIN consulta o caixa aberto
- **THEN** vê o fundo de troco, o dinheiro esperado até agora e os totais por forma de pagamento

#### Scenario: Consulta pelo caixa
- **WHEN** um CASHIER consulta o caixa aberto
- **THEN** vê quem abriu, quando e o fundo de troco, sem valores de venda

### Requirement: Fechamento com conciliação
`POST /api/cash-sessions/current/close` SHALL fechar o caixa aberto com o dinheiro contado (maior ou igual a zero) e observações opcionais. O esperado MUST ser o fundo de troco mais o total das vendas em dinheiro não canceladas do caixa, e a diferença MUST ser o contado menos o esperado (positiva é sobra, negativa é falta). Esses valores SHALL ficar gravados no fechamento. Sem caixa aberto, a API MUST responder 404.

#### Scenario: Fechamento sem divergência
- **WHEN** o caixa abriu com R$ 100,00, vendeu R$ 50,00 em dinheiro e R$ 30,00 no Pix, e foram contados R$ 150,00
- **THEN** o esperado é R$ 150,00 e a diferença é 0

#### Scenario: Falta de dinheiro
- **WHEN** no mesmo caso foram contados R$ 140,00
- **THEN** a diferença é -10,00

#### Scenario: Venda cancelada antes do fechamento
- **WHEN** uma venda em dinheiro do caixa é cancelada antes de fechar
- **THEN** ela não entra no esperado

#### Scenario: Vendas simultâneas ao fechamento
- **WHEN** vendas acontecem no mesmo instante em que o caixa é fechado
- **THEN** toda venda ligada ao caixa está somada no esperado gravado

### Requirement: Fechamento cego para o caixa
Quando quem fecha é CASHIER, a resposta MUST trazer só o que ele informou (dinheiro contado e observações), sem esperado, diferença ou totais; o ADMIN SHALL receber a conciliação completa. Isso mantém a regra de que o funcionário não vê números financeiros.

#### Scenario: Funcionário fecha o caixa
- **WHEN** um CASHIER fecha o caixa
- **THEN** a resposta não contém `expectedAmount` nem `difference`

### Requirement: Histórico de caixas
`GET /api/cash-sessions` (ADMIN) SHALL listar os caixas do mais recente para o mais antigo, paginados e filtráveis por `from`/`to` na data de abertura, e `GET /api/cash-sessions/{id}` (ADMIN) SHALL detalhar um caixa com fundo, contado, esperado, diferença e totais por forma de pagamento. CASHIER MUST receber 403.

#### Scenario: Conferência do mês
- **WHEN** o ADMIN lista os caixas do mês
- **THEN** vê cada fechamento com a diferença apontada

#### Scenario: Caixa tenta ver o histórico
- **WHEN** um CASHIER chama `GET /api/cash-sessions`
- **THEN** a API responde 403
