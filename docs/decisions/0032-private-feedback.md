# ADR 0032 — Feedback privado no repositório do Cloud

Data: 2026-09-10
Status: substituído pelo [ADR 0033](0033-github-feedback-attachments.md). Substitui o [ADR 0031](0031-public-feedback.md).

## Contexto

Relatos e capturas podem conter dados pessoais ou código. O mantenedor escolheu
receber as issues no repositório privado `prometeucorp/prometeu-cloud`. Mudar
somente o destino da issue deixaria as imagens públicas no Cloud.

## Decisão

Criar issues somente em `prometeucorp/prometeu-cloud`, depois de verificar pela
API GitHub que o repositório mantém `private: true` e o nome esperado. Falha na
consulta ou repositório público impede o POST com o conteúdo do feedback.
O PAT continua no servidor, com Issues: write e acesso ao metadata do repositório.

A submissão continua sem login, mas retorna somente o recibo `{ id }`, sem URL
interna. O formulário informa tratamento privado e não oferece um link que quem
enviou não pode abrir. Não há publicação automática no repositório de releases.

Imagens permanecem no SQLite. A issue contém um link normal para o Cloud, sem
imagem embutida, URL assinada ou credencial. A rota exige sessão de navegador e
ID de usuário explicitamente autorizado em `FEEDBACK_REVIEWER_IDS`. Uma conta
comum, mesmo dona de sua própria organização, não pode consultar anexos.
Lista vazia nega acesso. Respostas não podem ser armazenadas em cache.

## Consequências

Quem envia não precisa de conta GitHub ou Prometeu. Revisores precisam de acesso
ao repositório privado e, para abrir imagens, login no Cloud e ID autorizado.
A lista de IDs é configuração operacional explícita; não há papel de suporte
implícito nem novo sistema de permissões por organização.

A exceção de upload no Cloud continua limitada à imagem escolhida pela pessoa.
Esse conteúdo é privado por controle de acesso, não E2EE: Cloud processa a imagem
e o texto, e GitHub processa a issue. Capturas devem ser revisadas antes do envio.

A tabela não muda. A antiga rota pública passa a exigir autorização, inclusive
para imagens antigas. Uma publicação pública anterior não pode ser desfeita por
esta mudança: operadores precisam remover issues e caches antigos separadamente.
Rollback não deve restaurar uma versão que sirva anexos publicamente.

## Evidência

`FeedbackTest` no Cloud cobre consulta de privacidade, envio no repositório
correto, recibo sem URL, usuário comum bloqueado, revisor autorizado, revogação,
cache desabilitado e falhas recuperáveis. `e2e/feedback.spec.ts` cobre o aviso
privado e confirmação sem link em Chromium e WebKit.

Contrato: [feedback](../contracts/feedback.md).
