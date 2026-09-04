# Desenvolvimento e testes

## Pré-requisitos

- Node e npm nas versões declaradas em `package.json`;
- toolchain Rust declarada em `src-tauri/rust-toolchain.toml`;
- Chromium do Playwright para testes E2E;
- Claude Code e/ou Codex instalados para testar sessões reais.

```sh
npm install
npx playwright install chromium webkit
```

## Modos de execução

```sh
npm run app
npm run dev
PORT=1421 npm run dev
```

`npm run app` inicia Tauri por `scripts/app.sh` e isola porta e raiz de estado
por worktree. `npm run dev` abre somente o frontend sobre `src/mock.ts`, útil
para UI e para os testes dirigidos pelo Playwright.

O mock não prova lifecycle de processo, filesystem ou serialização Rust. O app
Tauri não é dirigido pelo Playwright no macOS porque a WKWebView não expõe CDP.

## Comandos de validação

```sh
npm run docs:check
npm run architecture:check
npm run typecheck
npm run build
npm run test:web
npm run test:rust
npm run test:e2e
npm run format:check
npm run lint:rust
npm run check
```

`npm run check` executa formato Rust, build/typecheck, toda a suíte de testes e
Clippy com warnings como erro, além da integridade da documentação. É a mesma
validação principal da CI.

Durante desenvolvimento, rode primeiro a menor suíte que cobre a mudança. Use
`npm run check` antes de concluir uma alteração transversal ou abrir PR.

## O que cada nível prova

- Vitest: reducers, apresentação pura, parsing, protocolo do relay e adapters
  TypeScript.
- Rust tests: lifecycle, tradução do Codex, estado, paths, Git, IPC interno e
  processos.
- Worker integration: autenticação e comportamento real do relay local.
- Playwright: fluxos críticos de UI contra o mock.
- Typecheck/build: imports, tipos, catálogo de i18n e bundle.
- Architecture check: decisões de apresentação não voltam a comparar nomes de
  provider diretamente.
- Clippy/rustfmt: disciplina do backend.

## Instâncias simultâneas

Debug e release usam raízes diferentes. Cada worktree de desenvolvimento ganha
configuração própria por `scripts/app.sh`; isso evita colisão de `board.json` e
porta Vite. Não substitua essa inicialização por um `tauri dev` direto sem
entender o isolamento.

O `.prometeu/settings.toml` deste repositório oferece o próprio app e o mock
como scripts de dogfooding.

## Captura de fixtures de agentes

Fixtures de protocolo devem:

- vir de saída real da versão do CLI indicada no teste;
- remover prompts pessoais, paths do usuário, tokens e credenciais;
- preservar ids e ordenação necessários ao cenário;
- conter o menor conjunto de frames que reproduz o comportamento;
- registrar provider, versão do CLI e capacidade provada;
- nunca depender de rede durante a suíte.

Uma atualização do CLI que quebra fixture é sinal para revisar o adapter e o
contrato, não para apagar a asserção até o teste passar.

## Texto de interface

Português é o catálogo fonte em `src/i18n.pt.ts`; inglês implementa as mesmas
chaves em `src/i18n.en.ts`. TypeScript usa `t`/`tn`; Rust emite códigos que o
frontend traduz com `fromBack`.

Saída do agente, terminal e texto fornecido pela pessoa não são traduzidos.
