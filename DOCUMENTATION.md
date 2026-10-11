# Contro Vend — Documentação Técnica

Documentação de referência do projeto: o problema que ele resolve, o que foi usado para construí-lo, como as peças se encaixam, e o que cada funcionalidade faz. Para instruções de instalação/deploy do dia a dia, veja o [README.md](README.md); para o histórico completo da auditoria de segurança, veja a seção específica lá.

## Índice

1. [Visão geral e contexto](#1-visão-geral-e-contexto)
2. [Funcionalidades](#2-funcionalidades)
3. [Stack tecnológica](#3-stack-tecnológica)
4. [Arquitetura](#4-arquitetura)
5. [Modelo de dados](#5-modelo-de-dados)
6. [Perfis de acesso](#6-perfis-de-acesso)
7. [Estrutura de pastas](#7-estrutura-de-pastas)
8. [Scripts disponíveis](#8-scripts-disponíveis)
9. [Segurança (resumo)](#9-segurança-resumo)
10. [Testes](#10-testes)
11. [Especificação OpenSpec e contrato da API](#11-especificação-openspec-e-contrato-da-api)

---

## 1. Visão geral e contexto

O Contro Vend foi criado para um cliente real: um pequeno comerciante dono de um mercadinho de secos e molhados, que enfrentava quatro problemas concretos:

- **Perda de controle do estoque** — sem saber ao certo o que tinha ou não em loja.
- **Compra excessiva** de produtos que ficavam parados, prendendo capital de giro (baixo, no caso de um pequeno comércio).
- **Produtos vencidos ou estragados**, por falta de aviso antecipado de validade.
- **Falta de produtos de alta demanda**, por não saber quando um item ia esgotar.

O sistema não precisa ser instalado na máquina do cliente — é uma aplicação web acessível de qualquer navegador, hospedável em qualquer provedor de nuvem com PostgreSQL.

## 2. Funcionalidades

### 2.1 Vendas (ponto de venda)

- Busca de produto por nome ou código de barras, com resultado instantâneo (busca com debounce de 250ms).
- Carrinho de venda: adicionar itens, ajustar quantidade, remover, ver subtotal/total em tempo real.
- Confirmar venda: dá baixa automática no estoque de cada item, dentro de uma única transação — ou a venda inteira é registrada, ou nada é (nunca fica pela metade).
- Histórico de vendas recentes, com vendedor, data/hora, itens e total.
- Cancelamento de venda (admin): devolve o estoque de cada item vendido, mesmo que o produto tenha sido descontinuado depois da venda.

### 2.2 Estoque

- Cadastro de produtos: nome, categoria, código de barras (opcional), unidade, preço de custo, preço de venda, estoque mínimo, estoque inicial e a validade desse estoque inicial (opcional).
- **Lotes**: o saldo de cada produto é a soma dos seus lotes (quantidade recebida, saldo restante, validade opcional, data de entrada). A validade exibida do produto é a mais próxima entre os lotes com saldo.
- Entrada de mercadoria (registro de compra): cria um lote com a quantidade e a validade informadas, com motivo opcional.
- Ajuste/perda (produto vencido, quebra, etc.): soma ou subtrai do estoque, com motivo obrigatório; pode mirar um lote específico, e um ajuste positivo cria um lote novo.
- **Baixa por PVPS** (Primeiro que Vence, Primeiro que Sai): a venda leva primeiro o lote válido que vence antes (lotes sem validade por último); vencidos só se não houver lote válido. Perdas e ajustes sem lote indicado baixam primeiro os vencidos — assim o "Vencido" lançado na tela zera o lote certo. Cancelar uma venda devolve cada unidade ao lote de onde saiu.
- Correção da validade de um lote digitado errado, sem mexer no saldo. Pela tela de produto, a validade só muda quando não há ambiguidade (todos os lotes com saldo têm a mesma validade).
- Histórico de movimentações: toda mudança de estoque (venda, entrada, ajuste, perda, cancelamento) fica registrada com data, usuário responsável, quantidade e saldo resultante — uma trilha de auditoria completa e imutável (não existe rota para editar ou apagar uma movimentação já registrada).
- Desativação e reativação de produto: um produto "removido" nunca é apagado do banco (preserva o histórico de vendas ligado a ele) — só marcado como inativo, e pode ser reativado a qualquer momento.

### 2.3 Previsão de esgotamento de estoque

Para cada produto, o sistema calcula a média de vendas diárias dos últimos 30 dias (janela configurável) e projeta em quantos dias o estoque atual vai zerar nesse ritmo. O Painel destaca os produtos com previsão de esgotar em até 7 dias que ainda não estão abaixo do mínimo cadastrado — um alerta antecipado, antes que vire falta de estoque.

### 2.4 Produtos parados

Lista produtos que têm estoque em mãos mas não tiveram nenhuma venda registrada nos últimos 60 dias (nos relatórios, essa janela é configurável). Mostra também o "capital parado" — quanto dinheiro está imobilizado nesse estoque parado (estoque × preço de custo) — ajudando a decidir o que promover ou parar de comprar.

### 2.5 Alertas de validade

Produtos com data de validade cadastrada que estejam a poucos dias de vencer (configurável, padrão 7 dias) aparecem destacados no Painel.

**Semáforo de urgência**: toda resposta de produto traz uma cor e os motivos — **vermelho** para estoque zerado, vencido ou vencendo em até 7 dias; **amarelo** para estoque menor ou igual ao mínimo ou vencendo em 8 a 30 dias; **verde** para o resto. A listagem de produtos filtra por cor (`?urgency=RED|YELLOW|GREEN`), e a consulta de lotes mostra a cor de cada lote. "Dias para vencer" segue o calendário da loja (variável `TZ`).

### 2.6 Alerta diário por e-mail (opcional)

Se um servidor SMTP for configurado, o sistema envia automaticamente, uma vez por dia num horário configurável, um e-mail resumindo: produtos abaixo do estoque mínimo, produtos com previsão de esgotar em breve, e produtos perto do vencimento. O e-mail é sempre enviado por conexão criptografada (TLS obrigatório) e em texto puro (nunca HTML).

### 2.7 Relatórios (administrador)

- **Resumo de vendas**: total vendido e número de vendas num período, com detalhamento por dia.
- **Mais vendidos**: ranking de produtos por quantidade vendida e receita gerada, num período.
- **Produtos parados**: mesma lógica do Painel, com janela de dias configurável.
- **Previsão de esgotamento**: a lista completa (não só os mais urgentes) de todos os produtos com sua previsão.

### 2.8 Painel (dashboard)

Primeira tela ao entrar no sistema — resume, num único lugar: estoque abaixo do mínimo, previsão de esgotar em 7 dias, produtos vencendo em breve, e (só para admin) vendas do dia/mês e produtos parados.

### 2.8.1 Lista de compras

`GET /api/shopping-list` lista os produtos ativos com estoque menor ou igual ao mínimo, por categoria e nome, com saldo, mínimo, média diária de vendas e previsão de dias até esgotar. Com `?format=text`, devolve um texto pronto para colar no WhatsApp do fornecedor. Disponível para todos os perfis e sem preço de custo.

### 2.8.2 Caixa (abertura, fechamento e conciliação)

- **Abertura**: qualquer usuário abre o caixa da loja informando o fundo de troco; só existe um caixa aberto por vez.
- **Vendas**: toda venda feita com o caixa aberto fica ligada a ele, com a forma de pagamento (dinheiro, Pix, débito, crédito). Venda com o caixa fechado é aceita, mas fica fora da conciliação.
- **Fechamento**: quem fecha informa o dinheiro contado. O esperado é o fundo de troco mais as vendas em dinheiro não canceladas daquele caixa; a diferença (contado − esperado) mostra sobra ou falta. Os valores ficam gravados — um cancelamento posterior não reescreve o fechamento.
- **Fechamento cego**: quando é o funcionário que fecha, ele não vê esperado nem diferença (mantém a regra de que o caixa não vê números financeiros). O administrador vê a conciliação completa, os totais por forma de pagamento e o histórico de caixas.
- **Sem corrida**: vendas que estão gravando no instante do fechamento entram no esperado — o fechamento espera elas terminarem.

### 2.9 Gestão de usuários (administrador)

O sistema tem um único administrador (o dono); toda outra conta é funcionário (caixa), seja criada pelo administrador ou pelo auto-cadastro na tela de login — o perfil não é escolhido nem editável. O administrador cadastra novos usuários (nome, e-mail, senha), edita nome/status ativo e redefine a senha de outro usuário. Ele não pode se autodesativar (trava contra ficar acidentalmente trancado fora do próprio sistema).

## 3. Stack tecnológica

### Backend

| Tecnologia | Papel | Por quê |
|---|---|---|
| **Node.js + Express** | Servidor HTTP e roteamento da API | Maduro, simples, sem necessidade de build step — roda o mesmo código em dev e produção |
| **PostgreSQL** | Banco de dados relacional | Robusto, suporta transações ACID (essencial para nunca vender com estoque incorreto), gratuito em vários provedores de nuvem |
| **Prisma ORM** | Acesso ao banco de dados | Todas as consultas são parametrizadas por construção (elimina SQL injection na raiz), migrations versionadas, tipagem |
| **jsonwebtoken + bcryptjs** | Autenticação | JWT para sessão sem estado no servidor; bcrypt (12 rounds) para nunca guardar senha em texto puro |
| **Zod** | Validação de entrada | Todo corpo de requisição é validado contra um schema explícito antes de tocar no banco |
| **Helmet** | Cabeçalhos de segurança HTTP | CSP, HSTS, X-Frame-Options, X-Content-Type-Options, entre outros, num só pacote |
| **express-rate-limit** | Limite de requisições | Protege contra força bruta no login e abuso geral da API |
| **cors, cookie-parser** | Suporte HTTP | CORS restrito à origem configurada; leitura do cookie de sessão |
| **Nodemailer** | Envio de e-mail | Alerta diário de estoque, com TLS obrigatório |
| **node-cron** | Agendamento | Dispara o alerta diário no horário configurado |
| **node:test** (nativo do Node.js) | Testes automatizados | Suíte de integração sem adicionar nenhuma dependência nova ao projeto |

### Frontend

HTML, CSS e JavaScript puros (vanilla) — sem framework (React/Vue/etc.) e sem etapa de build. Cada tela é um `<template>` HTML clonado e populado via DOM API (nunca `innerHTML` com dado do servidor, o que elimina XSS por injeção de HTML). Essa escolha mantém o projeto simples de rodar (não precisa de bundler, webpack, etc.) e fácil de hospedar em qualquer lugar que sirva arquivos estáticos + Node.

### Ferramentas de desenvolvimento/operação

- **Docker** — usado durante o desenvolvimento para subir um PostgreSQL descartável em cada rodada de teste manual/automatizado; não é uma dependência de produção (qualquer PostgreSQL gerenciado serve).
- **GitHub CLI (`gh`)** — usado para criar e sincronizar o repositório remoto.
- **Git** — controle de versão.
- **OpenSpec CLI** (`@fission-ai/openspec`) e **Redocly CLI** — validação das specs e do `openapi.yaml`, chamadas via `npx` com versão fixa pelos scripts `spec:*` (não entram em `node_modules` nem na imagem Docker).

## 4. Arquitetura

### 4.1 Visão geral do fluxo

```
Navegador (HTML/CSS/JS puro)
        │  fetch() com cookie httpOnly + header X-Requested-With
        ▼
Express (src/app.js)
  ├─ helmet, cors, rate limit, CSRF leve (X-Requested-With)
  ├─ authenticate (revalida usuário no banco a cada requisição)
  ├─ authorize('ADMIN') (por rota, quando aplicável)
  └─ rotas (src/routes/*.js)
        │  Prisma (parâmetros tipados, nunca string concatenada)
        ▼
    PostgreSQL
```

### 4.2 Autenticação e sessão

1. Login: `POST /api/auth/login` verifica e-mail/senha (bcrypt), emite um JWT assinado (`HS256` explícito) e o grava num cookie `httpOnly` + `SameSite=Lax` (+ `Secure` em produção).
2. A cada requisição autenticada, o middleware `authenticate` (`src/middleware/auth.js`) verifica a assinatura do token **e** consulta o banco para confirmar que o usuário ainda está ativo e qual é o papel atual dele — uma mudança de status (demissão, rebaixamento) tem efeito imediato, mesmo que o token ainda não tenha expirado (validade de 8h).
3. Autorização por papel: `authorize('ADMIN')` bloqueia rotas administrativas para quem não é admin, checado no servidor em toda requisição (não é só uma questão de esconder botão na tela).

### 4.3 Fluxo de uma venda

1. Cliente envia a lista de itens (`productId` + `quantidade`) — nunca preço, nunca vendedor: esses vêm sempre do banco/sessão, nunca do cliente.
2. Servidor abre uma transação de banco.
3. Para cada item: um `UPDATE` condicional atômico (`WHERE estoque >= quantidade`) desconta o estoque — se não houver saldo suficiente, a transação inteira é desfeita e a venda é rejeitada (409).
4. Cada item vira um registro em `SaleItem` (com o preço no momento da venda) e um registro em `StockMovement` (tipo `SALE`, para a trilha de auditoria).
5. O total da venda é a soma de todos os subtotais, calculado no servidor.

Esse padrão (`UPDATE` condicional atômico em vez de "ler o estoque, calcular em código, escrever de volta") é o que garante que duas vendas simultâneas do mesmo produto nunca resultem em estoque negativo — validado com testes reais de concorrência (ver seção de testes).

### 4.4 Previsão de estoque

`src/services/forecast.js` calcula, para cada produto ativo, a soma de tudo que foi vendido (`StockMovement` do tipo `SALE` de vendas não canceladas) nos últimos N dias, divide pelo número de dias para obter a média diária, e projeta `estoque_atual / média_diária` para estimar os dias restantes. É uma previsão simples e transparente (sem machine learning), fácil de entender e confiar por quem não é técnico.

## 5. Modelo de dados

Entidades principais (definidas em [prisma/schema.prisma](prisma/schema.prisma)):

- **User** — usuários do sistema (`ADMIN` ou `CASHIER`), com senha em hash.
- **Product** — produtos do catálogo, com preço de custo/venda, estoque atual (soma dos lotes), estoque mínimo, validade (a mais próxima entre os lotes com saldo, mantida automaticamente) e status ativo/inativo.
- **StockBatch** — lote de mercadoria: quantidade recebida, saldo restante, validade opcional e data de entrada.
- **Sale** — uma venda, ligada ao vendedor (`User`) e ao caixa aberto (`CashSession`, quando houver), com total, forma de pagamento e status de cancelamento.
- **SaleItem** — cada item de uma venda (produto, quantidade, preço no momento da venda, subtotal).
- **StockMovement** — toda movimentação de estoque (entrada, venda, ajuste, perda), com saldo anterior/posterior, motivo e responsável — a trilha de auditoria completa do estoque.
- **StockMovementBatch** — quanto cada movimentação alterou em cada lote (é o que permite o cancelamento devolver ao lote de origem).
- **CashSession** — um caixa: fundo de troco, quem abriu/fechou e quando, dinheiro contado e esperado gravados no fechamento.

Todos os valores monetários e de quantidade usam o tipo `Decimal` do PostgreSQL (nunca ponto flutuante), evitando erros de arredondamento em dinheiro.

## 6. Perfis de acesso

| Recurso | Administrador | Caixa (funcionário) |
|---|---|---|
| Registrar venda | ✅ | ✅ |
| Ver histórico de vendas (só as próprias) | ✅ (todas) | ✅ (só as suas) |
| Cancelar venda | ✅ | ❌ |
| Ver produtos (nome, estoque, preço de venda) | ✅ | ✅ |
| Ver preço de custo e margem | ✅ | ❌ (nunca enviado pela API) |
| Cadastrar/editar/desativar/reativar produto | ✅ | ❌ |
| Entrada de estoque / ajustes / perdas | ✅ | ❌ |
| Consultar lotes e corrigir validade de lote | ✅ | ❌ |
| Semáforo de urgência dos produtos | ✅ | ✅ |
| Lista de compras | ✅ | ✅ (sem preço de custo para ninguém) |
| Abrir e fechar o caixa | ✅ | ✅ (fechamento cego: não vê esperado nem diferença) |
| Conciliação, totais por forma de pagamento e histórico de caixas | ✅ | ❌ |
| Relatórios | ✅ | ❌ |
| Gestão de usuários | ✅ | ❌ |
| Painel (Vendas hoje/mês, produtos parados) | ✅ | ❌ (vê só os alertas de estoque/validade) |

## 7. Estrutura de pastas

```
contro_vend/
├── openspec/                  # especificação (ver seção 11)
│   ├── config.yaml            # contexto do projeto para o OpenSpec
│   ├── openapi.yaml           # contrato HTTP (OpenAPI 3.1)
│   ├── specs/<capacidade>/spec.md  # requisitos e cenários de cada área
│   └── changes/               # propostas de mudança (e archive/)
├── prisma/
│   ├── schema.prisma          # modelo de dados
│   ├── migrations/            # histórico de migrations do banco
│   ├── seed.js                # cria o primeiro usuário administrador
│   ├── seedProducts.js        # carga de ~24 produtos de exemplo
│   ├── simulateSales.js       # histórico de vendas de exemplo (14 dias)
│   └── resetPassword.js       # script de recuperação de senha de emergência
├── src/
│   ├── app.js                 # configuração do Express (middlewares, montagem das rotas)
│   ├── server.js              # ponto de entrada (sobe o servidor + cron)
│   ├── config.js              # leitura/validação de variáveis de ambiente
│   ├── db.js                  # cliente Prisma compartilhado
│   ├── middleware/
│   │   ├── auth.js            # sessão JWT, hash de senha, authenticate/authorize, CSRF
│   │   └── validate.js        # validação de corpo com Zod
│   ├── lib/
│   │   ├── httpError.js       # erro HTTP com status
│   │   ├── calendar.js        # datas AAAA-MM-DD, "hoje" no calendário da loja, dias até a validade
│   │   └── queryHelpers.js    # validação de parâmetros de busca (datas, enums, paginação)
│   ├── services/              # regras de negócio, sem Express
│   │   ├── forecast.js        # previsão de esgotamento, produtos parados
│   │   ├── stockOps.js        # moveStock: saldo atômico, lotes, PVPS e trilha por lote
│   │   ├── urgency.js         # semáforo (vermelho, amarelo, verde) de produtos e lotes
│   │   ├── spreadsheet.js     # leitura de .xlsx/.csv/texto colado
│   │   └── productImport.js   # mapeamento de colunas e conversão de valores
│   ├── routes/                # um roteador por capacidade (auth, products, stock, sales, dashboard, reports, users, imports, shoppingList, cashSessions)
│   └── jobs/dailyAlerts.js    # e-mail diário de alerta
├── public/                    # frontend (HTML/CSS/JS puro, servido como estático)
│   ├── index.html             # login; cadastro.html, recuperar-senha.html, reset-password.html
│   ├── app.html               # aplicação principal (templates de cada tela)
│   ├── css/style.css
│   └── js/                    # api.js (cliente HTTP), app.js (lógica das telas) e um script por página
└── test/
    ├── contract.test.js       # openapi.yaml × rotas do Express (sem banco)
    ├── integration.test.js    # suíte de testes de integração
    └── helpers/               # utilitários de teste (banco, HTTP)
```

A dependência entre camadas é sempre de cima para baixo: `routes` → `services` / `middleware` / `lib` → `db`/`config`. Rotas não falam umas com as outras; regra de negócio compartilhada fica em `services/`.

## 8. Scripts disponíveis

| Comando | O que faz |
|---|---|
| `npm start` | Sobe o servidor em modo produção |
| `npm run dev` | Sobe o servidor com recarregamento automático (nodemon) |
| `npm run prisma:migrate` | Cria/aplica migrations em desenvolvimento |
| `npm run prisma:deploy` | Aplica migrations em produção |
| `npm run seed` | Cria o primeiro usuário administrador |
| `npm run seed:products` | Carrega produtos de exemplo |
| `npm run simulate:sales` | Gera histórico de vendas de exemplo nos últimos 14 dias |
| `npm run reset-password` | Redefine a senha de um usuário (recuperação de emergência) |
| `npm test` | Roda o teste de contrato e a suíte de integração (banco em `TEST_DATABASE_URL`) |
| `npm run spec:check` | Valida as specs OpenSpec, faz lint do `openapi.yaml` e roda o teste de contrato |
| `npm run spec:docs` | Gera `openspec/openapi.html`, a referência navegável da API |

## 9. Segurança (resumo)

O projeto passou por múltiplas rodadas de auditoria de segurança, com 21 brechas reais encontradas e corrigidas — cada uma testada ao vivo contra um banco de dados real (nunca só analisada no código). Destaques: proteção contra SQL injection e XSS (testadas com payloads reais), CSRF, condição de corrida em estoque concorrente, revogação de sessão em tempo real, força bruta, TLS obrigatório no e-mail, e mais. **Lista completa, com o que foi encontrado e como foi corrigido, no [README.md](README.md#decisões-de-segurança).**

## 10. Testes

```bash
npm test
```

Suíte de integração (`test/integration.test.js`) rodando com o test runner nativo do Node.js (`node:test`, zero dependências novas) contra um PostgreSQL real — sobe a aplicação de verdade e faz requisições HTTP reais, sem mocks. Cobre regressão dos bugs mais graves já encontrados: condição de corrida em estoque (inclusive a coerência do extrato sob vendas simultâneas), revogação de sessão, autorização por papel, CSRF, SQL injection, validação de data de calendário, overflow numérico, reativação de produto, previsão sem vendas canceladas e o link de recuperação de senha nunca exposto em produção.

A suíte apaga todos os dados do banco configurado antes de rodar — por segurança, ela recusa executar a menos que o nome do banco contenha "test" (ou `ALLOW_DB_RESET=true` seja definido explicitamente). Com `TEST_DATABASE_URL` no `.env`, ela usa esse banco no lugar de `DATABASE_URL`. Detalhes em [README.md](README.md#testes-automatizados).

`test/contract.test.js` roda sem banco: compara as 38 operações registradas no Express com as documentadas em `openspec/openapi.yaml` e falha se houver qualquer diferença.

## 11. Especificação OpenSpec e contrato da API

O projeto usa [OpenSpec](https://github.com/Fission-AI/OpenSpec) como fonte da verdade do comportamento esperado. Há duas camadas:

- **Specs de comportamento** — `openspec/specs/<capacidade>/spec.md`, uma por área: `api-platform` (convenções transversais), `auth`, `users`, `products`, `stock`, `sales`, `dashboard`, `reports`, `product-import` e `daily-alerts`. Cada requisito usa `SHALL`/`MUST` e tem cenários `WHEN`/`THEN` verificáveis.
- **Contrato HTTP** — `openspec/openapi.yaml` (OpenAPI 3.1): todos os endpoints, parâmetros, corpos, respostas, códigos de erro, autenticação por cookie e o cabeçalho anti-CSRF. Cada tag aponta para a spec correspondente.

`npm run spec:check` valida as duas camadas e a correspondência com o código. Mudanças novas seguem o fluxo do OpenSpec: proposta em `openspec/changes/<nome>/` (motivo, delta das specs, design e tarefas), implementação e arquivamento, que incorpora o delta nas specs principais. O `openspec/config.yaml` guarda o contexto do projeto (stack, arquitetura, convenções) usado nesse fluxo.
