# Conta opcional do Prometeu

Status: implementado no cliente e no projeto separado `prometeu-cloud`; publicação do serviço é uma etapa operacional independente.

## Fronteira

A conta pertence ao Prometeu, não ao Claude ou Codex. O SaaS
possui cadastro, autenticação, perfil e sessões de login. Nenhum workspace, transcript ou segredo de provider é sincronizado com o SaaS.
O [feedback privado](feedback.md) envia somente o texto digitado e a imagem
escolhida, com aviso de tratamento privado pela equipe Prometeu. Enviar exige
conta conectada ([ADR 0035](../decisions/0035-feedback-requires-account.md)); sem
conta, o painel oferece a mesma autorização de dispositivo da barra lateral.
O desktop funciona sem conta e não consulta as APIs da conta enquanto desconectado.

O topo da barra lateral mantém o logo e o nome Prometeu. Quando desconectado,
oferece “Criar conta” à direita, na mesma linha. Conectado, mostra o nome da
pessoa abaixo da marca.
O email fica no tooltip, e a indicação de conta offline acompanha o nome.

O projeto `prometeu-cloud` usa Rails 8.1, SQLite e ERB, com autenticação baseada
no gerador nativo do Rails e `has_secure_password`. Oferece cadastro
por email/senha, verificação de email, leitura e edição do perfil, mudança de
email com confirmação, mudança/recuperação de senha, logout, revogação de
sessões de login e exclusão de conta com senha. SMTP é obrigatório para
produção; desenvolvimento local pode rodar sem email. Sessões têm validade
fixa de 30 dias, com revogação no servidor; não há renovação automática.

Os controles do site são renderizados pelo adaptador Rails do Design System.
Seu runtime local acrescenta menus, revelar senha, confirmação opcional de
revogação e bloqueio de envios duplicados. A CSP permite scripts locais com
nonce e não permite `unsafe-inline` ou `eval`. Formulários continuam enviando
POSTs nativos com CSRF e valores de botão preservados. Sem JavaScript, cadastro,
login e autorização do Mac continuam funcionando. Ver
[ADR 0017](../decisions/0017-executable-design-system.md).

## Conexão do Mac

O backend usa `POST /api/auth/device/code`, com `client_id=prometeu-desktop`.
Abre `/device?user_code=…&mode=signup` no navegador do sistema. A pessoa cria
uma conta ou entra, confere o código mostrado no desktop e aprova explicitamente.
O clique em “Criar conta” abre o navegador diretamente, sem diálogo no desktop.
O código fica na barra lateral enquanto a autorização está pendente; seu menu
permite reabrir o navegador ou cancelar. A conexão é detectada automaticamente.
O desktop consulta `POST /api/auth/device/token` respeitando `interval`,
`authorization_pending`, `slow_down` e expiração. O token retornado autentica
`GET /api/auth/get-session` via Bearer. Código consumido não pode ser reutilizado.

Credenciais ficam exclusivamente no Rust. O frontend recebe apenas perfil,
origem, estado offline, código público de confirmação e ID local da tentativa.
O backend constrói a URL de aprovação a partir da origem configurada e não
segue redirects HTTP. Senhas são digitadas somente na página do SaaS.

`PROMETEU_CLOUD_URL` configura a origem no processo do app; padrão previsto:
`https://app.prometeu.co`. HTTPS é obrigatório fora de loopback. A origem é
persistida junto do token para nunca encaminhar uma credencial existente a
outro servidor após alteração de configuração.

## IPC

| Comando | Argumentos | Retorno |
| --- | --- | --- |
| `cloud_status` | `{ refresh: boolean }` | `{ user, origin, offline }` |
| `cloud_login_start` | `{ signup: boolean }` | `{ id, user_code, url, interval }` |
| `cloud_login_poll` | `{ id: string }` | status conectado ou `null` enquanto pendente |
| `cloud_login_cancel` | `{ id: string }` | vazio |
| `cloud_logout` | nenhum | status desconectado |

`user` é `null` ou `{ id, name, email }`. `refresh=false` lê apenas o cache
local. Falha transitória preserva a identidade e marca `offline`; sessão
revogada ou expirada remove a credencial. A UI atualiza ao recuperar foco e a
cada 60 segundos enquanto visível. Logout revoga primeiro no serviço: uma
falha de rede deixa a conta conectada e apresenta erro, sem fingir revogação.
Cancelar invalida a tentativa. Uma resposta tardia não substitui a tentativa
atual. Um login concluído antes do cancelamento já é uma sessão conectada e
pode ser encerrado pelo menu.

## Persistência e compatibilidade

`<root>/cloud.json` contém `{ origin, token, user }`, com gravação atômica e
permissões `0600` em diretório `0700`. Ausência significa uso local. Transcripts
e contas dos providers mantêm seus formatos. Board e `team.json` recebem campos
opcionais para consentimento e seleção de organização, preservando a leitura dos
dados antigos; ver [contrato de organizações](cloud-organizations.md).
Excluir a conta no SaaS revoga as sessões de login; não exclui dados locais.
O mock simula o fluxo sem rede e guarda somente perfil fictício em localStorage.

A substituição do protótipo Node pelo Rails preserva as quatro rotas do
desktop, seus payloads e o logout por `POST /api/auth/sign-out` com Bearer e
corpo JSON. Sessão inválida retorna JSON `null` em `get-session` e 401 no logout.
O protótipo não tinha dados de produção. Seu banco não é reutilizado pelo Rails;
tokens de teste antigos exigem nova conexão. As rotas internas do site foram
substituídas por formulários Rails com CSRF; não eram consumidas pelo desktop.
Ver [ADR 0015](../decisions/0015-cloud-rails.md).

O catálogo de plugins, MCP e Ações passou a ter a conta como repositório; ver
[`cloud-catalog.md`](cloud-catalog.md). Transcripts na nuvem permanecem fora desta etapa. A colaboração usa
[E2EE v4](relay-v4.md), separada da credencial da conta. Organizações usam a
identidade da conta para autorizar colaboração no relay; ver
[contrato de organizações](cloud-organizations.md).


## Evidência

- `src-tauri/src/cloud.rs`: validação de origem e ausência de token no status.
- `e2e/cloud.spec.ts`: conexão, persistência, cancelamento, logout, conta offline,
  revogação e preservação das conversas, em Chromium e WebKit.
- `prometeu-cloud/test/integration/accounts_test.rb`: requests Rails, CRUD,
  isolamento, contrato desktop, aprovação, revogação, CSRF, rate limiting e email.
- `prometeu-cloud/test/models/device_grant_test.rb`: consumo único concorrente.
- `prometeu-cloud/test/browser/accounts.spec.js`: HTTP real e formulários com
  CSRF ativo em Chromium e WebKit, em viewport mobile.

O mock não comprova abertura do navegador pelo Tauri nem entrega SMTP real.

## Catálogo pessoal

A mesma conta oferece autoria web em `/catalog` e `GET/PUT /api/catalog`
com Bearer no desktop. Conectar não publica itens locais automaticamente.
O [contrato do catálogo](cloud-catalog.md) define compartilhamento explícito,
revisões, formatos e compatibilidade. Trocar de conta esquece vínculos
anteriores, mantendo os arquivos locais.

## Organizações

`cloud_organizations` e `cloud_relay_ticket` são IPCs aditivos descritos no
[contrato de organizações](cloud-organizations.md). O segundo devolve ticket
curto, nunca a credencial desktop. Revogar a conta também impede renovar
acesso às organizações.
