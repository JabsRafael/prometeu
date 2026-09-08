# ADR 0026 — núcleo de colaboração portável e acesso pelo celular via relay

Data: 2026-09-08
Status: Aceito para o núcleo portável, implementado nesta mudança. A etapa de
identidade por dispositivo foi decidida no [ADR 0027](0027-companion-devices.md)
como campo aditivo no v4, sem protocolo v5. O app web servido pelo Cloud foi
decidido e implementado no [ADR 0028](0028-mobile-web-app.md).
Amplia o [ADR 0021](0021-cloud-organizations.md) e o
[ADR 0022](0022-end-to-end-encryption.md); não altera o
[relay v4](../contracts/relay-v4.md).

## Contexto

O produto quer acompanhar e cutucar uma conversa a partir do celular. A
sessão continua executando somente no Mac do dono; o relay já encaminha
ciphertext para qualquer membro autorizado, e a criptografia usa WebCrypto.
Em tese, um navegador no celular é apenas outro membro do relay.

Na prática, `src/team.ts` concentrava em um arquivo três papéis distintos:
a configuração do desktop (team.json, organizações do Cloud, IPC do Tauri),
o papel de dono (anunciar workspaces, transmitir a conversa, executar entrada
remota no agente local) e o papel de membro (identidade, presença, assistir,
comentar, inbox). Um cliente móvel construído sobre esse arquivo nasceria com
condicionais por plataforma espalhadas pelo fluxo.

Há ainda um limite do modelo de identidade: o relay guarda uma chave por
membro e o dono não cifra caixas para si mesmo. Um celular com a mesma
matrícula substituiria a chave do Mac e não receberia conteúdo.

## Opções consideradas

1. Compartilhar tela do Mac (VNC/Tailscale): zero código, sem produto.
2. Servir a interface do desktop a partir do Mac por Tailscale, com IPC sobre
   WebSocket: interface completa, mas exige rede privada e Mac acordado, sem
   comentários persistidos nem colegas.
3. PWA servido pelo `prometeu-cloud` conectando ao relay como membro comum,
   sobre um núcleo de colaboração sem dependência de Tauri.

## Decisão

Adotar a opção 3 em etapas. Esta mudança entrega a primeira: o núcleo.

**Divisão por papel e por feature, não por plataforma.** `src/team-member.ts`
possui a conexão reconectável, o handshake de identidade, a fila cifrada e o
diretório de membros. Cada capacidade é um módulo com hooks registrados no
membro (`connecting`, `outgoing`, `frame`, `binary`, `closed`, `reset`),
definidos em `src/team-ports.ts`:

- `team-owner.ts`: anúncios, snapshots, live e entrada remota. Só a máquina
  que executa agentes o instala.
- `team-viewer.ts`: shares remotos, attach, espelho e `write`.
- `team-comments.ts`: threads, menções e inbox.

O membro chama os hooks na ordem de registro; a raiz de composição escolhe as
features e essa ordem. Uma feature nova é um arquivo novo e uma linha em cada
raiz que a queira. Frames que nenhuma feature trata são ignorados. O gate de
saída (`outgoing`) permite ao dono bloquear conteúdo durante troca de audiência
sem que o membro conheça audiência.

**Ports em vez de condicionais.** O shell entrega ao membro uma `Membership`
(escopos, `shareScope`, `legacy` e uma função `url()` que obtém ticket ou
credencial) e um `SecurityStore`. O dono recebe um `OwnerHost` com as ações
locais. `src/team.ts` passa a ser o shell do desktop: resolve team.json e
organizações, injeta os ports do Tauri, registra as três features e expõe a
fachada usada pela interface, inclusive a tradução entre IDs do quadro e IDs do
relay. Nenhum `team-*.ts` importa `@tauri-apps`, `./ipc`, `./mock` ou
`./team`; `npm run architecture:check` falha se isso mudar.

**Sem pacote ainda.** O núcleo continua em `src/team-*.ts`. Quando existir o
segundo consumidor real (o PWA), os arquivos vão para `packages/team-core` por
`git mv`, no padrão de `packages/design-system`. Criar o pacote antes disso só
acrescentaria build.

## Etapas propostas

1. **Identidade por dispositivo** (novo ADR, contrato v5). O membro do relay
   passa a ser um dispositivo; o roster do Cloud devolve `{ id, name, person }`
   e emite tickets por dispositivo. A audiência escolhe pessoas; o dono expande
   pessoa em chaves de dispositivo no mesmo ponto onde hoje expande
   `audience: null`. TOFU permanece por dispositivo.
2. **PWA em `prometeu-cloud`.** Raiz de composição com `member` + `viewer` +
   `comments`, `SecurityStore` sobre IndexedDB com `CryptoKey` não extraível
   e `url()` sobre a sessão por cookie. O Rails ganha um endpoint de ticket
   por sessão, com a mesma resposta do Bearer. Sem feature de dono.

## Consequências

- O comportamento do desktop não muda; os testes existentes passam pela
  fachada sem alteração. Duas diferenças deliberadas: falha ao carregar
  `team-security.json` não entra em retry (era retry só no Cloud), e ao
  desconectar por escolha o estado de anúncios é limpo como em queda de rede.
- O celular só verá workspaces compartilhados explicitamente, com o Mac
  acordado, o app aberto e Cloud e relay disponíveis. Não cria conversas nem
  executa Git.
- Comentários e inbox vêm de graça para qualquer shell que registre
  `team-comments.ts`.
- A ordem de registro é contrato: dono antes de comentários mantém `share`
  antes de `notes` após o welcome.

## Evidência

- `src/team-member.test.ts`: composição sem Tauri com membro, viewer e
  comentários sobre o relay simulado, assistindo um share e respondendo a uma
  menção.
- `src/team.test.ts` e `src/team-organizations.test.ts`: comportamento do
  desktop preservado pela fachada.
- `scripts/check-architecture.mjs`: fitness function da fronteira do núcleo.
