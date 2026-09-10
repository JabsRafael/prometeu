# Organizações no Prometeu Cloud

Status: implementado; [ADR 0021](../decisions/0021-cloud-organizations.md).

## Propriedade e acesso

Organização é o escopo de colaboração anteriormente chamado de time. O Cloud
possui nome, slug único, dono, membros e convites. Não há times aninhados.
A pessoa pode pertencer a várias organizações; o desktop mantém uma ativa.
Dono e administradores alteram a organização, convidam membros e editam seu
catálogo. Somente o dono promove administradores, gerencia outros
administradores e exclui a organização. Membros podem sair, exceto o dono.
Excluir uma conta exige antes excluir as organizações que ela possui.

Convites são enviados por Action Mailer, em português ou inglês, e expiram em
7 dias. O link abre uma página de revisão; GET nunca concede acesso. Aceitar
exige POST com cookie/CSRF, conta autenticada e email verificado igual ao
convidado. Cadastro, verificação e login preservam o retorno ao convite.
Token assinado inclui nonce, destinatário, papel e estado de consumo. Reenvio,
revogação e aceitação invalidam links anteriores. Aceitação cria a matrícula e
consome o convite na mesma transação SQLite. A organização admite até 64 membros,
limite do protocolo de colaboração. Falha de SMTP mantém convite pendente e
mostra erro para permitir reenvio; testes usam somente entrega em memória.

O catálogo da organização reutiliza `Catalog`, com exatamente um proprietário:
`user_id` ou `organization_id`, protegido por constraint. Cada documento tem
revisão própria, limite de 256 KB e a mesma validação de portabilidade do catálogo
pessoal. Membros leem; dono e administradores fazem CRUD. Acesso por slug nunca
substitui a autorização pela matrícula da conta autenticada.

Compartilhar uma definição pessoal com a organização copia somente aquele item.
Membros podem copiar itens da organização para o catálogo pessoal, que o desktop
já sincroniza. Cópias são independentes; mudanças futuras não cruzam catálogos.
Colisão no destino retorna 409, sem sobrescrever. Não há assinatura automática
de catálogos institucionais nem ativação automática de código recebido.

## API e relay

As rotas antigas de conta e catálogo pessoal permanecem inalteradas.

| Rota | Autenticação e resposta |
| --- | --- |
| `GET /api/organizations?device=` | Bearer desktop; `{ organizations: [{ id, slug, name, member, role }] }`, somente matrículas aceitas; `device` opcional define `member` (ver abaixo) |
| `POST /api/organizations/:id/relay-ticket` | Bearer desktop; JSON `{ device?, label? }`; `{ ticket, relay }`; exige matrícula atual; 422 para `device` inválido |
| `POST /api/relay/authorize` | JSON `{ ticket, organization }`; capacidade de uso único; devolve `{ organization, member, name, expires_at, members: [{ id, name, person? }] }` ou 401 |
| `POST /orgs/:slug/companion-ticket` | Cookie e CSRF; JSON `{ companion, label? }`; `{ ticket, relay }`; exige matrícula atual; 422 para ID inválido ou de outra pessoa |
| `DELETE /companions/:id` | Cookie e CSRF; remove o dispositivo da pessoa e revoga seus tickets |
| `GET /app` | Cookie; página do celular com origem canônica, usuário e matrículas em `data-*`; `connect-src` inclui o relay |
| `GET /app/manifest` | Público; manifesto de instalação com `start_url` `/app` |

`id` e `member` são identificadores opacos e estáveis, distintos do slug e do
nome. Tickets têm 256 bits aleatórios, hash SHA-256 no banco, validade de
60 segundos e vínculo com matrícula e sessão desktop. Consumo é transacional.
Remover matrícula, excluir organização ou revogar sessão impede uso do ticket.
O Bearer desktop permanece no Rust e no Cloud; nunca chega ao relay/webview.

O Rust valida a origem `relay` e devolve somente uma URL WSS com ticket curto.
O frontend conecta a `/organization/:id?ticket=…&p=4`. O relay consulta a origem
Cloud configurada, sem seguir redirects, e ignora identidade/nome fornecidos
pelo cliente. Usa namespace de Durable Object `organization:<id>`, separado dos
times legados. Matrícula por segredo compartilhado não concede acesso aqui.
O roster do Cloud inclui membros offline, usados nas seleções de audiência.

Um navegador entra como dispositivo companheiro: `companion` é um ID
`[A-Za-z0-9_-]{16,64}` gerado pelo navegador ao lado da sua identidade privada,
único no Cloud e ligado à pessoa que o registrou. O ticket de companheiro exige
sessão de navegador e faz `member` ser o ID do companheiro; o roster lista cada
companheiro com `person` igual à matrícula da pessoa naquela organização e
`name` igual ao nome da pessoa com o rótulo entre parênteses. Pessoas sempre
cabem no roster; os companheiros ocupam as vagas até 64 por uso recente, no
máximo cinco por pessoa. A remoção fica em Configurações → Dispositivos. Ver
[ADR 0027](../decisions/0027-companion-devices.md).

Cada Mac envia `device`, um ID no mesmo formato gerado uma vez em
`device.json` e mantido através de logouts, com `label` igual ao nome do
computador. O primeiro dispositivo a consultar ou pedir ticket reivindica a
matrícula (`desktop_id`) e continua com `member` igual ao ID da matrícula.
Qualquer outro Mac da pessoa recebe `member` igual ao próprio `device`,
registrado como companheiro com o rótulo do Mac; tickets de companheiro
aceitam sessão desktop ou de navegador. Sem `device`, o desktop identifica a
matrícula como antes. Ver [ADR 0036](../decisions/0036-second-mac-as-companion.md).

A conexão tem lease de no máximo 60 segundos, limitada também pela expiração
do login. Alarme encerra sockets vencidos; entrada e saída verificam o prazo
mesmo se o alarme atrasar. Após a prova de identidade, o relay anuncia
`lease { expires_in }`, em milissegundos. Desktop e celular pedem outro ticket
na metade desse prazo e enviam `renew { ticket }` pelo mesmo socket. O relay
consulta o Cloud novamente e exige a mesma organização e o mesmo membro,
com o socket ainda válido. A confirmação é outro `lease`; não repete handshake,
presença nem snapshots quando o roster permanece igual. Remoção/revogação
impede tráfego novo em até 60 segundos, inclusive após uma renovação.
Uma nova matrícula usa outro ID e não recupera audiências privadas antigas.
Falha no Cloud impede renovar; trabalho local continua disponível.

Clientes antigos ignoram `lease` e continuam reconectando ao vencer o prazo.
Clientes novos só renovam quando o relay anuncia essa capacidade; um relay
antigo conserva o caminho de reconexão. Após perda real da conexão, o cliente
obtém outro ticket com backoff e recupera snapshots. TOFU e recibos permanecem
intactos. A duração relativa evita depender da sincronia entre relógios.
Decisão no [ADR 0034](../decisions/0034-mobile-pairing-continuity.md). Alarme utiliza a
[API nativa de Durable Objects](https://developers.cloudflare.com/durable-objects/api/alarms/).

Processos e transcripts continuam no Mac do dono. O relay encaminha conteúdo
cifrado e conserva comentários cifrados/metadados; o Rails recebe somente identidade,
matrículas e definições portáteis. O [relay v4](relay-v4.md) acrescenta E2EE com
TOFU e identidades locais independentes dos tickets. Os limites, incluindo
ausência de forward secrecy, estão no [ADR 0022](../decisions/0022-end-to-end-encryption.md).

## IPC, consentimento e compatibilidade

- `cloud_organizations`: retorna `{ user, origin, organizations }`; não consulta
  rede quando desconectado.
- `cloud_relay_ticket`: recebe `{ organization, user, expectedOrigin }`; exige
  identidade/origem iguais à credencial local e retorna a URL temporária. O
  Rust acrescenta o ID e o rótulo do dispositivo (`device.json`) aos dois IPCs.
- `team_config_set`: continua guardando JSON privado. Configuração de organização
  mantém campos legados, com `secret` e `credential` vazios, e acrescenta
  `cloud: { user, origin, slug, name }`. Tickets nunca são persistidos.
- `set_shared`: recebe `remoteControl` e o argumento opcional `team`; persiste
  `remote_control` e `share_team` no workspace. Organização usa
  `organization:<id>:<member>`. Time legado usa `team:<id>`. Ausência em boards
  antigos só autoriza o caminho legado; `remote_control` ausente vale `false`.

Com exatamente uma matrícula aceita, o desktop a ativa sozinho ao listar as
organizações; sair guarda essa decisão em `localStorage` (`prometeu:organizacao-saida`),
preferência local por máquina que desliga o atalho até a próxima escolha explícita.
Escolher outra organização ou conta nunca anuncia os shares anteriores nesse
novo escopo. Snapshot pendente captura a conexão de origem e é descartado após
troca de conexão ou revogação do compartilhamento. Frames antigos não alteram
estado da nova conexão. Selecionar organização não publica workspaces sozinho.

Times legados preservam suas credenciais, mas o desktop atualizado exige v4.
O relay lê/grava colaboração em `v4:`; dados v3 ficam intactos e não são
mostrados pelo cliente novo. Não há conversão de comentários v3 nem downgrade.
Criação, códigos de convite e edição de membros saem da UI desktop. A primeira
troca de uma configuração legada por organização conserva cópia privada em
`<root>/team-legacy-<uuid>.json`. Não é possível inferir emails das identidades
anônimas antigas: crie a organização, convide por email e compartilhe cada
workspace novamente por escolha. Conversas locais e storage legado não mudam.

## Publicação e rollback

1. Publique Cloud e sua migração aditiva, preservando snapshot SQLite.
2. Publique relay com `CLOUD_URL` apontando para esse Cloud (padrão `https://app.prometeu.co`).
3. Configure `RELAY_URL` no Cloud para o relay publicado (padrão atual do produto).
4. Distribua desktop v4 após o relay v4. Clientes v3 exigem o relay antigo;
   o relay atualizado recusa conexões v3.

Local: Cloud usa `RELAY_URL=http://127.0.0.1:8787`; relay usa
`CLOUD_URL=http://127.0.0.1:3100` em `relay/.dev.vars`; desktop usa
`PROMETEU_CLOUD_URL=http://127.0.0.1:3100`. Somente loopback permite HTTP/WS.

Rollback de código mantém o schema expandido; não execute `db:rollback` com
organizações reais, pois removeria dados novos. Preserve dados de organizações,
convites e catálogos durante a janela de compatibilidade. Desktop antigo pode
restaurar explicitamente a cópia de `team.json` legado; nunca converta consentimento
institucional em compartilhamento legado. Nenhum deploy ou envio de email real
faz parte da validação local. Rollback para v3 não conserva E2EE: preserva
o namespace v4, mas restaura a fronteira de conteúdo legível do protocolo antigo.

## Evidência

- Cloud: `test/integration/organizations_test.rb` e `test/browser/organizations.spec.js`.
- Desktop: `src/team-organizations.test.ts`, `e2e/organizations.spec.ts` e testes de `cloud.rs`.
- Relay: `relay/src/cloud.test.ts` e `relay/src/worker.integration.test.ts` com Worker real,
  serviço de autorização local, isolamento, identidade, audiência, fala e expiração.
- Suítes existentes de conta, catálogo, protocolo, comentários e controle remoto
  protegem clientes legados e os dois providers.
