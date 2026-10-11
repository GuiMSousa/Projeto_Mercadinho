# Spec Delta

## MODIFIED Requirements

### Requirement: Gravação por linha com auditoria
O commit SHALL gravar cada linha em uma transação própria, para que a falha de uma não desfaça as demais, e MUST registrar toda alteração de saldo no extrato (ENTRY para estoque inicial e soma, ADJUSTMENT para acerto de saldo). Aumentos de saldo MUST criar um lote com a validade da linha, e reduções SHALL baixar pela ordem de perda do PVPS. A resposta SHALL trazer `created`, `updated`, `skipped`, `failed` e as falhas por linha.

#### Scenario: Acerto de saldo
- **WHEN** a planilha traz estoque 25 para um produto com saldo 10 e `stockMode` é `set`
- **THEN** o saldo passa a 25 e o extrato registra um ADJUSTMENT de 10 para 25

#### Scenario: Entrada pela planilha
- **WHEN** a linha traz estoque 12 e validade 31/12/2026 com `stockMode` igual a `add`
- **THEN** o produto ganha um lote de 12 unidades que vence em 2026-12-31

## ADDED Requirements

### Requirement: Validade em linhas que não criam lote
Numa linha que atualiza um produto sem criar lote, a validade SHALL seguir a regra da edição de produto: igual à atual é ignorada e, diferente, é aplicada aos lotes com saldo quando todos têm a mesma validade. Nos demais casos a linha MUST seguir sem alterar validades e com um aviso, que já aparece na conferência.

#### Scenario: Produto com lotes de validades diferentes
- **WHEN** a planilha traz nova validade para um produto cujos lotes com saldo vencem em datas diferentes
- **THEN** a linha atualiza os outros campos e avisa que a validade não foi aplicada
