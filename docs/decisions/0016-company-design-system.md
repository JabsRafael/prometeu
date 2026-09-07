# ADR 0016 — Design System compartilhado da empresa

Data: 2026-09-06
Status: separação do comportamento substituída pelo
[ADR 0017](0017-executable-design-system.md). Substitui a localização dos tokens e do CSS compartilhado do
[ADR 0011](0011-shared-ui.md); mantém seus contratos de interação.

## Contexto

O desktop tem tokens, marca e primitivas próprias. O Cloud em Rails mantinha
uma segunda paleta e controles divergentes. Copiar estilos entre telas torna
cada produto responsável por manter a identidade da empresa.

## Decisão

A fonte canônica fica em `packages/design-system` no repositório Prometeu,
distribuída como `@prometeu/design-system`. O pacote contém tokens CSS,
componentes por classes, a marca SVG e uma galeria HTML independente. Não
depende de framework, backend, JavaScript ou compilação. O artefato pode ser
gerado por `npm pack`, sem publicar em registry nesta mudança.

O desktop importa essa fonte diretamente; `src/ui-tokens.css` conserva a
geometria exclusiva do aplicativo. O Cloud importa uma versão explícita para
`vendor/design-system`, com hashes SHA-256 e checagem no CI. O pipeline Rails
publica esses assets sem Node nem acesso ao repositório desktop em produção.
Edições são feitas na fonte e reimportadas, nunca no artefato vendorizado.

O CSS compartilhado usa classes opt-in e preserva nomes e valores dos tokens
existentes. `ui-comfortable` oferece controles de 44px para a web. Composição
de páginas, regras de domínio e tradução continuam em cada produto. Menus,
diálogos e helpers DOM continuam nos adaptadores locais do desktop.

## Alternativas e consequências

Um framework de componentes excluiria o ERB ou adicionaria runtime e build
desnecessários. Um CDN tornaria o visual dependente da rede e dificultaria
rollback. Um terceiro repositório é dispensável enquanto este pacote já
fornece uma fronteira de distribuição independente.

Vendorizar exige adoção explícita de novas versões, mas mantém builds
reproduzíveis. O manifesto detecta alterações no artefato; comparar com o
diretório da fonte verifica sua origem. Os valores do desktop são preservados;
o Cloud passa a usar a mesma identidade em todas as páginas de conta.
Rollback reverte os assets e seu manifesto. Não há mudança de dados ou API.

## Evidência

- [Pacote e contrato de consumo](../../packages/design-system/README.md).
- [Guia do Design System](../architecture/design-system.md).
- [Galeria independente](../../packages/design-system/index.html).
- [Verificação de consumo isolado](../../e2e/design-system.spec.ts).
- [Interações do desktop](../../e2e/ui.spec.ts).
