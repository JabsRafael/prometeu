# Prometeu — guia para agentes

Este arquivo é o mapa curto do repositório. A fonte de verdade detalhada fica
em `ARCHITECTURE.md` e em `docs/`; não copie documentos inteiros para cá.

## Antes de mudar código

1. Leia `ARCHITECTURE.md` para localizar a fronteira afetada.
2. Abra apenas os documentos de `docs/` apontados para aquela área.
3. Confirme o comportamento existente nos testes e no código.
4. Preserve mudanças locais que não pertencem à tarefa.

Se código e documentação divergirem, use o comportamento verificável do código
para diagnosticar a situação e atualize a documentação na mesma mudança. Não
transforme uma divergência em uma decisão arquitetural silenciosa.

## Mapa da documentação

- `README.md`: produto, comportamento visível e início rápido.
- `ARCHITECTURE.md`: contexto, containers, responsabilidades e fluxos centrais.
- `docs/architecture/`: detalhes dos fluxos e regras de dependência.
- `docs/contracts/`: formatos que atravessam processos ou camadas.
- `docs/decisions/`: decisões arquiteturais; propostas não são regras vigentes.
- `docs/quality/`: matrizes de suporte e estratégia de verificação.
- `docs/operations/`: desenvolvimento, CI e release.

Comece por `docs/README.md` para o índice completo.

## Invariantes do produto

- Uma sessão é o transcript; o processo do agente pode morrer e ser retomado.
- Claude e Codex são adaptações externas. Diferenças de protocolo devem ficar
  na borda, sem espalhar payloads do fornecedor pela apresentação.
- Etapa do workspace é decisão da pessoa; status da aba é estado observado do
  agente. Não misture os dois.
- A sessão compartilhada continua executando somente no Mac do dono. O relay
  coordena e persiste o mínimo necessário; ele é uma fronteira de confiança,
  não criptografia ponta a ponta.
- A fonte de tipos e validação do relay é `relay/src/protocol.ts`.
- Texto visível da interface passa por i18n. Dados do usuário e saída do agente
  permanecem no idioma original.

As regras de dependência completas estão em
`docs/architecture/dependency-rules.md`.

## Onde cada responsabilidade mora

- `src/agents.ts`: catálogo tipado, associação modelo/provider e capabilities.
- `src/timeline.ts`: reducer puro do stream de conversa para itens de tela.
- `src/chat.ts`: apresentação e interação da conversa.
- `src-tauri/src/chat.rs`: processo, transporte, buffer, numeração e lifecycle.
- `src-tauri/src/claude.rs`: adapter stream-json do Claude.
- `src-tauri/src/codex.rs`: adapter JSON-RPC do Codex.
- `src-tauri/src/session.rs`: casos de uso e lifecycle de workspace/aba.
- `src-tauri/src/state.rs`: estado persistido do quadro.
- `src/team*.ts`: transporte, controle e apresentação de colaboração.
- `relay/src/protocol.ts`: contrato de rede compartilhado por app e Worker.
- `relay/src/logic.ts`: regras puras do relay.

## Contratos e decisões

Mudança em formato persistido, IPC, relay, protocolo de conversa, fronteira de
confiança ou dependência entre camadas exige:

- atualizar o contrato correspondente em `docs/contracts/`;
- adicionar ou substituir um ADR quando houver escolha com trade-offs;
- incluir teste de compatibilidade ou explicar por que ele não se aplica.

ADRs aceitos não são reescritos para mudar a decisão. Crie outro ADR e marque o
anterior como substituído.

## Desenvolvimento e validação

```sh
npm install
npm run app
npm run dev
npm run docs:check
npm run typecheck
npm run test:web
npm run test:rust
npm run test:e2e
npm run check
```

Durante a implementação, rode primeiro o teste mais próximo da mudança. Antes
de concluir uma alteração transversal, prefira `npm run check`. Se uma
verificação não puder rodar, diga exatamente qual e por quê.

O navegador usa `src/mock.ts`; o app Tauri usa o backend Rust. Comandos IPC
novos precisam existir nos dois caminhos e no registro tipado de `src/ipc.ts`.

## Commits e release

Commits seguem Conventional Commits em português:

```text
tipo(escopo): descrição
```

`feat`, `fix` e `perf` aparecem no changelog. Use descrição voltada ao que a
pessoa percebe, em minúscula e sem ponto final. Detalhes internos pertencem ao
corpo ou a commits `refactor`, `test`, `docs`, `chore`, `ci`, `build` e `style`.

Release é feita por `sh scripts/release.sh`; não crie tag nem publique artefato
sem pedido explícito. Veja `docs/operations/release.md`.

## Manutenção da documentação

- Documente o porquê e os contratos; não narre código evidente.
- Comentários explicam detalhes locais. Documentos explicam fluxos e decisões.
- Links são relativos ao repositório e precisam continuar válidos.
- Uma feature nova deve apontar para seus testes e declarar diferenças entre
  agentes na matriz de `docs/quality/provider-matrix.md`.
