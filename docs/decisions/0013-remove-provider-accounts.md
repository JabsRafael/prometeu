# ADR 0013 — Remoção de contas e seleção vazia

Data: 2026-09-05
Status: Aceito

Substitui parcialmente o [ADR 0012](0012-provider-accounts.md) na permanência
dos perfis externos e na exigência de uma seleção por provider.

## Contexto

A pessoa precisa remover contas, inclusive a última conta e a herdada do CLI.
Os processos capturam seus perfis e podem continuar executando após a remoção.
Apagar credenciais ou os diretórios nessa hora pode interromper um turno ou
afetar os links para histórico compartilhado.

## Opções consideradas

- Impedir a remoção do perfil externo: preserva a seleção obrigatória, mas
  não permite limpar a lista como solicitado.
- Apagar credenciais e perfis: requer coordenar todos os processos e consultas
  em andamento, além do armazenamento específico de cada provider.
- Remover o cadastro e permitir seleção vazia: atende ao seletor sem alterar
  o login do terminal ou interromper processos existentes.

## Decisão

Permitir a remoção de qualquer conta do cadastro. Remover a conta ativa deixa
o provider sem seleção; não escolhe outra conta automaticamente. Novas falas
exigem uma escolha explícita, enquanto o turno iniciado pode terminar.

O cadastro vazio é persistido. Perfis do terminal são importados somente se
o arquivo de cadastro ainda não existe. Adicionar outra conta inicia o login
oficial sem pedir apelido; o e-mail identifica a conta. Cadastros antigos com
`label` continuam legíveis, mas esse campo deixa de ser usado e gravado.

## Consequências

Remover não faz logout nem revoga credenciais. Diretórios privados, Keychain e
histórico são preservados. Perfis removidos deixam de ser consultados nas
próximas rodadas de cotas, e respostas atrasadas não os recriam no cadastro.
Não há coleta de perfis órfãos nesta operação; essa coleta exigirá coordenar
todos os leitores antes de excluir credenciais e links.

## Evidência

O [contrato de contas](../contracts/accounts.md) descreve a seleção opcional,
o IPC de remoção e o limite de limpeza. `accounts.rs` testa cadastro legado,
remoção completa e releitura vazia. `e2e/accounts.spec.ts` verifica remoção,
reabertura, novo login e preservação da conversa e do outro provider.
