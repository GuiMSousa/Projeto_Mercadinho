# users Specification

## Purpose
Gestão das contas do sistema pelo administrador (o dono): listar, cadastrar funcionários, editar nome, ativar ou desativar e redefinir senha. O sistema tem um único administrador; toda outra conta é de caixa. Contrato HTTP: operações da tag `Users` em `openspec/openapi.yaml`.

## Requirements

### Requirement: Acesso exclusivo do administrador
Todas as rotas de `/api/users` MUST exigir sessão de ADMIN: sem sessão a resposta SHALL ser 401 e para CASHIER SHALL ser 403.

#### Scenario: Caixa tenta listar usuários
- **WHEN** um usuário CASHIER chama `GET /api/users`
- **THEN** a API responde 403

### Requirement: Listagem de usuários
`GET /api/users` SHALL listar todas as contas, ativas e desativadas, em ordem alfabética de nome, com `id`, `name`, `email`, `role`, `active` e `createdAt`. O hash da senha MUST NOT aparecer em nenhuma resposta.

#### Scenario: Listagem pelo administrador
- **WHEN** o administrador chama `GET /api/users`
- **THEN** recebe todas as contas ordenadas por nome, sem nenhum campo de senha

### Requirement: Cadastro de funcionário
`POST /api/users` SHALL criar contas sempre com papel CASHIER, com nome de 1 a 120 caracteres, e-mail guardado em minúsculas e único, e senha de ao menos 8 caracteres. E-mail repetido MUST receber 409.

#### Scenario: Novo caixa
- **WHEN** o administrador cadastra nome, e-mail e senha válidos
- **THEN** a API responde 201 com a conta criada como `CASHIER` e ativa

#### Scenario: E-mail duplicado
- **WHEN** o e-mail já existe, em qualquer combinação de maiúsculas e minúsculas
- **THEN** a API responde 409

### Requirement: Edição de usuário
`PUT /api/users/{id}` SHALL permitir alterar nome, status ativo e senha. O papel MUST NOT ser alterável por esta rota (o campo é ignorado). Trocar a senha MUST invalidar as sessões abertas daquele usuário. O administrador MUST NOT conseguir desativar a própria conta (400), e usuário inexistente SHALL receber 404.

#### Scenario: Administrador tenta se desativar
- **WHEN** o administrador envia `active: false` para o próprio id
- **THEN** a API responde 400 com `{ "error": "Você não pode desativar seu próprio usuário." }`

#### Scenario: Tentativa de promover um caixa
- **WHEN** o corpo inclui `role: "ADMIN"`
- **THEN** o papel do usuário continua `CASHIER`

#### Scenario: Desativação de funcionário
- **WHEN** o administrador desativa um caixa
- **THEN** o caixa perde o acesso na próxima requisição, mesmo com sessão aberta
