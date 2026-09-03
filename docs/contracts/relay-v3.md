# Relay protocol v3

Status: contrato atual.

A fonte executável deste contrato é `relay/src/protocol.ts`. Este documento
explica ownership e compatibilidade; não duplica todas as unions ou limites.

## Topologia

O frontend fala diretamente com o relay. O backend Rust guarda a configuração
local e executa ações autorizadas, mas não mantém o WebSocket do time.

Cada time é encaminhado a um Durable Object. O relay conhece membros, presença,
workspaces compartilhados, audiência, espectadores, notas e inbox.

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

O relay persiste o necessário para membros offline: cadastro, shares, notas e
inbox, sujeito a limites e TTL. Conteúdo de conversa ao vivo é encaminhado; a
sessão continua local.

O protocolo não oferece criptografia ponta a ponta. Operador do relay pode ler
metadados e conteúdo de texto que passa pelo serviço. Alterar essa propriedade
exige ADR de segurança e mudança incompatível de protocolo.

## Evidência

- `relay/src/protocol.test.ts`: parsing, limites, convites e frames binários;
- `relay/src/logic.test.ts`: audiência, presença, quotas, notas e routing;
- `relay/src/worker.integration.test.ts`: Worker/Durable Object real local;
- `src/team-transport.test.ts`: lifecycle e transporte do cliente;
- `src/team-control.test.ts`: transformação de controle remoto.
