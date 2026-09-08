# ADR 0030 — controle remoto independente do compartilhamento

Data: 2026-09-08
Status: Aceito. Amplia os [ADRs 0027](0027-companion-devices.md) e
[0028](0028-mobile-web-app.md), sem alterar o [relay v4](../contracts/relay-v4.md).

## Contexto

O celular pertence à mesma pessoa que executa o workspace no Mac, mas o menu
de compartilhamento oferece somente outras pessoas ou toda a organização.
Assim, acessar o próprio workspace pelo celular exigia expô-lo a alguém mais.

O acesso pessoal também precisa poder ser revogado sem mudar quem já recebeu o
workspace pela colaboração do time.

## Opções consideradas

1. Mostrar a própria pessoa no menu de audiência. Resolve o acesso exclusivo,
   mas mistura dispositivos pessoais com colaboração e não permite desligar o
   celular quando a audiência é toda a organização.
2. Criar outro tipo de share no relay. Separa os conceitos, mas duplica
   armazenamento, comentários e streaming.
3. Persistir uma permissão pessoal no workspace e reutilizar o share existente.

## Decisão

Adotar a opção 3. `Workspace.remote_control` registra consentimento separado.
O rodapé da conversa mostra **Controle remoto** em português e **Remote
control** em inglês quando uma organização do Cloud está ativa.

O workspace continua com um único anúncio. Antes de cifrar, o dono acrescenta
seus dispositivos companheiros aos destinatários somente quando
`remote_control` está ativo. A audiência do time continua independente. Um
workspace com controle remoto e sem audiência de time usa `audience: []`
localmente; no frame externo, a audiência explícita contém apenas os
dispositivos autorizados.

## Consequências

- Ativar o controle remoto não compartilha o workspace com outras pessoas.
- Desativá-lo revoga os dispositivos pessoais sem remover a audiência do time.
- Boards antigos recebem `remote_control: false` por padrão.
- O Mac continua executando o agente e precisa permanecer com o Prometeu aberto.
- O relay recebe os mesmos frames v4 e continua sem conhecer a permissão local.

## Evidência

- `src/team-channel.test.ts`: dispositivo do dono não recebe o share antes da
  permissão e recebe depois dela.
- `src/team-organizations.test.ts`: persistência independente e caixas cifradas
  somente para o dono e seu dispositivo.
