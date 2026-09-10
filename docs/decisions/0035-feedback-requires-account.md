# ADR 0035 — Feedback exige conta Prometeu

Data: 2026-09-10
Status: aceito. Substitui o [ADR 0033](0033-github-feedback-attachments.md).

## Contexto

O ADR 0031 abriu o envio anônimo e os ADRs 0032 e 0033 mantiveram esse contrato
enquanto mudavam apenas o destino e o armazenamento. Nada disso chegou a rodar em
produção: `POST /api/feedback` nunca existiu no Cloud e o desktop recebia 404 em
cada tentativa, com o erro genérico de envio.

Criar issue no GitHub exige um token, e não existe criação anônima. Distribuir
esse token no cliente o entregaria a quem abrisse o binário, com escrita e
leitura no repositório privado. O intermediário é obrigatório.

Feedback é canal de produto do Prometeu, não formulário público. Quem envia deve
ser identificável para o time responder e para o canal não virar destino de spam.

## Decisão

`POST /api/feedback` exige sessão: o desktop envia o Bearer da conta conectada e
uma página do Cloud envia o cookie de sessão assinado. Sem sessão, 401. O limite
passa a ser por conta, cinco relatos por hora, no lugar do limite por IP e da
cota diária global.

O desktop entrega pelo backend Rust, no comando `feedback_send`, porque o token
da conta vive fora da webview desde o ADR da conta opcional. A webview monta o
relato e nunca vê a credencial.

Sem conta conectada, o painel troca o formulário por um aviso e pelo botão que
inicia a mesma autorização de dispositivo da barra lateral. O botão de feedback
continua visível: esconder o canal esconde também o caminho para usá-lo.

O endpoint deixa de responder CORS e preflight. O desktop chega sem `Origin` e a
página do Cloud é mesma origem; exigir `application/json` sem liberar CORS impede
que uma página de terceiros poste com o cookie de quem estiver logado.

O restante do ADR 0033 continua vigente: verificação de repositório privado,
upload nativo de anexo, issue com a imagem embutida, recibo `{ id }` sem URL
interna, idempotência por ID e nenhuma cópia de conteúdo no Cloud.

## Consequências

Quem não tem conta não envia feedback. O widget anônimo do site perde o canal:
o bundle continua existindo para páginas autenticadas do Cloud, e a landing
precisa de outra rota se quiser ouvir visitantes.

O time passa a saber de qual conta veio cada relato pela sessão da requisição.
Isso não entra na tabela: o recibo continua sem conteúdo, sem imagem e sem
identificação de pessoa. A associação existe apenas durante a requisição.

Reenvio depende do formulário preservado no cliente, como antes. O limite por
conta usa o cache em memória de um processo Puma; múltiplas réplicas exigem cache
compartilhado, igual aos demais limites do Cloud.

## Evidência

`FeedbackTest` no Cloud cobre 401 sem sessão, Bearer do desktop, cookie do
navegador, limite por conta, verificação do repositório privado, upload, issue
com marcador, idempotência, conflito, entrega incerta, ausência de conteúdo na
tabela e recusa de origem estranha.
[`e2e/feedback.spec.ts`](../../e2e/feedback.spec.ts) cobre o aviso sem conta, a
conexão a partir do painel, o rascunho preservado no erro e o reenvio do mesmo
relato.

Referências: [contrato](../contracts/feedback.md),
[conta opcional](../contracts/cloud-account.md).
