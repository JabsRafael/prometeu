# Conta opcional do Prometeu

Status: implementado no cliente e no projeto separado `prometeu-cloud`; publicação do serviço é uma etapa operacional independente.

## Fronteira

A conta pertence ao Prometeu, não ao Claude, Codex ou time do relay. O SaaS
possui cadastro, autenticação, perfil e sessões de login. Nesta etapa, nenhum
workspace, arquivo, transcript ou segredo de provider é enviado para o SaaS.
O desktop funciona sem conta e não consulta o serviço enquanto desconectado.

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

## Conexão do Mac

O backend usa `POST /api/auth/device/code`, com `client_id=prometeu-desktop`.
Abre `/device?user_code=…&mode=signup` no navegador do sistema. A pessoa cria
uma conta ou entra, confere o código mostrado no desktop e aprova explicitamente.
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
permissões `0600` em diretório `0700`. Ausência significa uso local. Board,
transcripts, `team.json` e contas dos providers mantêm seus formatos.
Excluir a conta no SaaS revoga as sessões de login; não exclui dados locais.
O mock simula o fluxo sem rede e guarda somente perfil fictício em localStorage.

A substituição do protótipo Node pelo Rails preserva as quatro rotas do
desktop, seus payloads e o logout por `POST /api/auth/sign-out` com Bearer e
corpo JSON. Sessão inválida retorna JSON `null` em `get-session` e 401 no logout.
O protótipo não tinha dados de produção. Seu banco não é reutilizado pelo Rails;
tokens de teste antigos exigem nova conexão. As rotas internas do site foram
substituídas por formulários Rails com CSRF; não eram consumidas pelo desktop.
Ver [ADR 0015](../decisions/0015-cloud-rails.md).

Transcripts na nuvem, comandos remotos, criptografia ponta a ponta e integração
da identidade com o relay permanecem fora desta etapa. Exigem contratos
próprios, IDs estáveis além da sequência volátil atual e consentimento de envio.

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
