# ADR 0014 — conta opcional e SaaS separado

Data: 2026-09-06
Status: Substituído pelo [ADR 0015](0015-cloud-rails.md) na escolha da stack.
As garantias de conta opcional, isolamento do relay e conexão pelo navegador permanecem.

## Contexto

O acesso pessoal por vários dispositivos precisa de identidade própria. O
relay atual identifica membros de time e encaminha conversas; não possui
contas pessoais nem persistência de transcripts. O uso local deve continuar
sem cadastro ou conexão com o SaaS.

## Opções consideradas

1. Reutilizar a matrícula do relay como conta: mistura pessoas e dispositivos
   e muda a autoridade do compartilhamento existente.
2. Implementar senhas e sessões próprias: cria manutenção de segurança que
   não pertence ao produto.
3. Serviço separado com autenticação existente e conexão pelo navegador.

## Decisão

Criar o projeto independente `prometeu-cloud` com Better Auth, Node 24 e SQLite,
preparado para a VPS existente. Usar o fluxo de autorização de dispositivo do
Better Auth para conectar o desktop. Guardar o token no backend, fora da
webview, com as mesmas garantias de arquivo privado das integrações existentes.

A barra lateral mostra nome e menu da conta; sem conta, oferece cadastro
opcional. Cadastro, edição e exclusão acontecem no site responsivo. Conta do
Prometeu não seleciona conta de provider nem altera matrícula do time.

## Consequências

SQLite e um processo bastam para esta primeira etapa; não há Redis, fila ou
execução cloud. Escala horizontal exige reavaliar banco e coordenação. SMTP
habilita verificação e recuperação de conta e é requisito de produção.

O fluxo adiciona uma confirmação de código no navegador, mas evita senha no
desktop e redirects para portas locais. Tokens de sessão duram até 30 dias,
com renovação por atividade e revogação no servidor. Identidade em cache
permite manter a UI utilizável durante indisponibilidade do SaaS.

Persistir transcripts é uma etapa posterior. Esta decisão não altera a
fronteira de confiança do relay, não promete criptografia ponta a ponta e não
autoriza upload automático de conversas ao criar conta.

## Evidência

Ver [contrato da conta](../contracts/cloud-account.md), testes `cloud.rs` e
`e2e/cloud.spec.ts`, e a suíte HTTP do projeto `prometeu-cloud`.
