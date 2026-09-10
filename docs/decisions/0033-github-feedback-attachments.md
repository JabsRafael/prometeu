# ADR 0033 — Texto e imagens de feedback no GitHub

Data: 2026-09-10
Status: substituído pelo [ADR 0035](0035-feedback-requires-account.md), que passou a
exigir conta no envio. Substitui o [ADR 0032](0032-private-feedback.md).

## Contexto

O mantenedor quer consultar texto e captura na mesma issue privada. Armazenar
anexos no Cloud exigia outro login, uma lista de revisores e retenção de imagens.
GitHub oferece upload nativo de imagens associado ao repositório, usado pelo
GitHub CLI 2.99.0, com acesso controlado pelas permissões do repositório.

## Decisão

O Cloud continua como intermediário para manter o PAT fora dos clientes anônimos.
Após confirmar privacidade e identidade de `prometeucorp/prometeu-cloud`, envia
os bytes ao endpoint nativo `uploads.github.com/user-attachments/assets`, com o
ID numérico do repositório. Só cria a issue depois de receber uma URL válida,
embutida no corpo como imagem Markdown. Usa `Net::HTTP` já presente na integração;
não instala CLI ou outra dependência.

Texto e imagem não são persistidos no Cloud. A tabela conserva somente recibos:
ID, SHA-256 do conteúdo, URLs GitHub, instante da tentativa e timestamps. Isso
preserva idempotência e impede repetir automaticamente uma criação incerta.
A rota de imagens, o desvio de login e `FEEDBACK_REVIEWER_IDS` são removidos.
O contrato anônimo `POST /api/feedback`, os limites e o recibo `{ id }` permanecem.

## Consequências

Revisores precisam somente de acesso ao repositório privado. Remoção de conteúdo
ocorre no GitHub, sem cópias de imagens ou descrições nos backups Cloud.
O Cloud ainda processa conteúdo durante a requisição; esse fluxo não é E2EE.

Falha de upload impede criar uma issue sem o anexo escolhido. Retry reutiliza a
URL já salva; interrupção antes de salvar a URL pode deixar um anexo sem issue.
Resultado incerto da criação exige reconciliação pelo marcador `Feedback: <id>`.
Como não há cópia no servidor, reenvio depende do formulário preservado no cliente.

O endpoint de upload acompanha a implementação oficial do GitHub CLI; mudanças
nesse serviço exigem atualizar o adapter. O PAT escolhido precisa de validação
no smoke de ativação; testes locais substituem o transporte e não publicam conteúdo.

A migração anterior ainda não foi publicada e foi ajustada para criar recibos.
Não existem relatos de produção a migrar. Bancos locais do protótipo são
preservados; testes usam banco descartável novo. Rollback não deve restaurar
armazenamento de conteúdo ou rota pública de anexos.

## Evidência

`FeedbackTest` no Cloud cobre upload privado, imagem embutida, recibo sem conteúdo,
rota removida, limites, idempotência, rejeição de upload e criação, retry e falha
ambígua. Clientes continuam com o contrato coberto por `e2e/feedback.spec.ts`.

Referências: [contrato](../contracts/feedback.md),
[upload oficial](https://github.com/cli/cli/blob/v2.99.0/internal/attachments/client.go),
[privacidade de anexos](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files).
