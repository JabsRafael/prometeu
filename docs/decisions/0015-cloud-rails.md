# ADR 0015 — SaaS em Rails com contrato desktop preservado

Data: 2026-09-06
Status: Aceito
Substitui a escolha técnica do [ADR 0014](0014-optional-cloud-account.md).

## Contexto

O mantenedor pediu explicitamente Rails, stack que conhece e já utiliza em
outros projetos. O protótipo Node/Better Auth estava preparado na VPS, mas
não publicado, sem usuários nem banco de produção. O cliente desktop já
possui um contrato pequeno de conexão pelo navegador.

## Decisão

O projeto separado `prometeu-cloud` usa Rails 8.1, Ruby 4.0, SQLite e ERB.
A autenticação parte do gerador nativo do Rails: `has_secure_password`,
sessões persistidas, cookies assinados, proteção CSRF e Action Mailer.
O site não precisa de SPA, Node no servidor, Redis ou processo de jobs.

Preservar as quatro rotas usadas pelo desktop: emissão e troca de código,
consulta da sessão e logout. `DeviceGrant` guarda somente o hash do código
privado, expira em 10 minutos e exige confirmação da pessoa autenticada.
Emissão do Bearer e consumo do código acontecem na mesma transação.
O banco armazena somente o hash do Bearer. Sessões expiram após 30 dias fixos;
renovação por atividade do protótipo anterior não é mantida.

Cadastro, edição e exclusão usam controllers e formulários Rails convencionais.
Os endpoints internos do site Better Auth não são mantidos, pois não existem
consumidores publicados. Os formatos de IPC, `cloud.json`, relay, board e
transcripts não mudam. Tokens de teste anteriores exigem reconexão.

## Consequências e rollback

O mantenedor pode evoluir o SaaS com suas ferramentas habituais. O pequeno
fluxo de dispositivo passa a ser código do projeto, coberto por testes de
contrato e concorrência. Criptografia e senhas usam primitivas Rails/Ruby/bcrypt.

SQLite e rate limiting em memória pressupõem um processo Puma. Escala
horizontal exige banco e limites compartilhados. Envio SMTP é síncrono com
timeout; uma fila durável só será necessária quando volume/retries justificarem.
SMTP e origem HTTPS são requisitos de produção.

Não há dados de produção para converter. A fonte Node fica preservada em
`prometeu-cloud-node-backup-20260906`, localmente e na VPS; a imagem anterior
permanece disponível. O Rails usa outro arquivo de banco. Nenhuma migração
destrutiva do banco anterior é executada. Futuras migrações exigem backup
consistente e rollback coordenado de imagem, banco e `SECRET_KEY_BASE`.

Esta decisão não implementa sincronização de transcripts, app mobile nativo,
comandos remotos nem mudanças na fronteira de confiança do relay.

## Evidência

Nota operacional de 2026-09-06: após a migração, o mantenedor pediu a remoção
do protótipo Node. A fonte local foi movida para a Lixeira do Mac; a cópia na
VPS e a imagem antiga foram excluídas. O rollback Node descrito acima registra
o estado inicial da decisão e não está mais preparado na VPS.

Ver [contrato da conta](../contracts/cloud-account.md), `cloud.rs`,
`e2e/cloud.spec.ts` e as suítes Rails de integração, concorrência e navegador
do projeto `prometeu-cloud`.
