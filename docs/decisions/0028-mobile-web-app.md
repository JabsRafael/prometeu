# ADR 0028 — Prometeu no celular como app web servido pelo Cloud

Data: 2026-09-08
Status: Aceito. Conclui a etapa 2 do [ADR 0026](0026-portable-collaboration-core.md)
sobre os dispositivos companheiros do [ADR 0027](0027-companion-devices.md).
Autoria de mensagens dos próprios dispositivos especializada pelo
[ADR 0034](0034-mobile-pairing-continuity.md).

## Contexto

O núcleo de colaboração já compõe sem Tauri e o Cloud já emite tickets de
companheiro. Faltava o cliente: uma página no celular que entra na sala da
organização, acompanha conversas compartilhadas, fala com o Mac do dono e
comenta. A sessão continua executando somente no Mac.

## Opções consideradas

1. **App nativo (iOS/Android).** Lojas, assinatura e uma segunda base de
   código para uma interface de leitura e resposta.
2. **Bundle construído dentro do Rails.** Exigiria Node e o checkout do
   Prometeu no build do Cloud; o Design System já evita isso vendendo assets.
3. **Bundle construído no Prometeu e vendido no Cloud.** Mesmo padrão do
   Design System: `npm run build:mobile` gera `dist-mobile/`, `bin/mobile`
   copia para `vendor/mobile/assets` com manifesto de hashes.

## Decisão

Opção 3. `src/mobile/` é a raiz de composição do navegador:

- `shell.ts`: ports puros. ID de companheiro gerado uma vez por navegador,
  `SecurityStore` sobre `localStorage`, `Membership` com o mesmo escopo de
  cifra do desktop (`["organization", origem do Cloud, organização]`) e
  `url()` que pede o ticket em `POST /orgs/:slug/companion-ticket` com CSRF
  e monta a mesma URL de sala que `src-tauri/src/cloud.rs`.
- `main.ts`: registra `team-comments` e `team-viewer` no membro; sem dono.
- `view.ts`: lista de conversas compartilhadas, transcript pelo reducer
  `timeline.ts`, composer que envia `write` ao dono, comentários e inbox.
  Reutiliza `markdown.ts`, `chat-presentation.ts` e o Design System.

O Cloud serve `GET /app` com layout próprio para sessão de navegador,
renderiza no elemento raiz a origem canônica, o usuário e as matrículas, e
libera o relay em `connect-src`. `GET /app/manifest` torna a página
instalável. Login redireciona de volta para `/app`.

Este bundle não cria conversas, não executa Git e não responde cartões de
permissão; para isso continua sendo preciso o Mac. Entrada remota chega ao
agente como mensagem assinada com o nome da pessoa, como já acontece entre
colegas no desktop.

## Consequências

- Duas cópias do mesmo código no Cloud (bundle vendido) e no Prometeu (fonte).
  `bin/mobile --check` acusa divergência; a versão vem do `package.json`.
- A identidade privada fica em `localStorage` como JWK, o mesmo esquema de
  `team-security.json`. Limpar o armazenamento do navegador cria outro
  dispositivo. Endurecer com `CryptoKey` não extraível em IndexedDB é um
  passo separado, anotado no código.
- O celular só vê workspaces compartilhados por outra pessoa ou pelo próprio
  Mac, com o Mac acordado, o app aberto e Cloud e relay disponíveis.
- `src/mobile/*` não importa Tauri, IPC, o shell desktop nem `chat.ts`;
  `npm run architecture:check` protege essa fronteira.
- Extração para `packages/team-core` continua adiada: o bundle importa os
  arquivos de `src/` diretamente e o Cloud só recebe o artefato.

## Evidência

- `src/mobile/shell.test.ts`: identidade estável, URL de sala igual à do
  desktop, ticket com CSRF, escolha de organização.
- `src/team-member.test.ts`: composição sem Tauri sobre o relay simulado.
- `prometeu-cloud/test/integration/mobile_test.rb`: login obrigatório,
  matrículas embutidas, CSP com relay, manifesto.
- `prometeu-cloud/test/browser/mobile.spec.js`: entrada pelo navegador,
  lista da organização, registro do companheiro, sem erros de script.
