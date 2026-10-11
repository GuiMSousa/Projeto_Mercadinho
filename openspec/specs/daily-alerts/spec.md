# daily-alerts Specification

## Purpose
Resumo diário opcional por e-mail, para o dono saber o que repor e o que está vencendo sem abrir o sistema: estoque abaixo do mínimo, previsão de falta e validades próximas, sempre enviado por conexão criptografada. Não expõe rotas HTTP; é configurado só por variáveis de ambiente.

## Requirements

### Requirement: Envio diário agendado
Com `SMTP_HOST` e `ALERT_EMAIL_TO` configurados, o sistema SHALL enviar uma vez por dia, na hora `LOW_STOCK_ALERT_HOUR` (0 a 23, padrão 8, no fuso do servidor), um e-mail listando os produtos abaixo do mínimo, os com previsão de esgotar em até 7 dias e os com validade nos próximos `EXPIRY_ALERT_DAYS` dias. Sem nenhum alerta no dia, MUST NOT enviar.

#### Scenario: Dia com alertas
- **WHEN** chega a hora configurada e há produtos abaixo do mínimo
- **THEN** os destinatários recebem o e-mail "Alerta diário de estoque - Contro Vend" com a lista

#### Scenario: Dia sem alertas
- **WHEN** chega a hora configurada e não há nenhum alerta
- **THEN** nenhum e-mail é enviado

#### Scenario: SMTP não configurado
- **WHEN** `SMTP_HOST` está vazio
- **THEN** o envio fica desativado e o restante do sistema funciona normalmente

### Requirement: Transporte sempre criptografado
A conexão SMTP MUST usar TLS (implícito na porta 465, STARTTLS obrigatório nas demais) e MUST recusar servidor sem TLS ou com certificado inválido. Usuário e senha SHALL ser enviados somente quando ambos estiverem configurados, e o conteúdo MUST ser texto puro, nunca HTML.

#### Scenario: Servidor SMTP sem TLS
- **WHEN** o servidor SMTP na porta 587 não oferece STARTTLS
- **THEN** o envio falha sem transmitir credenciais nem conteúdo

### Requirement: Validação da configuração
`ALERT_EMAIL_TO` SHALL aceitar um e-mail ou uma lista separada por vírgula, e um endereço inválido MUST ser apontado no log e impedir o envio. A conexão SMTP SHALL ser verificada na inicialização, registrando falhas no log sem impedir o servidor de subir.

#### Scenario: Destinatário digitado errado
- **WHEN** `ALERT_EMAIL_TO` contém `dono@@loja`
- **THEN** o log aponta o endereço inválido e nenhum e-mail é enviado
