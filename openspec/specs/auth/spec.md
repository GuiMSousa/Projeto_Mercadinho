# auth Specification

## Purpose
Autenticação e sessão dos usuários do Contro Vend: login por e-mail e senha, sessão em cookie revalidada a cada requisição, cadastro público de funcionário e recuperação de senha por link de uso único. Contrato HTTP: operações da tag `Auth` em `openspec/openapi.yaml`.

## Requirements

### Requirement: Login com e-mail e senha
O sistema SHALL autenticar pelo e-mail (sem diferenciar maiúsculas) e pela senha, comparada ao hash bcrypt armazenado. No sucesso MUST abrir a sessão no cookie `cv_token` (httpOnly, SameSite=Lax, Secure em produção, validade de 8 horas) com um JWT assinado em HS256, e responder `id`, `name`, `email` e `role`.

#### Scenario: Credenciais válidas
- **WHEN** um usuário ativo envia e-mail e senha corretos para `POST /api/auth/login`
- **THEN** a API responde 200 com os dados do usuário
- **AND** define o cookie `cv_token`

#### Scenario: E-mail desconhecido ou conta desativada
- **WHEN** o e-mail não existe ou pertence a uma conta desativada
- **THEN** a API responde 401 com `{ "error": "Login incorreto." }`

#### Scenario: Senha errada
- **WHEN** o e-mail existe mas a senha não confere
- **THEN** a API responde 401 com `{ "error": "Senha incorreta." }`

### Requirement: Limite de tentativas de login
O login MUST aceitar no máximo 10 tentativas por IP a cada 15 minutos; as tentativas seguintes SHALL receber 429 com uma mensagem pedindo para aguardar.

#### Scenario: Força bruta
- **WHEN** um IP faz a 11ª tentativa de login dentro de 15 minutos
- **THEN** a API responde 429 sem verificar a senha

### Requirement: Sessão revalidada a cada requisição
Toda rota autenticada MUST verificar a assinatura do token aceitando somente HS256 e MUST consultar o banco para confirmar que o usuário existe, está ativo e que a versão de sessão do token é a atual. O papel usado na autorização SHALL ser o do banco, não o do token. Qualquer falha MUST resultar em 401.

#### Scenario: Funcionário desativado com token ainda válido
- **WHEN** o administrador desativa um usuário que tem sessão aberta
- **THEN** a próxima requisição desse usuário recebe 401

#### Scenario: Token adulterado
- **WHEN** um cliente envia um token com assinatura inválida ou com algoritmo `none`
- **THEN** a API responde 401 com `{ "error": "Sessão inválida ou expirada." }`

#### Scenario: Senha trocada
- **WHEN** a senha de um usuário é trocada por qualquer caminho (link de recuperação, administrador ou script de emergência)
- **THEN** os tokens emitidos antes da troca passam a receber 401

### Requirement: Sessão atual e logout
`GET /api/auth/me` SHALL devolver `id`, `name`, `email`, `role` e `active` do usuário da sessão, ou 401 sem sessão válida. `POST /api/auth/logout` SHALL apagar o cookie de sessão e responder `{ "ok": true }`.

#### Scenario: Consulta da sessão
- **WHEN** um usuário logado chama `GET /api/auth/me`
- **THEN** a API responde 200 com os dados dele

#### Scenario: Logout
- **WHEN** o usuário chama `POST /api/auth/logout`
- **THEN** o cookie `cv_token` é removido e a resposta é `{ "ok": true }`

### Requirement: Cadastro público de funcionário
`POST /api/auth/register` SHALL criar uma conta com nome (1 a 120 caracteres), e-mail único e senha de ao menos 8 caracteres, sempre com papel CASHIER e ativa, e MUST abrir a sessão na mesma resposta (201). Campos além de nome, e-mail e senha MUST ser rejeitados com 400. Cada IP SHALL poder se cadastrar no máximo 5 vezes por hora.

#### Scenario: Cadastro bem-sucedido
- **WHEN** um visitante envia nome, e-mail novo e senha válida
- **THEN** a API responde 201 com papel `CASHIER` e define o cookie de sessão

#### Scenario: Tentativa de se cadastrar como administrador
- **WHEN** o corpo inclui `role: "ADMIN"`
- **THEN** a API responde 400 e nenhuma conta é criada

#### Scenario: E-mail já cadastrado
- **WHEN** o e-mail já pertence a outro usuário
- **THEN** a API responde 409

### Requirement: Solicitação de recuperação de senha
`POST /api/auth/forgot-password` MUST responder sempre a mesma mensagem genérica, exista ou não o e-mail. Para uma conta ativa SHALL gerar um token aleatório de 256 bits, guardado só como hash SHA-256, válido por `PASSWORD_RESET_EXPIRES_MIN` minutos (padrão 30), invalidando os tokens pendentes anteriores. Cada IP SHALL poder pedir no máximo 5 vezes a cada 15 minutos.

#### Scenario: E-mail desconhecido
- **WHEN** alguém pede recuperação para um e-mail que não existe
- **THEN** a API responde 200 com a mesma mensagem genérica de um e-mail existente

#### Scenario: Novo pedido invalida o anterior
- **WHEN** o usuário pede a recuperação duas vezes
- **THEN** apenas o link mais recente continua válido

### Requirement: Entrega do link de recuperação
O link de recuperação SHALL ser registrado no log do servidor para o dono repassá-lo ao funcionário. Em produção o link MUST NOT ser devolvido na resposta da API, pois isso deixaria qualquer pessoa que saiba um e-mail assumir a conta. Fora de produção SHALL ser devolvido no campo `resetUrl`, e a tela de recuperação leva direto à troca de senha.

#### Scenario: Pedido em produção
- **WHEN** `NODE_ENV=production` e alguém pede a recuperação do e-mail do administrador
- **THEN** a resposta contém só a mensagem genérica, sem `resetUrl`
- **AND** o link aparece apenas no log do servidor

#### Scenario: Pedido em desenvolvimento
- **WHEN** `NODE_ENV` não é `production`
- **THEN** a resposta inclui `resetUrl` apontando para `/reset-password.html?token=...`

### Requirement: Redefinição de senha com token de uso único
`POST /api/auth/reset-password` SHALL aceitar um token não usado e não expirado e uma nova senha de ao menos 8 caracteres, trocar a senha, consumir o token e invalidar as sessões e os demais tokens do usuário. O token MUST funcionar uma única vez, mesmo com requisições simultâneas, e token inválido, expirado ou usado MUST receber 400. Limite: 10 tentativas por IP a cada 15 minutos.

#### Scenario: Reset bem-sucedido
- **WHEN** o usuário envia um token válido e uma nova senha
- **THEN** a API responde 200 e o login passa a funcionar só com a nova senha

#### Scenario: Reuso do link
- **WHEN** o mesmo token é enviado uma segunda vez
- **THEN** a API responde 400 com `{ "error": "Link de recuperação inválido, expirado ou já utilizado." }`
