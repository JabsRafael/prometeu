# Relay protocol v3

Status: contrato atual.

A fonte executável deste contrato é `relay/src/protocol.ts`. Este documento
explica ownership e compatibilidade; não duplica todas as unions ou limites.

## Topologia

O frontend fala diretamente com o relay. O backend Rust guarda a configuração
local e executa ações autorizadas, mas não mantém o WebSocket do time.

Cada time é encaminhado a um Durable Object. O relay conhece membros, presença,
workspaces compartilhados, audiência, espectadores, comentários e inbox.

## Autenticação

O convite `pm2`/protocolo v3 contém id do time e segredo de matrícula. Ao entrar,
o relay emite identidade e credencial individual. WebSockets usam a credencial
individual, nunca o segredo coletivo do convite.

Credencial prova identidade; não torna o conteúdo confiável para execução. Toda
entrada continua sujeita a parser, limites, audiência e validação no dono.

## Formatos

- controle usa frames de texto JSON com discriminante `t`;
- terminal e conversa ao vivo usam frames binários segmentados;
- `Up` descreve app → relay;
- `Down` descreve relay → app;
- parsers recebem `unknown` e só devolvem tipos depois de validar;
- limites de ids, textos, coleções, frame e taxa ficam junto do protocolo.

Adicionar variante exige parser, lógica pura, teste de protocolo e teste do
efeito de routing. Cliente deve recusar versão incompatível no handshake.

## Comentários persistentes

Comentários reutilizam a família histórica de frames `note` para manter
compatibilidade dentro do protocolo v3:

- `note` cria uma raiz com `ws`, `text`, `mentions`, `quote` e, quando houver
  contexto, `tab` e `anchor`;
- `note_reply` adiciona uma resposta a uma raiz aberta;
- `note_resolve` marca a raiz como resolvida e remove suas atribuições da inbox;
- `notes` devolve o snapshot do workspace;
- `note` no sentido relay → app funciona como upsert. Uma resolução repete o id
  da raiz com `resolved: true`.

O registro persistido tem `parent: null` na raiz e `parent: <id da raiz>` nas
respostas. Threads são planas no protocolo. Respostas herdam o workspace e a
aba da raiz. Dados antigos sem `tab`, `anchor`, `parent` ou `resolved` são
normalizados como comentário geral, raiz e aberto.

`tab` identifica a conversa. `anchor` identifica um `Piece.key` estável no
transcript daquela aba e tem limite de 128 caracteres. `quote` é contexto de
apresentação e fallback; não concede autoridade nem participa da execução do
agente.

Uma menção cria uma entrada de inbox apontando para a raiz. Respostas podem
atribuir a thread ao autor da raiz e a novos mencionados. Num relay com
`comments: 1`, abrir só navega para a thread; a entrada permanece até qualquer
colaborador com acesso resolver a raiz. O frame antigo `inbox_read` continua
aceito e o cliente o usa como fallback quando a capability não existe, pois
esse relay não oferece resolução.

A entrada de inbox guarda `id`, `ws`, `author` e `ts`; `tab` leva à conversa
correta e `text` permite mostrar a prévia antes de carregar a thread. Os dois
campos novos são opcionais para o storage e para clientes anteriores.

O `welcome` anuncia `comments: 1`. Sem essa capability, um cliente atual ainda
envia raízes simples para um relay v3 antigo, mas não oferece resposta ou
resolução e mantém a leitura como conclusão da inbox. Campos extras de uma raiz
são opcionais, portanto clientes antigos
continuam lendo o comentário como nota simples. Um cliente antigo pode exibir
uma resposta nova como item separado; isso é degradação visual, não perda de
dados nem aumento de autoridade.

## Snapshot e live stream

O dono obtém `{ text, seq }` do backend sob o lock de numeração. O snapshot é
segmentado em linhas inteiras para respeitar o limite de frame. O observador
descarta segmentos ao vivo com sequência já contida no snapshot e emenda o
restante.

A sequência pertence ao transporte atual e pode recomeçar quando o processo ou
app reinicia. Ela não é id global de mensagem.

## Autoridade

- o relay decide quem pode ver um share com base em `audience`;
- o dono é autoridade sobre o processo e o worktree;
- fala remota é encaminhada ao `chat_send` local;
- controle remoto é sanitizado em `chat_control_remote` contra pedido realmente
  aberto no buffer;
- colega não fornece comando ou input arbitrário para execução;
- dono offline significa sessão remota congelada.

## Persistência e privacidade

O relay persiste o necessário para membros offline: cadastro, shares,
comentários e inbox, sujeito a limites e TTL. A retenção remove uma thread como
unidade para não deixar respostas órfãs. Conteúdo de conversa ao vivo é
encaminhado; a sessão continua local.

O protocolo não oferece criptografia ponta a ponta. Operador do relay pode ler
metadados e conteúdo de texto que passa pelo serviço. Alterar essa propriedade
exige ADR de segurança e mudança incompatível de protocolo.

## Evidência

- `relay/src/protocol.test.ts`: parsing, limites, convites e frames binários;
- `relay/src/logic.test.ts`: audiência, presença, quotas, comentários e routing;
- `relay/src/worker.integration.test.ts`: Worker/Durable Object real local;
- `src/team-transport.test.ts`: lifecycle e transporte do cliente;
- `src/team-control.test.ts`: transformação de controle remoto.
