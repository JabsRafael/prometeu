# Contas dos agentes

Status: implementado; decisões nos ADRs [0012](../decisions/0012-provider-accounts.md)
e [0013](../decisions/0013-remove-provider-accounts.md).

## Seleção e conversa

A seleção é local a este Mac e global por provider. Não pertence ao workspace,
ao board nem ao relay. Cada processo captura o ID e a revisão da conta ao
nascer. Um turno em andamento continua com essa conta; a próxima fala usa a
seleção atual, retomando o mesmo transcript quando precisar trocar o processo.
Uma fala enviada durante essa transição fica em `pending_prompt` até o fim do
turno. Respostas a perguntas e permissões continuam no processo que fez o pedido.
Tarefas de Ações seguem a mesma seleção de conta, mantendo seu perfil de
modelo, instruções, permissões e ferramentas capturado na criação. A liberação
da fila pelo acompanhamento de PR também respeita a troca entre turnos.

Conectar uma conta não a ativa. A pessoa clica na conta no painel depois do
login; o card inteiro é clicável e seu contorno indica a seleção. Reconectar
incrementa a revisão, fazendo
processos ociosos retomarem antes da próxima fala, mesmo quando o ID permanece
igual. A reconexão é recusada durante um turno que usa aquela conta. Falhas de
login não alteram a seleção.

Qualquer conta pode ser removida, inclusive a herdada do terminal. Remover a
conta ativa apaga a seleção daquele provider, sem ativar outra automaticamente.
O turno em andamento termina com seu perfil capturado; novas falas exigem
selecionar uma conta. Remover uma conta inativa preserva a seleção atual. Não
há remoção durante login pendente: é preciso concluir ou cancelar a tentativa.

## Cadastro e IPC

`<root>/accounts.json` guarda `{ accounts, active }` por escrita privada e
atômica. Cada conta contém:

```ts
type Account = {
  id: string;
  provider: "claude" | "codex";
  email: string | null;
  plan: string | null;
  connected: boolean;
  revision: number;
};
type Accounts = {
  accounts: Account[];
  active: { claude?: string; codex?: string };
  login: { id: string; provider: "claude" | "codex" } | null;
};
```

O evento `accounts` e os retornos de comandos usam `Accounts`. `login` é
efêmero e não vai ao disco. IDs `claude` e `codex` representam as contas dos
CLIs já instalados. IDs adicionais são UUIDs gerados pelo backend. A interface
identifica contas pelo e-mail ou por um rótulo traduzido enquanto não há login.
O antigo campo `label` é ignorado na leitura e não é mais gravado. O cadastro
aceita listas vazias e providers sem seleção; apenas arquivo ausente importa
os dois perfis externos iniciais. Reiniciar não restaura contas removidas.

| Comando | Argumentos | Retorno |
| --- | --- | --- |
| `accounts` | nenhum | `Accounts` |
| `account_select` | `{ id }` | `Accounts` |
| `account_remove` | `{ id }` | `Accounts` |
| `account_login` | `{ provider, id: string \| null }` | `Accounts` ao concluir |
| `account_login_cancel` | `{ id }` | vazio |

`id: null` cria um perfil desconectado antes de iniciar o login, permitindo
reconectá-lo após cancelamento, erro ou reinício do app. Há um login por vez;
o processo tem prazo de dez minutos e cancelamento. O app encerra o processo
auxiliar quando a operação termina ou falha. Tokens, stdout, stderr e payloads
de autenticação do provider não atravessam IPC, transcript ou relay.

Se a retomada automática falhar depois do turno anterior, `account-error`
apresenta o erro traduzível e a fala permanece em `pending_prompt`.

Ausência do cadastro preserva os CLIs existentes. Cadastro inválido retorna
erro e não troca silenciosamente para outra conta. A seleção exige uma conta
cadastrada do provider correto. A conta do terminal continua sendo administrada
externamente: o Prometeu não executa login ou logout no perfil original.
Remover tira a conta do cadastro e das próximas consultas de identidade/cotas.
Não apaga o diretório do perfil, credenciais, Keychain ou histórico: processos
já abertos ainda podem usá-los. Remoção não é revogação de login. Uma consulta
ou evento já em andamento pode terminar, mas não recadastra a conta removida.
Sem seleção, `accounts::active` retorna `err.account.noActive`; os adapters
nunca usam silenciosamente uma conta do terminal removida.

## Perfis e credenciais

Perfis gerenciados ficam em `<root>/accounts/<uuid>/`, com diretório `0700`.
Compartilham explicitamente histórico, skills e plugins; nunca compartilham
credenciais de inferência. O ambiente é aplicado ao filho, sem mudar o ambiente
do app ou sobrescrever o login global do CLI.

### Claude

O adapter usa `CLAUDE_CONFIG_DIR` e `claude auth login --claudeai`; o CLI abre
o navegador e administra os tokens. `claude auth status --json` fornece a
identidade. No macOS, o CLI usa uma entrada do Keychain específica do diretório;
o fallback `.credentials.json` também pertence ao perfil.

`projects` aponta para o mesmo diretório do Claude original, preservando
`--resume` e os caminhos antigos da UI. Plugins e recursos compartilháveis
também usam links. Preferências, MCPs e confiança de projetos são materializados
sem copiar a identidade ou as credenciais de inferência. A configuração global
não é reescrita. Credenciais alternativas herdadas são removidas do ambiente e
das preferências derivadas. Antes de abrir uma conversa gerenciada, o adapter
consulta a autenticação no diretório do projeto e recusa uma fonte alternativa
que substitua a assinatura selecionada.

### Codex

O adapter usa um `CODEX_HOME` por conta e o protocolo oficial do app-server:
`account/login/start`, `account/login/completed`, `account/read` e
`account/rateLimits/read`. O app abre a URL oficial no navegador; não implementa
troca ou renovação de tokens. Essas operações não abrem threads nem enviam prompts.

Os perfis gerenciados usam `cli_auth_credentials_store = "file"`, com
`auth.json` privado dentro do perfil. A configuração é derivada da original,
com o provider OpenAI e sem substituir a configuração global. Rollouts e o
índice SQLite continuam compartilhados, permitindo `thread/resume` em outra
conta. O cache de modelos pertence à conta. A camada de plugins é separada por
workspace (ou sessão de tarefa) **e conta**; nunca se reponta o link de autenticação de um processo
que ainda está vivo. Veja [plugins](plugin-marketplace.md).

## Cotas e catálogo

O mapa de `usage` é indexado pelo ID local da conta. Chaves antigas `claude` e
`codex` continuam válidas para os perfis originais; cada valor preserva
`{ windows, at }`. Eventos do processo atualizam a conta capturada no spawn,
mesmo quando a seleção já mudou. O rodapé mostra somente os limites da conta
selecionada, ou um traço quando não há seleção. E-mails e controles ficam no
painel, que apresenta as contas do provider com suas próprias cotas.

O poll consulta os perfis cadastrados e preserva a última leitura quando um
provider não responde. Claude ainda depende do endpoint interno de cotas;
Codex prefere o app-server, com o endpoint anterior como fallback. A ausência
de cotas não é um percentual zero. O catálogo é recarregado ao trocar conta;
respostas atrasadas da seleção anterior são descartadas.

## Evidência e limite de verificação

- `accounts.rs`: compatibilidade com cadastros antigos, remoção de todas as
  contas, persistência da seleção vazia e cancelamento com encerramento do processo.
- `claude.rs`, `codex/account.rs`: fixtures de identidade, perfis com
  credenciais separadas e leitura do mesmo transcript/rollout.
- `chat.rs`, `usage.rs`: transição entre turnos e isolamento de cotas.
- `plugins.rs`: limpeza de camadas por conta sem seguir links.
- `src/agents.test.ts`: resposta de catálogo atrasada.
- `e2e/accounts.spec.ts`: seleção persistida por provider, cancelamento,
  reconexão, remoção de todas as contas, falha de login, cadastro antigo sem
  apelidos e escape do e-mail.
- Testes `perfil_vazio_nao_herda_login_do_terminal`, executados separadamente,
  consultam os CLIs reais sem login ou prompts.

A suíte automática não comprova uma rodada de OAuth com duas contas reais nem
a continuação de uma conversa autenticada entre elas. Essa verificação exige
os logins da pessoa nos dois providers; fixtures e mocks não a substituem.
