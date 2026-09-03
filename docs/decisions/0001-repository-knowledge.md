# ADR 0001 — Conhecimento versionado no repositório

Data: 2026-09-03
Status: Aceito

## Contexto

O projeto cresceu com comentários de código detalhados, um README narrativo e
instruções específicas em `CLAUDE.md`. Decisões e invariantes importantes
existiam, mas era necessário conhecer previamente o arquivo certo para
encontrá-los. Outro agente ou pessoa podia repetir investigação, criar uma
abstração incompatível ou mudar uma regra sem perceber seu motivo.

Instruções grandes carregadas em toda sessão também competem com o contexto da
tarefa. Manter cópias em formatos específicos de cada agente aumenta drift.

## Opções consideradas

1. Continuar apenas com comentários e README.
2. Manter uma wiki ou documentos externos.
3. Usar um arquivo de instruções grande por ferramenta.
4. Manter conhecimento técnico estruturado e versionado junto do código, com
   arquivos de entrada curtos para agentes.

## Decisão

O diretório `docs/` será a fonte de verdade técnica. `ARCHITECTURE.md` será o
mapa geral, `README.md` continuará apresentando produto e uso, e `AGENTS.md`
será um índice curto com invariantes e comandos essenciais.

Arquivos específicos de ferramenta devem importar ou apontar para `AGENTS.md`
e conter apenas diferenças reais daquela ferramenta. Contratos, decisões,
qualidade e operação terão áreas próprias em `docs/`.

Documentação passa pelo mesmo versionamento e revisão do código. Uma mudança de
comportamento, contrato ou decisão atualiza a documentação correspondente na
mesma alteração.

## Consequências

Positivas:

- humanos e agentes consultam a mesma fonte;
- decisões ganham histórico e status explícito;
- contexto inicial permanece pequeno;
- documentos podem ser verificados por links, testes e CI;
- onboarding não depende da memória de quem escreveu o código.

Negativas:

- toda mudança arquitetural ganha custo pequeno de manutenção documental;
- documentos incorretos podem dar falsa segurança;
- será necessário revisar periodicamente links e compatibilidade com o código.

## Evidência

- `AGENTS.md` aponta para a árvore documental.
- `CLAUDE.md` importa as instruções compartilhadas.
- `docs/README.md` mantém o índice navegável.
- contratos distinguem estado atual de propostas ainda não implementadas.
