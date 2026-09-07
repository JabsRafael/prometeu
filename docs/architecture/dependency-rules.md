# Regras de dependência

Status: regras vigentes e direção de evolução.

## Princípio

Uma interface existe quando separa uma política nossa de uma tecnologia ou
protocolo que pode variar. Interfaces não são exigidas entre funções internas
apenas para aumentar o número de camadas.

## Camadas conceituais

| Camada | Exemplos atuais | Pode conhecer |
| --- | --- | --- |
| apresentação | `chat.ts`, `workspace.ts`, `workspace-changes.ts`, `sidebar.ts` | view models, casos de uso e contratos IPC |
| domínio derivado | `timeline.ts`, `relay/src/logic.ts` | tipos de domínio e funções puras |
| aplicação | `session.rs`, coordenação em `main.ts` | domínio e ports externos |
| adapters | `claude.rs`, `codex.rs`, IPC, relay transport, Git/files | protocolos externos e contratos do core |

Os diretórios atuais não representam essas camadas literalmente. A tabela serve
para decidir ownership e direção de dependência durante mudanças incrementais.

## Regras vigentes

1. `timeline.ts` não depende de DOM, Tauri ou rede.
2. `relay/src/logic.ts` não executa I/O; `room.ts` interpreta seus efeitos.
3. `relay/src/protocol.ts` não depende de APIs exclusivas do app ou do Worker.
4. Estado persistido é alterado no backend e republicado pelo evento `board`.
5. Acesso a filesystem, Git e processos acontece no backend.
6. Entrada remota é validada novamente no lado que possui a autoridade.
7. Erros do backend atravessam IPC como códigos/dados e são traduzidos no front.
8. Apresentação decide visibilidade por `AgentCapabilities`; comparações de
   nomes de provider ficam no catálogo ou nos adapters.

## Regras vigentes para agentes

1. Protocolos de Claude, Codex ou outro fornecedor aparecem somente no adapter
   correspondente e em fixtures daquele adapter.
2. O core recebe `ConversationCommand` e produz `ConversationEvent`, ambos do
   Prometeu.
3. Um provider novo implementa o mesmo port e passa pela suíte de conformidade.
4. Eventos desconhecidos não derrubam uma sessão; ficam observáveis e são
   ignorados de forma compatível até terem tradução explícita.

O leitor de transcript legado é exceção explícita à primeira regra. Fica
isolado em `conversation-legacy.ts` e no caminho de replay do adapter Claude,
sem alcançar a timeline nem o protocolo canônico. O Prometeu não produz novas
linhas no formato legado.

## Fronteiras que justificam interfaces

### Runtime de agente

Varia por instalação, catálogo, protocolo, resume e capacidades. Deve expor
descoberta, início/retomada, comandos, eventos e encerramento sem vazar payload
do fornecedor.

### IPC

Separa TypeScript e Rust. Nome, argumentos, retorno, erro e eventos formam um
único contrato. O mock web é outro adapter desse mesmo contrato.

### Colaboração

`team-transport.ts` abstrai o socket; `team-control.ts` transforma frames em
ações locais. O protocolo e sua validação permanecem compartilhados.

### Sistema local

Git, arquivos, PTY, processos e browser embutido são efeitos externos. Regras
que escolhem quando executar esses efeitos devem continuar testáveis sem eles.

## Organização por feature

Ao dividir um arquivo grande, extraia uma responsabilidade completa, com seus
tipos e testes, em vez de separar por tamanho. Uma feature pode conter:

```text
feature/
  model.ts        estado e regras puras
  service.ts      coordenação de casos de uso
  view.ts         DOM e interação
  contract.ts     tipos que cruzam a fronteira, se houver
  *.test.ts
```

O projeto não precisa adotar essa árvore inteira de uma vez. Um módulo novo
deve nascer nela apenas quando a mudança já exigir a fronteira.

## Como verificar

As regras são protegidas por revisão, testes focados e fitness functions
pequenas:

- `npm run architecture:check` impede condicionais de UI por provider fora do
  catálogo/capability;
- tipos exaustivos para `ProviderId` e eventos canônicos;
- teste de paridade entre comandos IPC, handlers Rust e mock;
- fixtures de conformidade por adapter.

Não introduza uma ferramenta de análise de dependências antes de existir uma
regra concreta que ela consiga verificar.
