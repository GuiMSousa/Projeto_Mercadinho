# Contro Vend

Sistema web de controle de vendas e estoque para pequeno comerciante (mercadinho de secos e molhados). Roda na nuvem — não precisa ser instalado na máquina do cliente, só um navegador.

📖 **[Documentação técnica completa](DOCUMENTATION.md)** — stack tecnológica, arquitetura, modelo de dados, perfis de acesso e detalhamento de cada funcionalidade. Este README cobre o dia a dia: instalar, rodar, publicar e as decisões de segurança.

📐 **[Especificação OpenSpec](openspec/)** — requisitos de cada área em [`openspec/specs/`](openspec/specs/) e o contrato HTTP completo (OpenAPI 3.1) em [`openspec/openapi.yaml`](openspec/openapi.yaml). Veja [Especificação (OpenSpec + OpenAPI)](#especificação-openspec--openapi).

## O que o sistema faz

- **Vendas**: tela de caixa (busca produto por nome/código de barras, monta o carrinho, confirma a venda). Cada venda desconta o estoque automaticamente e registra a forma de pagamento (dinheiro, Pix, débito ou crédito — dinheiro quando não informada).
- **Estoque em lotes**: cada entrada de mercadoria vira um lote com quantidade e validade; ajustes/baixas (perda, vencimento, quebra) e histórico completo de movimentações, com o rastro de quanto saiu de cada lote.
- **PVPS (Primeiro que Vence, Primeiro que Sai)**: a venda baixa primeiro o lote válido que vence antes; lotes vencidos só saem por perda (ou se não houver mais lote válido). Cancelar uma venda devolve a mercadoria aos mesmos lotes.
- **Semáforo de urgência**: todo produto vem classificado em vermelho (sem estoque, vencido ou vencendo em até 7 dias), amarelo (no mínimo ou vencendo em 8 a 30 dias) ou verde, com os motivos — e a listagem filtra por cor.
- **Lista de compras**: produtos com estoque menor ou igual ao mínimo, por categoria, também em texto pronto para mandar ao fornecedor pelo WhatsApp.
- **Caixa**: abertura com fundo de troco e fechamento com o dinheiro contado; o sistema compara com o esperado (fundo + vendas em dinheiro) e aponta sobra ou falta. O funcionário fecha "às cegas"; o dono vê a conciliação e o histórico.
- **Importação de planilha**: carrega e atualiza o catálogo a partir de um Excel (`.xlsx`), CSV ou de dados colados direto do Excel/Google Planilhas — reconhece as colunas sozinho, mostra tudo para conferência e só grava depois que o dono confirma.
- **Previsão de esgotamento**: com base na média de vendas dos últimos 30 dias, o sistema estima em quantos dias cada produto vai acabar — para saber o que repor antes de faltar.
- **Produtos parados**: lista produtos com estoque mas sem nenhuma venda nos últimos 60 dias — ajuda a evitar comprar mais do que gira.
- **Alertas de validade**: produtos perto de vencer aparecem no painel (evita perda por produto vencido).
- **Alerta diário por e-mail** (opcional): resumo de estoque baixo, previsão de falta e validades próximas, enviado automaticamente uma vez por dia se o SMTP for configurado.
- **Perfis de usuário**: **administrador** (dono, acesso total) e **caixa** (funcionário, só registra vendas e vê estoque — não vê preço de custo/margem nem dados financeiros).

## Arquitetura

- **Backend**: Node.js + Express + PostgreSQL (via [Prisma ORM](https://www.prisma.io/)).
- **Frontend**: HTML/CSS/JS puro (sem build step), servido pelo próprio backend — simples de hospedar em qualquer provedor.
- **Banco de dados**: PostgreSQL. Provedores gratuitos que funcionam bem: [Neon](https://neon.tech), [Supabase](https://supabase.com), [Railway](https://railway.app), [Render](https://render.com/docs/free#free-postgresql).

## Rodando localmente (para desenvolvimento)

Pré-requisitos: Node.js 20+ e um PostgreSQL acessível (local, na nuvem, ou o container do `docker-compose.yml`).

```bash
npm install
cp .env.example .env    # PowerShell: Copy-Item .env.example .env
# edite o .env com sua DATABASE_URL, JWT_SECRET, ADMIN_EMAIL/ADMIN_PASSWORD
docker compose up -d db # opcional: PostgreSQL local em localhost:5433 (veja o .env.example)
npm run prisma:migrate
npm run seed            # cria o primeiro usuário administrador
npm run seed:products   # opcional: carrega ~24 produtos de exemplo (secos e molhados) com validade
npm run dev
```

Acesse `http://localhost:3000`.

## Rodando com Docker Compose (ambiente local persistente)

Alternativa ao passo a passo acima para quem já tem Docker instalado: sobe o app **e** o banco como containers de longa duração, com os dados gravados num volume — sobrevivem a fechar o terminal, parar os containers, e até reiniciar a máquina (o Docker Desktop precisa voltar a subir).

```bash
docker compose up -d --build
docker compose exec app npm run seed             # cria o administrador (senha padrão: TrocarEssaSenha123!)
docker compose exec app npm run seed:products     # opcional
docker compose exec app npm run simulate:sales    # opcional: histórico de vendas de exemplo
```

Acesse `http://localhost:3100`. Para customizar (senha do banco, e-mail/senha do administrador, SMTP), crie um `.env` na raiz do projeto — o `docker-compose.yml` lê as mesmas variáveis do `.env.example`, com valores padrão só para uso local.

O banco fica exposto em `localhost:5433` (e não na 5432, que costuma já estar ocupada por um PostgreSQL instalado direto na máquina) — é essa porta que o `npm run dev` e o `npm test` usam para falar com o container.

- `docker compose stop` / `docker compose start` — para e liga de novo sem perder nada.
- `docker compose down` (sem `-v`) — remove os containers mas mantém o volume/dados.
- `docker compose down -v` — **apaga os dados de vez** (só use se for isso mesmo que quiser).

⚠️ Este `docker-compose.yml` é para desenvolvimento/demonstração local (roda em `http://` sem HTTPS, com um `JWT_SECRET` padrão). Para publicar de verdade na internet, siga a seção **Publicando na nuvem** abaixo, não este arquivo.

### Carga de produtos de exemplo

`npm run seed:products` ([prisma/seedProducts.js](prisma/seedProducts.js)) insere um catálogo de exemplo de mercadinho (arroz, feijão, laticínios, limpeza, higiene etc.), com datas de validade variadas — alguns vencendo em poucos dias, outros com validade longa, e alguns sem validade (produtos de limpeza/higiene, como definido para o sistema). Alguns produtos já entram com estoque abaixo do mínimo, então o Painel mostra alertas reais assim que você loga.

### Simulação de histórico de vendas

`npm run simulate:sales` ([prisma/simulateSales.js](prisma/simulateSales.js)) gera um histórico de vendas realista, espalhado nos últimos 14 dias (`SIMULATE_DAYS` para mudar a janela) — ao contrário de uma venda feita pela tela ou pela API (que sempre grava a data de agora), este script "volta no tempo", alternando entre o administrador e um caixa de demonstração. Isso é o que faz o **Relatório de vendas por dia** mostrar uma tendência de verdade em vez de um único dia, e a **previsão de esgotamento** calcular uma taxa de venda diária real em vez de zero. Requer produtos já cadastrados (`npm run seed:products` ou seus próprios produtos).

É seguro rodar mais de uma vez: identifica cada produto pelo código de barras e atualiza em vez de duplicar. Edite a lista no arquivo para refletir os produtos, preços e código de barras reais do cliente antes de usar em produção — os dados atuais são só um ponto de partida.

### Importação de planilha (aba "Importar")

Cadastrar centenas de produtos à mão é o maior obstáculo para começar a usar o sistema. A aba **Importar** (só para o administrador) resolve isso a partir do arquivo que o comerciante já tem — a lista do fornecedor, a planilha de preços, o inventário do contador.

**Formatos aceitos**: Excel `.xlsx`/`.xlsm`, `.csv`, `.txt`/`.tsv`, ou dados **colados** direto do Excel / Google Planilhas (copiar e colar na caixa de texto). Arquivos `.xls` antigos e `.ods` precisam ser salvos como `.xlsx` ou `.csv` antes — o sistema avisa quando isso acontece. Também há um **modelo em Excel** para baixar já com as colunas certas.

**O fluxo é sempre em quatro passos**, e nada é gravado antes da confirmação:

1. **Escolher** o arquivo (ou colar os dados).
2. **Conferir as colunas** — o sistema adivinha o que é cada uma pelo cabeçalho (`EAN`, `Cód. Barras` e `GTIN` viram código de barras; `VLR VENDA`, `Preço` e `Valor` viram preço de venda; `QTDE`, `Saldo` e `Estoque` viram estoque, e assim por diante), mostrando embaixo de cada campo um exemplo real da planilha para conferência. Qualquer coluna pode ser corrigida ou marcada como "não importar" sem reenviar o arquivo.
3. **Conferir o que será gravado** — uma tabela linha a linha dizendo o que vai ser cadastrado, atualizado (com `preço antigo → preço novo` e `estoque antigo → estoque novo`), ignorado ou barrado por erro.
4. **Confirmar**.

**O que o sistema entende sozinho**: preços no formato brasileiro (`R$ 1.234,56`) e no internacional (`1,234.56`); datas como `31/12/2026`, `31-12-26` e o formato interno de data do Excel; códigos de barras que o Excel converteu em número; acentuação de arquivos CSV salvos pelo Excel em português (Windows-1252), que sem isso viraria `Caf<?>` no lugar de `Café`.

**Opções de aplicação**:

| Opção | Para quê |
|---|---|
| Cadastrar novos e atualizar existentes / só cadastrar / só atualizar | Controla se a planilha pode criar produtos, mexer nos que já existem, ou ambos. |
| Identificar por código de barras (padrão) ou por nome | Como cada linha é ligada a um produto já cadastrado. |
| Coluna de estoque: só no cadastro / substituir o saldo (balanço) / somar ao saldo (entrada de mercadoria) | Define se a planilha mexe no estoque de quem já existe, e como. |

**Proteções** (todas verificadas por testes de regressão em [test/integration.test.js](test/integration.test.js)):

- Toda alteração de estoque vinda da planilha entra no **extrato de movimentações** com saldo anterior e novo, igual a uma entrada ou ajuste feito à mão — a importação nunca é um caminho paralelo que burla a auditoria.
- Linha cujo código de barras pertence a **outro** produto é recusada, nunca sobrescrita em silêncio.
- Código de barras repetido dentro do próprio arquivo é barrado, para não cadastrar o mesmo produto duas vezes nem contar a mesma entrada de estoque em dobro.
- Cada linha é gravada na sua própria transação: uma linha problemática no meio do arquivo não descarta as que já passaram, e o resultado final aponta exatamente quais falharam e por quê.
- Limite de 1.000 linhas e 5 MB por importação; a rota é exclusiva do administrador.

## Publicando na nuvem (exemplo: Render, Railway ou similar)

1. Crie um banco PostgreSQL gerenciado e copie a `DATABASE_URL`.
2. Configure as variáveis de ambiente do `.env.example` no painel do provedor (nunca coloque segredos no código).
3. Gere um `JWT_SECRET` forte, por exemplo com `openssl rand -base64 48`.
4. Defina `NODE_ENV=production` e `COOKIE_SECURE=true` (exige HTTPS, que esses provedores já entregam).
5. Comando de build: `npm install` (o `postinstall` já roda `prisma generate`).
6. Rode as migrations uma vez: `npm run prisma:deploy`.
7. Rode o seed uma vez: `npm run seed` (cria o administrador inicial).
8. Comando de start: `npm start`.

Depois do primeiro login, troque a senha do administrador em **Usuários**.

### Esqueci a senha

A tela **Esqueci a senha** gera um link de redefinição de uso único (válido por `PASSWORD_RESET_EXPIRES_MIN` minutos). Não há envio por e-mail: o link é registrado no **log do servidor**, e o dono o repassa ao funcionário. Fora de produção o link também volta na resposta e a tela leva direto à troca de senha; em produção (`NODE_ENV=production`) ele **nunca** volta na resposta — senão qualquer pessoa que soubesse o e-mail do dono assumiria a conta de administrador. O administrador também pode redefinir a senha de qualquer funcionário em **Usuários**.

Se o próprio administrador ficar trancado para fora, quem tem acesso ao servidor/banco pode redefinir via:

```bash
RESET_EMAIL=admin@example.com RESET_PASSWORD="NovaSenhaForte123!" npm run reset-password
# PowerShell: $env:RESET_EMAIL="admin@example.com"; $env:RESET_PASSWORD="NovaSenhaForte123!"; npm run reset-password
```

Isso também reativa a conta, caso tenha sido desativada por engano, e derruba as sessões abertas com a senha antiga.

## Decisões de segurança

- **Senhas**: nunca armazenadas em texto puro — hash com bcrypt (fator de custo 12).
- **Sessão**: JWT em cookie `httpOnly` + `Secure` (produção) + `SameSite=Lax`, então não é acessível via JavaScript nem enviado em requisições de terceiros.
- **CSRF**: além do `SameSite`, toda rota que altera dados exige um cabeçalho `X-Requested-With: fetch`, que só pode ser definido por JavaScript same-origin — formulários forjados em outro site não conseguem enviá-lo.
- **SQL Injection**: todo acesso ao banco passa pelo Prisma com parâmetros tipados; não há concatenação de string em nenhuma query.
- **XSS**: o frontend nunca usa `innerHTML` com dados vindos do servidor — toda renderização usa `textContent`/`createElement`.
- **Autorização**: cada rota checa o papel do usuário no servidor (não só esconde botões na tela) — testado explicitamente: um usuário "caixa" recebe `403` ao chamar a API de usuários e nunca recebe o preço de custo dos produtos na resposta.
- **Força bruta**: login limitado a 10 tentativas a cada 15 minutos por IP. O erro diz se foi o login (e-mail) ou a senha que errou — escolha de usabilidade que, em troca, revela se um e-mail está cadastrado.
- **Condição de corrida no estoque**: toda operação que soma/subtrai do estoque (venda, entrada de compra, ajuste/perda, cancelamento de venda) usa um `UPDATE` condicional atômico (`WHERE estoque` dentro dos limites) via `src/services/stockOps.js`, nunca "ler em JS e escrever de volta um valor absoluto" — requisições simultâneas para o mesmo produto nunca se perdem ou deixam o estoque negativo/acima do limite. O extrato registra o saldo anterior/novo relido dentro da própria transação, então também fica correto sob concorrência (antes, 10 vendas simultâneas gravavam "10 → 9" repetido no extrato).
- **Exclusão de produtos/usuários**: é lógica (campo `active`), nunca física — preserva o histórico de vendas para relatórios e auditoria.
- **Erros**: mensagens de erro internas nunca vazam para o cliente (log no servidor, resposta genérica ao usuário).
- **Segredos**: `.env` nunca é versionado (`.gitignore`); a aplicação recusa subir em produção com `JWT_SECRET` fraco/ausente, e força cookie `Secure` em produção independentemente do `.env`.
- **JWT com algoritmo fixo**: `HS256` é exigido explicitamente na verificação (não inferido), fechando qualquer brecha de ataque de confusão de algoritmo.
- **Filtros de busca validados**: parâmetros de data/enum em consultas (relatórios, histórico de estoque, vendas) são validados antes de chegar ao banco — entrada inválida vira um erro `400` claro, nunca um `500` genérico.
- **Limites contra estouro numérico**: o total de uma venda e o estoque resultante de uma entrada/ajuste têm um teto de segurança checado em código, para nunca esbarrar no limite de precisão das colunas do banco.
- **Rede de segurança do processo**: `uncaughtException`/`unhandledRejection` são capturados no nível do processo — um erro inesperado é registrado em log em vez de derrubar o servidor inteiro; se um erro verdadeiramente irrecuperável ocorrer, o processo se encerra de forma controlada para que o orquestrador (Docker/Render/PM2) reinicie o serviço automaticamente.
- **Revogação de sessão em tempo real**: cada requisição autenticada revalida no banco se o usuário ainda está ativo e qual é seu papel atual — desativar uma conta ou rebaixar um administrador tem efeito imediato, mesmo que o token JWT dele ainda não tenha expirado (até 8h de validade).
- **`trust proxy` seguro por padrão**: o servidor não confia no cabeçalho `X-Forwarded-For` a menos que `TRUST_PROXY` seja explicitamente configurado no `.env` — evita que qualquer requisição finja vir de um IP diferente a cada tentativa e contorne o limite de tentativas de login.
- **E-mail sempre criptografado**: a conexão SMTP exige TLS (implícito na porta 465, ou STARTTLS obrigatório em qualquer outra porta) — nunca envia a senha do SMTP nem os níveis de estoque em texto plano na rede, e nunca aceita um certificado não confiável ou de host errado (testado com um servidor SMTP simulado sem TLS e outro com certificado inválido — ambos corretamente recusados). E-mail só em texto puro, nunca HTML, eliminando riscos de phishing/renderização.
- **Detalhe de produto respeita o mesmo filtro da listagem**: um produto desativado fica invisível para quem não é admin também na rota de detalhe (`GET /products/:id`), não só na listagem — evita que alguém veja um produto descontinuado só por saber ou adivinhar o ID.
- **Recuperação de senha**: link de uso único (token aleatório de 256 bits, guardado só como hash SHA-256, com validade curta) que vai para o log do servidor — em produção ele nunca volta na resposta da API, o que fecharia a porta para assumir qualquer conta só sabendo o e-mail. Usar o link derruba todas as sessões do usuário. Para o administrador trancado para fora, há o script de emergência `npm run reset-password`.
- **Reativação de produto**: um produto desativado pode ser reativado (pela tela ou pela API) — antes não havia nenhuma forma de desfazer uma desativação a não ser editando o banco diretamente.
- **Limite de requisições realista**: o teto geral por IP (`API_RATE_LIMIT_MAX`, padrão 300/min) foi calibrado testando carga real — o valor inicial de 120/min chegava a bloquear vendas legítimas quando vários caixas da mesma loja (mesmo IP) vendiam ao mesmo tempo.

## Auditoria de segurança realizada

O projeto passou por várias rodadas de auditoria de segurança: releitura de cada arquivo, correção das brechas encontradas, e uma bateria de testes reais (não só análise de código) contra um PostgreSQL de verdade rodando em Docker — incluindo simulações completas de ataque (funcionário mal-intencionado, sessão comprometida, força bruta). Entre os testes: 20 vendas simultâneas contra um produto com 10 unidades em estoque (resultado: exatamente 10 sucessos, 10 rejeitados, estoque final zero — nunca negativo), tentativas de SQL injection em parâmetros de rota e campos de texto (neutralizadas pelo Prisma), payload XSS armazenado e verificado ao vivo no navegador (nunca executa — vira texto escapado na tela), JWT adulterado e ataque `alg:none` (ambos rejeitados), queda total do banco de dados no meio de requisições (servidor devolveu erro limpo e se recuperou sozinho, sem reiniciar), JSON malformado/gigante/com aninhamento profundo, datas de calendário impossíveis (ex: 30 de fevereiro), bypass de autorização em cada rota administrativa a partir de uma conta de funcionário, **um funcionário demitido que continuava vendendo com o token antigo** (achado crítico, corrigido), **contorno do limite de tentativas de login forjando o cabeçalho X-Forwarded-For** (achado crítico, corrigido), adulteração de preço/vendedor no corpo da requisição de venda (ignorada — servidor sempre recalcula do banco), directory traversal nos arquivos estáticos, poluição de protótipo via query string, e **uma condição de corrida que perdia 14 de 30 entradas de estoque simultâneas silenciosamente** (achado crítico, corrigido). Vinte e uma brechas de segurança reais foram encontradas e corrigidas no total.

Depois do redesenho visual e da adição do script de simulação de vendas, foi feita uma rodada de regressão (suíte automatizada + cabeçalhos de segurança + CSRF + rate limit + `npm audit`, tudo contra um banco descartável separado) para confirmar que nenhuma mudança recente abriu brecha nova — nenhuma encontrada. Nessa mesma rodada, ao montar o `docker-compose.yml`, a imagem baseada em Alpine falhou silenciosamente ao aplicar migrations (o motor do Prisma não detectava a versão de OpenSSL do Alpine e entrava em loop de reinício) — trocada por uma base Debian (`node:20-bookworm-slim`), recomendada pelo próprio Prisma para evitar essa classe de problema.

## Auditoria de qualidade, performance e UX

Além da segurança, o projeto passou por uma rodada de auditoria de qualidade/UX/performance:

- **Campo de quantidade no carrinho perdia o foco a cada tecla** — o carrinho de vendas recriava o `<input>` inteiro a cada dígito digitado, então o segundo dígito de "12" nunca chegava a ser digitado no campo. Corrigido para atualizar só o subtotal/total sem recriar o input; testado ao vivo (foco confirmado persistindo em múltiplas teclas seguidas).
- **N+1 query na criação de vendas**: uma venda com N itens fazia N consultas sequenciais de leitura antes de N gravações. Corrigido para 1 consulta em lote + N gravações (as gravações continuam individuais, pois cada uma precisa do `UPDATE` atômico condicional que impede sobrevenda).
- **Overflow horizontal em telas estreitas**: tabelas largas (ex: Produtos, com 8 colunas) empurravam a página inteira para o lado num celular. Corrigido envolvendo cada tabela num contêiner com rolagem própria — testado matematicamente via navegador (largura da página sem overflow, tabela rolando dentro do próprio espaço).
- **Acessibilidade de formulários**: 15 campos tinham `<label>` visualmente ao lado do campo mas sem associação programática (`for`/`id`) — leitores de tela não conseguiam ligar o rótulo ao campo. Corrigido em todos os formulários, e adicionado `aria-label` nos campos de busca (que não têm rótulo visível por design).
- **Duplicação de lógica** entre painel, relatórios e e-mail de alerta (cálculo de "estoque baixo/prestes a esgotar" e "produtos parados" estava repetido em 3 lugares) — extraída para funções compartilhadas em `src/services/forecast.js` (que desconsidera vendas canceladas).
- **Produto desativado não podia ser reativado** — funcional, não só de segurança: cobre o caso de uso central de desfazer uma desativação por engano.

## Testes automatizados

```bash
npm test
```

Roda o teste de contrato ([test/contract.test.js](test/contract.test.js), confere que `openspec/openapi.yaml` documenta exatamente as rotas do Express — não usa banco) e uma suíte de testes de integração ([test/integration.test.js](test/integration.test.js)) com o test runner nativo do Node (`node:test`, sem dependências novas) contra um PostgreSQL real — sobe a aplicação de verdade em memória e faz requisições HTTP reais. Cobre regressão dos bugs mais graves encontrados na auditoria: condição de corrida em estoque concorrente (entradas e vendas simultâneas), revogação de sessão em tempo real, autorização por papel, CSRF, SQL injection, validação de data de calendário, limite de overflow numérico, e reativação de produto. A importação de planilha tem seu próprio bloco: autorização, leitura de `.xlsx`, formatos numéricos e de data brasileiros, rastro de auditoria no estoque, e as travas contra duplicidade e contra sobrescrever o produto dono de um código de barras. Os lotes, o semáforo, a lista de compras e o caixa também têm blocos próprios: ordem PVPS da venda e da perda, devolução ao lote de origem no cancelamento (inclusive com dois cancelamentos simultâneos), edição de validade, as cores do semáforo, a conciliação só com dinheiro, o fechamento cego e vendas simultâneas ao fechamento.

**Atenção**: a suíte apaga todos os dados do banco apontado por `DATABASE_URL` antes de rodar. Use sempre um banco dedicado a testes — nunca aponte para dados reais. Por segurança, a suíte recusa rodar a menos que o nome do banco contenha "test", ou que `ALLOW_DB_RESET=true` seja definido explicitamente.

Com o ambiente Docker do projeto já no ar, um banco de testes separado sai assim (o banco de trabalho fica intacto):

```bash
docker compose exec db psql -U postgres -c "CREATE DATABASE contro_vend_test"
```

Aponte `TEST_DATABASE_URL` no `.env` para ele (a suíte usa essa variável no lugar de `DATABASE_URL`, em qualquer terminal — inclusive PowerShell/cmd) e aplique as migrations uma vez:

```bash
# no .env: TEST_DATABASE_URL="postgresql://postgres:changeme_local_only@localhost:5433/contro_vend_test?schema=public"

# uma vez (e a cada migration nova), cria as tabelas no banco de teste:
DATABASE_URL="postgresql://postgres:changeme_local_only@localhost:5433/contro_vend_test?schema=public" npx prisma migrate deploy
# PowerShell:
#   $env:DATABASE_URL="postgresql://postgres:changeme_local_only@localhost:5433/contro_vend_test?schema=public"; npx prisma migrate deploy; Remove-Item Env:DATABASE_URL

npm test
```

## Especificação (OpenSpec + OpenAPI)

O projeto segue o fluxo de [OpenSpec](https://github.com/Fission-AI/OpenSpec) (desenvolvimento guiado por especificação):

```
openspec/
├── config.yaml        # contexto do projeto e regras usadas pelo OpenSpec/assistentes de IA
├── openapi.yaml       # contrato HTTP (OpenAPI 3.1): 38 endpoints, schemas e erros
├── specs/             # fonte da verdade do comportamento, uma pasta por capacidade
│   ├── api-platform/  auth/  users/  products/  stock/  sales/
│   └── dashboard/  reports/  product-import/  daily-alerts/  shopping-list/  cash-register/
└── changes/           # propostas de mudança em andamento (e archive/ das concluídas)
```

Cada `spec.md` lista requisitos (`SHALL`/`MUST`) com cenários `WHEN`/`THEN`; o `openapi.yaml` descreve os payloads. Os dois são verificados automaticamente:

```bash
npm run spec:check   # valida as specs (openspec --strict), faz lint do OpenAPI (Redocly) e roda o teste de contrato
npm run spec:docs    # gera openspec/openapi.html (referência navegável da API) — abra no navegador
```

Para explorar as specs no terminal, instale o CLI uma vez (`npm install -g @fission-ai/openspec@1.13.2`) e use `openspec list --specs`, `openspec show sales` ou `openspec view` (painel interativo). O `openapi.yaml` também pode ser importado direto no Postman/Insomnia ou aberto no [Swagger Editor](https://editor.swagger.io).

**Fluxo para uma mudança nova** (no Claude Code, com os comandos `/opsx:*` instalados pelo `openspec init`): `/opsx:propose "descrição"` cria `openspec/changes/<nome>/` com proposta, delta das specs, design e tarefas → `/opsx:apply` implementa → `/opsx:archive` incorpora o delta em `openspec/specs/`. Se a mudança mexer na API, atualize também o `openapi.yaml` — o teste de contrato quebra se rota e documentação divergirem.

## Testes realizados manualmente

Além da suíte automatizada, o sistema foi testado manualmente de ponta a ponta (API e navegador) em cada rodada de mudança: login, CRUD de produtos, venda com baixa de estoque, cancelamento de venda, entradas/ajustes de estoque, relatórios, gestão de usuários, alerta por e-mail, e responsividade em desktop/mobile.

## Próximos passos sugeridos (fora do escopo inicial)

- Leitor de código de barras via câmera do celular (a busca por código de barras já funciona digitando).
- Exportação de relatórios em PDF/Excel.
- Telas para o que já existe na API: lotes (consulta e correção de validade), semáforo, lista de compras, abertura/fechamento de caixa e forma de pagamento na venda — hoje a interface ainda não envia `paymentMethod`, então toda venda conta como dinheiro.
- Troco e valor recebido na venda em dinheiro (com bloqueio de valor pago menor que o total), previstos no relatório do Mercadinho.
- Busca de produtos insensível a acento (hoje "feijao" não encontra "Feijão" — só busca por substring literal).
- Estados de carregamento explícitos na interface (hoje uma requisição lenta não mostra nenhum indicador visual de "carregando").
