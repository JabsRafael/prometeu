# ADR 0031 — Feedback público pelo Cloud e GitHub Issues

Status: substituído pelo [ADR 0032](0032-private-feedback.md).

## Contexto

A [sugestão de widget](https://github.com/prometeucorp/prometeu-releases/issues/2)
pede feedback no app e no site, com texto, imagem e captura. A pessoa não deve
precisar configurar uma ferramenta de gestão nem disponibilizar credenciais GitHub.
O repositório de releases já recebe sugestões públicas.

## Decisão

Usar um widget portátil com controles do Design System, um endpoint público no
Cloud e criação de issues no repositório de releases. A credencial de integração
permanece no servidor. Não introduzir Linear para receber estes relatos.

Somente o texto digitado e a imagem escolhida são enviados, junto de tipo,
origem e versão. Publicidade do conteúdo fica explícita antes do envio. Capturas
exigem ação da pessoa e revisão da miniatura; não são telemetria automática.
Essa é uma exceção explícita à ausência de upload no Cloud, limitada ao feedback,
e não altera os canais E2EE de colaboração.

O Cloud persiste o relato antes de chamar GitHub. ID de envio evita repetição
após resposta perdida. Resultado ambíguo é preservado para reconciliação operacional,
sem repetir um POST possivelmente aceito. Imagens usam a mesma persistência SQLite,
com uma rota pública limitada ao arquivo escolhido.

## Consequências

Não há nova dependência ou conta exigida para quem envia. O servidor precisa de
credencial com Issues: write e passa a guardar imagens explicitamente públicas.
Configuração e publicação operacional são necessárias para ativar a entrega.

Rate limiting e mutex locais acompanham o único processo Puma atual. Antes de
escalar horizontalmente, será necessário compartilhar ambos. O fluxo não inclui
portal de suporte, notificações próprias ou triagem automática por modelos.

Contrato, retenção, falhas e testes: [feedback](../contracts/feedback.md).
