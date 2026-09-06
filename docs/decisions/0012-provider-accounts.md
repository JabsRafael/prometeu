# ADR 0012 — Contas locais e seleção global por provider

Data: 2026-09-05
Status: Aceito

Substituído parcialmente pelo [ADR 0013](0013-remove-provider-accounts.md) na
permanência dos perfis externos e na exigência de uma seleção por provider.

Substitui parcialmente o [ADR 0005](0005-portable-plugin-marketplace.md) na
regra de compartilhar sempre a autenticação do home original do Codex.

## Contexto

Uma pessoa pode ter várias assinaturas de Claude e Codex. O rodapé já mostra
cotas globais, mas o app herdava um único login de cada CLI. Trocar arquivos de
credenciais globais afetaria terminais externos e processos em andamento.

## Opções consideradas

- Trocar a credencial global do CLI: menos diretórios, mas muda processos fora
  do app e permite que um turno troque de identidade durante a execução.
- Associar contas a workspaces: adiciona configuração ao board e não atende
  à escolha global solicitada.
- Perfis locais por conta, com autenticação delegada ao CLI e histórico
  compartilhado: exige adaptar homes, cotas e retomada, mas mantém a decisão
  no rodapé e a credencial capturada por processo.

## Decisão

Adotar perfis locais e uma seleção persistida por provider. O login começa
no Prometeu e usa o fluxo oficial do CLI no navegador. O app não implementa
um servidor OAuth próprio para assinaturas dos agentes. Contas existentes no
terminal permanecem disponíveis como perfis externos.

Um turno termina com a conta que o iniciou. A próxima fala pode reiniciar o
processo com a seleção nova, retomando o mesmo transcript. Uma fala recebida
durante a transição permanece na fila. A escolha não é enviada ao relay.

Credenciais de contas diferentes ficam separadas. Histórico, plugins e skills
continuam disponíveis por links explícitos e configuração derivada. Codex usa
armazenamento privado em arquivo para contas criadas pelo app, permitindo que
a camada derivada de plugins aponte para a credencial correta. A escolha de
armazenamento do perfil externo não é alterada.

## Consequências

O cache de cotas passa a distinguir contas e o catálogo acompanha a seleção.
Homes de plugins Codex precisam distinguir workspace e conta para que o turno
antigo e o processo novo coexistam. Configurações alternativas de autenticação
não podem substituir silenciosamente uma assinatura gerenciada.

Os perfis compartilham histórico local: não são uma barreira de confidencialidade
entre contas da mesma pessoa. Trocar conta também escolhe qual provider/conta
recebe a continuação desse histórico. Credenciais nunca entram na conversa
compartilhada. O formato do board e o protocolo do relay não mudam.

## Evidência

O [contrato de contas](../contracts/accounts.md) registra IPC, persistência,
adaptação por CLI, testes e o limite da validação sem dois logins reais.
