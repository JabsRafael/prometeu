# Relay protocol v4

Status: contrato atual; decisão no [ADR 0022](../decisions/0022-end-to-end-encryption.md).
Fonte executável: `relay/src/protocol.ts`, importada pelo app e pelo Worker.
O [v3](relay-v3.md) permanece documentado como histórico.

## Fronteira e autenticação

A webview cifra e decifra; o Rust persiste a identidade privadamente e executa
somente ações autorizadas. O relay encaminha ciphertext, mantém audiência,
quotas, presença, comentários e inbox. O agente continua no Mac do dono.

Matrícula `pm2`, credenciais individuais e tickets Cloud mantêm seus formatos.
O WebSocket exige `p=4`. `welcome` anuncia `e2ee: 1`, `comments: 1` e um desafio
aleatório por socket. Antes de qualquer outro envio, o cliente responde
`identity { key, proof }`. A prova é ECDSA P-256/SHA-256 sobre o JSON UTF-8
`["prometeu-identity-v4", member, challenge]`, usando a identidade privada.
O Worker verifica posse antes de publicar `Member.key` ou permitir tráfego.
A presença com a chave confirmada termina o handshake. O Worker não envia
outras atualizações para um socket ainda não identificado.

O diretório é TOFU: o cliente grava o primeiro vínculo membro/chave antes do
uso. Mudanças ficam bloqueadas até aceitação local explícita. Chaves ausentes
não recebem conteúdo e não apagam vínculos. Renovar tickets não redefine TOFU.
Veja [organizações](cloud-organizations.md) para leases e autorização Cloud.

Depois da identidade, sockets de organizações recebem `lease { expires_in }`
(1 a 60.000 ms). `renew { ticket }` consome outro ticket Cloud de 256 bits,
codificado em 43 caracteres base64url, e exige organização e membro originais.
O relay recusa renovação antes da identidade, após expiração ou com ticket
inválido, consumido ou de outra matrícula. Uma renovação preserva chave, desafio,
watchers e streaming; roster idêntico não gera presença. A confirmação é outro
`lease`. São controles aditivos no v4: clientes antigos ignoram a capacidade,
e clientes novos continuam reconectando quando um relay antigo não a anuncia.

## Envelope e conteúdo

`Encrypted = { id, boxes: { [member]: { enc, ct } } }`. IDs são aleatórios,
`enc` e `ct` usam base64url canônico sem padding. Cada caixa usa HPKE Auth,
DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. O `info` vincula o JSON
`["prometeu-e2ee-v4", scope, author, recipient, id]`. `scope` é o JSON de
`["organization", cloudOrigin, organizationId]` ou `["team", relayOrigin, teamId]`.
A chave do autor vem do vínculo local, nunca de um campo livre do envelope.

O plaintext contém `{ frame: Up }` ou `{ binary: base64url }`. `share` inclui
`revision`, monotônica e persistida pelo dono. `write` inclui `expires`, no
máximo dois minutos à frente. O cliente valida novamente o payload após abrir
a caixa e confere workspace, aba, autor, destinatário e audiência.

No frame externo:

- `share`: títulos, repositório, branch e etapa vazios; issue nula; texto e
  tokens de abas nulos/vazios e status constante. IDs, aba ativa, dimensões e
  audiência explícita continuam visíveis. `audience: null` é expandida para
  membros com chave disponível antes de cifrar.
- `note`/`note_reply`: texto vazio; citações e âncoras nulas. O ID persistido é
  o ID do envelope, único no time. Menções e parentesco permanecem visíveis.
- `note_resolve`: envelope autentica workspace e raiz. Storage conserva o
  ciphertext original e acrescenta `resolution: { author, encrypted }`.
- `write`: dados vazios, envelope somente para o dono.
- Binário: envelope via frame `SNAPSHOT` unicast externo, sequência zero e
  `more=false`. A caixa contém o frame binário original completo, inclusive
  kind, sequência e destino. O destinatário só aceita sua aba anexada.

`room.ts` recusa campos de conteúdo em claro, envelopes inválidos e binário
legado. Parsers de domínio ainda aceitam payloads em claro para validação
interna após decifrar; isso não autoriza o Worker a recebê-los no socket.
`downForMember` envia somente a caixa daquele membro, inclusive nos agregados
`welcome`, `notes` e `inbox`. Não há chaves privadas no relay.

## Autoridade e replay

O dono usa seu board para autorizar snapshot, live e fala recebida. Um anúncio
ecoado pelo relay não altera a audiência local. Para shares remotos, o cliente
persiste dono, chave, revisão e ID do último anúncio aceito; rejeita troca de
dono e revisões antigas, permitindo repetir o mesmo anúncio na reconexão.
Após aceitação manual de uma chave nova, a sequência daquele dono pode reiniciar.

Falas remotas persistem ID e prazo antes de executar. Repetição, expiração,
falha de gravação e relógio anterior ao último consumo bloqueiam a ação. Os
recibos sobrevivem à reconexão e ao reinício. A validação local de cards
continua obrigatória. Sequências de conversa tratam duplicatas de snapshot/live;
o relay ainda pode omitir conteúdo ou apresentar histórico incompleto.

Uma fala autenticada de um companheiro cujo `person` é o dono da conversa
chega ao agente com o texto original, como fala da própria pessoa. Colegas e
times legados conservam o prefixo de autoria pelo time. Essa distinção usa o
roster autorizado, nunca o nome ou um campo enviado livremente na mensagem.

Comentários de colegas usam a última audiência autenticada que receberam.
Omissão de uma atualização pelo relay pode atrasar revogação nesses remetentes.
Conteúdo já recebido e snapshots previamente autorizados não são revogáveis.

## Dispositivos companheiros

`Member.person` é opcional e liga um dispositivo companheiro à matrícula da
pessoa; membros primários e times legados não o têm. O Cloud entrega o campo
no roster e o relay o valida (ID existente no mesmo roster, sem cadeias),
persiste em `member:` e reemite em `welcome` e `presence`. Parsers antigos
ignoram o campo.

Audiências, `share.audience` local e menções nomeiam pessoas. Antes de cifrar,
o cliente expande cada pessoa nos seus dispositivos com chave: as caixas, a
audiência publicada no relay e as `mentions` do frame passam a listar
dispositivos, de modo que o relay aplica `watch`, `attach`, `write` e inbox
por dispositivo sem conhecer a regra. O dono admite `watch` e `write` de um
dispositivo pela pessoa a que ele pertence. TOFU, recibos e códigos de
segurança continuam por dispositivo. Decisão e limites no
[ADR 0027](../decisions/0027-companion-devices.md).

Dispositivos companheiros do dono entram nos destinatários somente quando o
`Workspace.remote_control` local está ativo. Essa permissão não atravessa o
protocolo: o frame externo já contém audiência explícita por dispositivo. Uma
audiência local vazia permite um share destinado somente aos dispositivos do
dono. Veja o [ADR 0030](../decisions/0030-remote-control.md).

## Persistência, limites e compatibilidade

Credenciais e metadados de matrícula preservam suas chaves de storage. Estado
de colaboração v4 usa prefixo `v4:`; somente esse prefixo é hidratado. Dados
v3 permanecem preservados e invisíveis ao novo cliente. Compartilhamentos
locais já consentidos são anunciados cifrados ao reconectar. Comentários antigos
não são convertidos nem redistribuídos automaticamente.

Limites ficam no protocolo: até 64 membros, JSON de entrada de 2 MiB, binário
de 1 MiB, agregados de saída de 16 MiB e 16 MiB por janela de 10 segundos.
Cada caixa possui limite de 1 MiB de texto cifrado. A fila criptográfica do app
é limitada a 16 MiB. Snapshots usam partes de 128 Ki caracteres, com limites
binários conferidos após a expansão. TTL de comentários continua 90 dias,
com retenção de threads e quotas de contagem existentes. Ciphertext persistido
é limitado a 1536 KiB por share/comentário (incluindo resolução), 4 MiB no
conjunto de shares e 8 MiB no conjunto de comentários por time. A inbox guarda
somente a caixa do próprio destinatário. Esses limites contêm expansão por
destinatário e deixam margem para metadados abaixo do limite de linha do
[storage SQLite do Durable Object](https://developers.cloudflare.com/durable-objects/platform/limits/).

V3 e v4 não negociam downgrade. Publicar Worker compatível precede distribuir
o desktop. Um rollback v3 conserva dados v4, mas restaura conteúdo em claro
na colaboração v3; veja os limites e a operação no ADR 0022.

## Evidência

`team-crypto.test.ts`, `team-security.test.ts` e `team-channel.test.ts` verificam
a fronteira do cliente com criptografia real. `protocol.test.ts` e
`logic.test.ts` verificam contratos e regras do relay. O Worker local real é
exercitado em `relay/src/worker.integration.test.ts`, e o mock web usa o mesmo
canal cifrado para os fluxos E2E. Não houve auditoria de segurança independente.
`team-organizations.test.ts` cobre renovação no mesmo socket, descarte após troca
de organização e autoria de companheiros; o Worker real cobre expiração e
rejeição de tickets de renovação inválidos.

## Bounded HTTP bodies

`/init` and `/enroll` use `relay/src/http.ts::smallJson` with a 1,024-byte body
limit. The helper counts bytes as the body arrives and cancels the reader as
soon as the limit is exceeded, even without `Content-Length` or when that header
understates the body. An oversized declared length is rejected before reading.
Incremental UTF-8 decoding preserves characters split across chunks. Invalid
JSON returns 400; oversized input returns 413. Endpoint schemas, authentication,
and the v4 WebSocket encryption requirements remain unchanged.

`http.test.ts` covers cancellation, inaccurate headers, malformed JSON, and
UTF-8 chunk boundaries; the Worker integration test covers streamed enrollment.
