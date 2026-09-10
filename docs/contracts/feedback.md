# Feedback privado

Status: implementado no desktop e nos bundles para site/Cloud. A ativação em
produção depende de publicar os consumidores e configurar a credencial GitHub.
Decisão: [ADR 0033](../decisions/0033-github-feedback-attachments.md).

O widget oferece Problema, Ideia e Outro, descrição, uma imagem opcional e
captura iniciada pela pessoa. O formulário informa que o relato será tratado
em privado pela equipe Prometeu e pede revisão de dados sensíveis antes do envio. Nenhum transcript, caminho de workspace, email, credencial ou
URL de navegação é coletado automaticamente. Capturas podem conter esses dados:
a pessoa revisa a miniatura e pode remover ou substituir a imagem.

## HTTP

`POST /api/feedback` no Cloud aceita JSON sem cookies ou Bearer:

```json
{
  "id": "2c65b70e-80a8-408d-8831-18346584fee4",
  "kind": "problem",
  "source": "desktop",
  "version": "0.6.1",
  "description": "A janela não abre.",
  "image": { "type": "image/png", "data": "base64" }
}
```

`id` é UUID v4. `kind` aceita `problem`, `idea`, `other`; `source` aceita
`desktop`, `site`, `cloud`. Descrição obrigatória tem até 4.000 caracteres;
versão opcional, até 40. Imagem opcional aceita PNG, JPEG ou WebP até 5 MiB,
com base64 estrito e assinatura compatível. Corpo completo tem limite de 7 MiB,
aplicado antes do parser Rails. `OPTIONS /api/feedback` oferece preflight.
CORS permite somente origens Prometeu, Tauri e loopback explícito em desenvolvimento.
Credenciais da conta não participam da entrega.

Sucesso: `201 { id }`. A URL da issue privada permanece no servidor. O cliente
mostra confirmação sem link para o repositório interno.
Erros: 400/415 para formato; 413 para tamanho; 422 para conteúdo inválido;
409 para reutilização de ID com conteúdo diferente ou entrega incerta;
429 para limite de frequência; 503 para serviço/credencial indisponível.
Nenhum erro limpa o formulário. Nova tentativa do mesmo conteúdo usa o mesmo ID.

O Cloud encaminha texto e imagem ao GitHub, sem persistir esse conteúdo.
A tabela `feedbacks` guarda somente ID, SHA-256 do conteúdo, URLs GitHub do
anexo e da issue, instante da tentativa de criar a issue e timestamps.
Um ID concluído devolve o mesmo recibo sem criar outra issue. Conteúdo diferente
com o mesmo ID recebe 409, inclusive quando muda somente a imagem.

Antes de enviar qualquer conteúdo, `GET /repos/prometeucorp/prometeu-cloud`
deve confirmar `private: true` e o nome esperado. Falha de consulta ou repositório
público retorna 503. A imagem usa o ID numérico dessa resposta em
`POST https://uploads.github.com/user-attachments/assets?name=...&content_type=...&repository_id=...`:
bytes binários, `Content-Type: application/octet-stream`, Bearer do servidor.
Esse é o endpoint usado pelo [GitHub CLI 2.99.0](https://github.com/cli/cli/blob/v2.99.0/internal/attachments/client.go).
A resposta deve conter uma URL `https://github.com/user-attachments/assets/<uuid>`.
Ela entra como imagem Markdown no corpo da issue; texto e imagem são vistos no
GitHub, com as permissões do repositório privado. Não existe rota de anexos nem
lista de revisores no Cloud. Não há dependência do executável `gh` no servidor.

`FEEDBACK_GITHUB_TOKEN` fica exclusivamente no Cloud, com Issues: write limitado
a `prometeucorp/prometeu-cloud`. O dono do PAT precisa de acesso de escrita ao
repositório para anexar imagens. O cliente nunca recebe essa credencial.
O endpoint anônimo devolve somente recibo, sem texto, imagem ou URL interna.
Limites: 5 envios/hora/IP e 200/dia no total. Contadores e mutex assumem um único
processo Puma; múltiplas réplicas exigem coordenação compartilhada.

Falha de upload impede criar a issue. Nova tentativa preserva o formulário e
reutiliza uma URL de anexo já registrada, se houver. Interrupção antes de receber
ou salvar a URL pode deixar um anexo sem issue no GitHub e exigir novo upload.
Um POST de criação interrompido pode ter sido aceito: o Cloud preserva o recibo
e responde `409 { error: "uncertain", id }`, sem repetir esse POST automaticamente.
O operador pesquisa `Feedback: <id>` no GitHub e reconcilia `issue_url` no recibo.
Somente após confirmar ausência da issue pode limpar `attempted_at` e permitir
reenvio do formulário. Não existe cópia de conteúdo no Cloud para reprocessamento.

Remoção de relatos e imagens ocorre no GitHub. Backups Cloud contêm somente
recibos, sem texto ou imagem. O conteúdo é privado por controle de acesso,
não E2EE; Cloud processa a requisição e GitHub armazena o conteúdo.

## Captura e interface

`feedback_capture`, sem argumentos, é IPC aditivo: retorna PNG em base64 ou
`null` ao cancelar. No Mac, `screencapture -i -W` permite selecionar a janela;
o arquivo fica em diretório temporário privado e é removido ao terminar.
Falhas usam i18n. O mock devolve uma imagem fictícia; não captura o computador.

No site/Cloud, `getDisplayMedia` oferece seleção de superfície quando disponível.
As tracks são encerradas após a captura, inclusive em erro. Navegadores sem essa
API conservam o upload. O widget fica oculto durante a captura, volta com
miniatura e nunca envia automaticamente.

A composição portátil em `packages/design-system/src/feedback.ts` recebe textos
e callbacks. O cliente em `src/feedback-client.ts` possui transporte e retry.
O popover manual usa a top layer; dentro de um modal, muda para esse modal para
continuar interativo. Escape fecha primeiro o widget. No desktop, o botão “Feedback” fica à direita no rodapé da barra lateral; o painel
abre acima desse rodapé somente após o clique. O preview Run nativo usa toda sua
área e fica oculto enquanto o painel está aberto.

`npm run build:feedback` produz `dist-feedback/feedback.js` e `feedback.css`.
O site importa ambos em `feedback/`; o Cloud importa ambos em
`app/assets/feedback/`. Os consumidores versionam os arquivos gerados e os servem
localmente. Tokens do bundle ficam no widget, preservando os tokens da página.

## Compatibilidade e evidência

Migração SQLite aditiva; estado do desktop, transcripts, conta e relay não mudam.
O protótipo anterior de feedback não foi publicado. Sua migração foi ajustada
antes da publicação para criar somente recibos, sem colunas de conteúdo.
Bancos locais do protótipo não são migrados ou apagados automaticamente; testes
usam banco novo e descartável. O contrato `POST /api/feedback` e o recibo `{ id }`
continuam iguais. Bundles existentes permanecem compatíveis.
Claude e Codex usam a mesma interface; seus CLIs não participam da entrega.

- [`e2e/feedback.spec.ts`](../../e2e/feedback.spec.ts): erro recuperável, retry,
  upload, miniatura, captura simulada, modal e viewport estreito em Chromium/WebKit.
- Testes `FeedbackTest` do Cloud: limites, CORS, assinatura, criação, idempotência,
  falha ambígua, privacidade do repositório, upload nativo, retry e ausência de
  conteúdo no SQLite; GitHub substituído por transporte em memória.
- Captura nativa, permissões do macOS e entrega GitHub real exigem smoke manual.
  Os testes não publicam issues nem capturam dados pessoais.
