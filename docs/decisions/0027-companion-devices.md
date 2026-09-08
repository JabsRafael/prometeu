# ADR 0027 — dispositivos companheiros no relay

Data: 2026-09-08
Status: Aceito. Decide a etapa 1 proposta no [ADR 0026](0026-portable-collaboration-core.md)
com um campo aditivo no [relay v4](../contracts/relay-v4.md), em vez de um
protocolo v5. Amplia o [ADR 0021](0021-cloud-organizations.md) e o
[ADR 0022](0022-end-to-end-encryption.md).

## Contexto

Um celular precisa entrar na sala do relay com chave própria. O relay guarda
uma chave por membro e o dono não cifra caixas para si mesmo; um navegador com
a mesma matrícula substituiria a chave do Mac e não receberia conteúdo. Ao
mesmo tempo, a identidade do Mac precisa continuar estável: trocar o ID do
membro invalidaria vínculos TOFU e tornaria comentários antigos ilegíveis.

## Opções consideradas

1. **Várias chaves por membro.** Muda o envelope (`boxes` por chave) e o TOFU
   deixa de detectar substituição sem assinatura cruzada entre dispositivos.
2. **Todo membro vira dispositivo (v5).** Migra a identidade do Mac, exige
   ID de dispositivo estável através de relogins e reescreve a persistência.
3. **Dispositivo companheiro como membro adicional.** O Mac mantém a
   matrícula como identidade; navegadores entram como membros próprios ligados
   à pessoa por um campo `person` no roster.

## Decisão

Opção 3. O Cloud passa a ter `Companion`: um navegador de uma pessoa, com
`relay_id` gerado pelo próprio navegador ao lado da identidade privada, rótulo
e `last_seen_at`. `POST /orgs/:slug/companion-ticket`, autenticado por cookie
e CSRF, registra ou reencontra o companheiro e emite um ticket ligado a ele.
`POST /api/relay/authorize` devolve `member` igual ao ID do companheiro e o
roster com `{ id, name, person }` para cada dispositivo. Tickets de desktop
continuam identificando a matrícula; tickets de companheiro exigem sessão de
navegador.

`Member.person` é opcional e aditivo no v4. Parsers antigos ignoram o campo e
veem o companheiro como um membro a mais. O relay valida que `person` aponta
para um membro primário do mesmo roster, sem cadeias, e persiste o campo.

No cliente, audiências e menções continuam nomeando pessoas. O canal cifrado
expande cada pessoa nos seus dispositivos ao escolher destinatários das caixas,
na audiência publicada no relay e nas menções. O dono admite um dispositivo
pela pessoa a que pertence ao validar `watch` e `write`. A interface escolhe
audiência e menções entre pessoas (`people()`), enquanto a lista de segurança
mostra cada dispositivo com seu código, porque o vínculo TOFU é por chave.

O roster do Cloud mantém os 64 membros do relay: pessoas sempre entram; os
companheiros ocupam as vagas restantes por ordem de uso recente. Cada pessoa
guarda no máximo cinco companheiros; o mais antigo sai ao registrar outro.
Remover o dispositivo nas configurações da conta o tira do roster; conteúdo
novo deixa de ser cifrado para ele em até 60 segundos, e comentários que ele
escreveu deixam de ser legíveis para os outros, como acontece com membros
removidos.

## Consequências

- Nenhuma migração de identidade no desktop. Vínculos, comentários e
  audiências existentes continuam válidos.
- Times legados por segredo compartilhado não têm `person`; cada navegador ali
  seria uma matrícula própria, como hoje.
- Cada destinatário custa uma caixa; uma organização de 64 pessoas não tem vaga
  para companheiros. Subir esse limite exige envolver o conteúdo com uma chave
  por mensagem em vez de uma cópia por caixa, o que é outra revisão do
  envelope e de segurança.
- O TOFU de um companheiro é por dispositivo. Limpar o armazenamento do
  navegador cria um dispositivo novo; o antigo fica no roster até sair por
  idade ou remoção manual.
- O navegador ainda não existe: esta decisão entrega Cloud, relay e cliente
  prontos para recebê-lo (etapa 2 do ADR 0026).

## Evidência

- `relay/src/cloud.test.ts`: roster com `person`, vínculos pendentes e
  cadeias rejeitados, persistência no reducer.
- `src/team-channel.test.ts`: companheiro recebe share e menção da pessoa,
  fala com o dono; terceiro fora da audiência segue sem conteúdo.
- `prometeu-cloud/test/integration/organizations_test.rb`: ticket de
  companheiro, roster, isolamento entre pessoas, remoção e limite do roster.
