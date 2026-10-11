# api-platform Specification

## Purpose
Convenções transversais da API HTTP e do servidor do Contro Vend: formato de erros, proteção CSRF, limites de requisição e de corpo, cabeçalhos de segurança, entrega do frontend, configuração por ambiente e resiliência do processo. Vale para todas as rotas de `/api` descritas em `openspec/openapi.yaml`.

## Requirements

### Requirement: Formato padronizado de erros
A API SHALL responder erros como JSON `{ "error": "<mensagem em pt-BR>" }`. Falhas de validação MUST usar 400 com `details` (`formErrors` e `fieldErrors`). Erros internos MUST usar 500 com a mensagem genérica "Erro interno do servidor.", sem stack, SQL ou detalhes do banco. Caminhos sem rota nem arquivo estático MUST responder 404 `{ "error": "Não encontrado." }`.

#### Scenario: Corpo inválido
- **WHEN** um cliente envia um corpo que não passa na validação de uma rota
- **THEN** a API responde 400 com `error` igual a "Dados inválidos." e `details.fieldErrors` apontando os campos

#### Scenario: Erro inesperado
- **WHEN** uma falha não prevista acontece durante a requisição
- **THEN** a API responde 500 com `{ "error": "Erro interno do servidor." }`
- **AND** o erro completo é registrado somente no log do servidor

#### Scenario: Caminho inexistente
- **WHEN** um cliente faz `GET /api/nao-existe`
- **THEN** a API responde 404 com `{ "error": "Não encontrado." }`

### Requirement: Proteção CSRF por cabeçalho
Toda requisição para `/api` com método diferente de GET, HEAD ou OPTIONS MUST incluir o cabeçalho `X-Requested-With: fetch`; sem ele a API SHALL responder 403 `{ "error": "Requisição bloqueada." }` antes de qualquer outra verificação.

#### Scenario: Formulário forjado em outro site
- **WHEN** chega um POST com cookie de sessão válido mas sem `X-Requested-With: fetch`
- **THEN** a API responde 403 e nada é alterado

### Requirement: Limite geral de requisições por IP
A API SHALL limitar cada IP a `API_RATE_LIMIT_MAX` requisições por minuto em `/api` (padrão 300), respondendo 429 ao exceder. O IP do cliente MUST ser lido de `X-Forwarded-For` somente quando `TRUST_PROXY` for maior que 0.

#### Scenario: Excesso de requisições
- **WHEN** um mesmo IP passa de `API_RATE_LIMIT_MAX` requisições em um minuto
- **THEN** as requisições seguintes recebem 429 até a janela reiniciar

#### Scenario: Cabeçalho de proxy forjado
- **WHEN** `TRUST_PROXY` é 0 e o cliente envia um `X-Forwarded-For` diferente a cada requisição
- **THEN** o limite continua contando pelo IP real da conexão

### Requirement: Limite de tamanho do corpo
Corpos JSON MUST ser limitados a 100 kB, com resposta 413 ao exceder. As rotas de importação de planilha (`/api/imports/...`) SHALL aceitar até 4 MB em JSON e arquivos de até 5 MB.

#### Scenario: Corpo grande em rota comum
- **WHEN** um cliente envia 120 kB de JSON para `POST /api/products`
- **THEN** a API responde 413

### Requirement: Cabeçalhos de segurança e CORS
O servidor SHALL enviar Content-Security-Policy restrita à própria origem (scripts e estilos só de `'self'`, imagens de `'self'` e `data:`) e os demais cabeçalhos de proteção padrão, e MUST NOT enviar `X-Powered-By`. O CORS SHALL aceitar credenciais apenas da origem `CLIENT_ORIGIN`.

#### Scenario: Resposta com cabeçalhos de proteção
- **WHEN** qualquer página ou rota da API é requisitada
- **THEN** a resposta traz `Content-Security-Policy` com `script-src 'self'`
- **AND** não traz `X-Powered-By`

### Requirement: Frontend servido pela mesma origem
O servidor SHALL entregar a interface web estática na mesma origem da API: `/` (login), `/cadastro.html`, `/recuperar-senha.html`, `/reset-password.html` e `/app.html` (aplicação principal).

#### Scenario: Acesso à tela de login
- **WHEN** o navegador abre `/`
- **THEN** o servidor responde 200 com a página de login

### Requirement: Configuração segura por ambiente
A configuração SHALL vir de variáveis de ambiente (`.env`). Em produção (`NODE_ENV=production`) o servidor MUST recusar iniciar sem `JWT_SECRET` ou com o segredo padrão de desenvolvimento, e MUST marcar o cookie de sessão como Secure mesmo que `COOKIE_SECURE` diga o contrário. Valores numéricos inválidos SHALL cair no padrão documentado.

#### Scenario: Produção sem segredo
- **WHEN** o servidor inicia com `NODE_ENV=production` e sem `JWT_SECRET`
- **THEN** a inicialização falha com um erro que nomeia a variável ausente

#### Scenario: Janela de previsão inválida
- **WHEN** `FORECAST_WINDOW_DAYS=0` é configurado
- **THEN** o sistema usa o padrão de 30 dias em vez de dividir por zero

### Requirement: Resiliência do processo
Uma exceção síncrona não tratada MUST ser registrada e encerrar o processo de forma controlada, para o orquestrador reiniciar o serviço; uma promessa rejeitada sem tratamento SHALL apenas ser registrada. Em SIGTERM ou SIGINT o servidor SHALL parar de aceitar conexões e encerrar, forçando a saída após 10 segundos.

#### Scenario: Desligamento gracioso
- **WHEN** o processo recebe SIGTERM
- **THEN** o servidor fecha as conexões abertas e encerra com código 0
