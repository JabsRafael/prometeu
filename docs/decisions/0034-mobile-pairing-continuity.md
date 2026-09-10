# ADR 0034 — Continuidade do pareamento móvel

Data: 2026-09-10
Status: Aceito. Substitui a reconexão obrigatória por lease do
[ADR 0021](0021-cloud-organizations.md) e especializa a autoria remota do
[ADR 0028](0028-mobile-web-app.md) para os dispositivos pessoais do
[ADR 0030](0030-remote-control.md).

## Contexto

Leases de 60 segundos encerravam sockets válidos continuamente. Celular e
compartilhamento passavam por desconexão, handshake e novos snapshots a cada
minuto. O pareamento pessoal também identificava mensagens do próprio usuário
como mensagens de colegas. O formulário móvel herdava altura mínima de 112px,
e conteúdo intrínseco de linhas de comando alargava o transcript.

## Decisão

Manter a janela de revogação de 60 segundos e renovar no socket identificado.
O relay anuncia `lease { expires_in }`; o cliente reutiliza o port de ticket
na metade do prazo e responde `renew { ticket }`. O Cloud autoriza novamente,
sem nova API nem credenciais permanentes no relay. Somente a mesma matrícula
na mesma organização pode renovar um socket ainda válido. Roster inalterado
não produz presença, anúncios ou snapshots. Clientes e relays antigos mantêm
o caminho anterior. Perda real de conexão continua usando backoff e snapshots.

O Mac encaminha texto original quando o remetente autenticado é um dispositivo
da própria pessoa. Colegas continuam identificados pelo prefixo do time.
Criptografia, consentimento de controle remoto e proteção contra replay
permanecem obrigatórios.

O shell móvel limita a largura das colunas do transcript e mantém rolagem
horizontal dentro de blocos de código e tabelas. O formulário usa controles
compartilhados de 44px, texto de 16px e crescimento limitado. A visual viewport
mantém o envio acima do teclado. Rascunho só é limpo após o envio cifrado sair
pelo socket; isso não representa confirmação de execução pelo Mac.

## Consequências e verificação

Não aumentamos a validade da autorização para esconder desconexões. Renovação
adiciona dois controles ao v4 e preserva a revogação sem webhook. Publicar relay
antes dos clientes permite ativação gradual e rollback de código sem migração.

`relay/src/worker.integration.test.ts` verifica renovação, watchers, expiração
e rejeição de tickets. `src/team-organizations.test.ts` verifica autoria,
continuidade e troca de organização. `e2e/mobile.spec.ts` exercita o shell real
com peer cifrado em Chromium e WebKit, larguras de 320/390px, teclado e falha
de envio sem perda de rascunho.
