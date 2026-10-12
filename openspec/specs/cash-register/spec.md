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
Toda venda MUST ficar ligada ao caixa aberto, com sua forma de pagamento. Sem caixa aberto a venda MUST receber 409 e nada é gravado, inclusive quando outro aparelho fechou o caixa enquanto a venda era montada.

#### Scenario: Venda com caixa aberto
- **WHEN** uma venda em dinheiro é registrada com o caixa aberto
- **THEN** o valor dela entra no dinheiro esperado daquele caixa

#### Scenario: Venda com o caixa fechado
- **WHEN** uma venda é enviada sem nenhum caixa aberto
- **THEN** a API responde 409, o estoque não muda e nenhuma venda é gravada

### Requirement: Caixa atual
`GET /api/cash-sessions/current` SHALL devolver o caixa aberto a qualquer usuário autenticado, ou 404 se não houver. Para ADMIN a resposta SHALL incluir o dinheiro esperado até o momento, os totais de venda por forma de pagamento, os totais de sangria e suprimento e a lista de movimentações; para CASHIER esses valores MUST ser omitidos.

#### Scenario: Consulta pelo administrador
- **WHEN** o ADMIN consulta o caixa aberto
- **THEN** vê o fundo de troco, o dinheiro esperado até agora, os totais por forma de pagamento e as sangrias e suprimentos com o motivo

#### Scenario: Consulta pelo caixa
- **WHEN** um CASHIER consulta o caixa aberto
- **THEN** vê quem abriu, quando e o fundo de troco, sem valores de venda nem movimentações

### Requirement: Fechamento com conciliação
`POST /api/cash-sessions/current/close` SHALL fechar o caixa aberto com o dinheiro contado (maior ou igual a zero) e observações opcionais. O esperado MUST ser o fundo de troco mais o total das vendas em dinheiro não canceladas do caixa, mais os suprimentos e menos as sangrias, e a diferença MUST ser o contado menos o esperado (positiva é sobra, negativa é falta). Esses valores SHALL ficar gravados no fechamento. Sem caixa aberto, a API MUST responder 404.

#### Scenario: Fechamento sem divergência
- **WHEN** o caixa abriu com R$ 100,00, vendeu R$ 50,00 em dinheiro e R$ 30,00 no Pix, e foram contados R$ 150,00
- **THEN** o esperado é R$ 150,00 e a diferença é 0

#### Scenario: Falta de dinheiro
- **WHEN** no mesmo caso foram contados R$ 140,00
- **THEN** a diferença é -10,00

#### Scenario: Sangria e suprimento no fechamento
- **WHEN** o caixa abriu com R$ 100,00, vendeu R$ 50,00 em dinheiro, teve sangria de R$ 60,00 e suprimento de R$ 20,00
- **THEN** o esperado gravado é R$ 110,00

#### Scenario: Venda cancelada antes do fechamento
- **WHEN** uma venda em dinheiro do caixa é cancelada antes de fechar
- **THEN** ela não entra no esperado

#### Scenario: Vendas simultâneas ao fechamento
- **WHEN** vendas acontecem no mesmo instante em que o caixa é fechado
- **THEN** cada venda ou entra no esperado gravado do caixa, ou é recusada com 409 por chegar depois do fechamento

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

### Requirement: Sangria e suprimento
`POST /api/cash-sessions/current/movements` SHALL registrar, no caixa aberto e para qualquer usuário autenticado, uma sangria (`WITHDRAWAL`, dinheiro que sai da gaveta) ou um suprimento (`DEPOSIT`, dinheiro que entra), com valor maior que zero, motivo obrigatório, quem registrou e quando. Sem motivo ou com valor zero MUST receber 400; sem caixa aberto MUST receber 404.

#### Scenario: Sangria para depósito
- **WHEN** o caixa registra uma sangria de R$ 50,00 com o motivo "Depósito no banco"
- **THEN** a API responde 201 e o dinheiro esperado do caixa diminui R$ 50,00

#### Scenario: Suprimento de troco
- **WHEN** é registrado um suprimento de R$ 20,00 com o motivo "Mais troco"
- **THEN** o dinheiro esperado do caixa aumenta R$ 20,00

#### Scenario: Sem motivo
- **WHEN** a sangria chega com o motivo vazio
- **THEN** a API responde 400 e nada é gravado
