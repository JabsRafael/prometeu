# ADR 0017 — Componentes executáveis do Design System

Data: 2026-09-06
Status: aceito. Substitui a separação de comportamento do
[ADR 0016](0016-company-design-system.md). Preserva os contratos do
[ADR 0011](0011-shared-ui.md).

## Contexto

Distribuir CSS e SVG unificou a aparência, mas manteve renderização e interação
dentro de cada produto. O Design System precisa fornecer componentes prontos,
incluindo estado, eventos, foco, teclado, validação e lifecycle.

## Decisão

`@prometeu/design-system` 0.2.0 passa a possuir as primitivas DOM, menus,
ícones genéricos, formulários e estilos necessários às interações. `src/ui.ts`
e `src/menu.ts` no desktop ficam como reexports de compatibilidade. Nenhum
componente do pacote importa módulos do aplicativo ou regras de providers.

O pacote distribui módulos ESM, tipos TypeScript e um bundle de navegador.
TypeScript e Vite já existentes no projeto geram o artefato; consumidores não
precisam de framework ou dependências JavaScript em runtime.

Para o Rails, o mesmo pacote fornece um FormBuilder e helpers que renderizam
campos completos, botões e contêineres. Views compõem essas APIs em vez de
repetir markup dos controles. O runtime compartilhado conecta menus, senhas,
confirmações opcionais, validação e proteção contra envio duplicado. Formulários
mantêm submissão Rails, valores do submitter e CSRF. Sem JavaScript, os controles
essenciais continuam nativos; autorização nunca depende do runtime.

O Cloud vendoriza assets compilados e o adaptador Ruby, com hashes e versão.
Somente `vendor/design-system/assets` entra no pipeline público. Sua CSP permite
scripts locais e nonce, sem scripts inline livres, `eval` ou fontes externas.
Código Ruby, banco, tokens e credenciais não entram no bundle.

## Alternativas e consequências

Adotar React exigiria substituir a apresentação do desktop e do Rails.
Web Components exigiriam reescrever primitivas existentes e adaptar campos à
submissão nativa. Extrair o código DOM existente e adicionar um adaptador Rails
mantém ambos os produtos convencionais e conserva os comportamentos testados.

Existem dois renderizadores no pacote, DOM e Action View, adequados aos seus
ambientes. Classes e acessibilidade têm um contrato compartilhado e testes em
Chromium e WebKit. Interações do navegador têm uma implementação JavaScript
única. Layout de produto, regras de negócio e traduções permanecem externos.

O build do pacote passa a ser necessário para distribuir novas versões. O
Cloud não precisa de Node para construir ou executar o serviço. Rollback
reverte runtime, estilos, adaptador e manifesto juntos. Não há mudança de API,
IPC, dados persistidos ou conteúdo enviado ao serviço.

## Evidência

- [API e integração](../../packages/design-system/README.md).
- [Componentes executáveis](../../packages/design-system/src/index.ts).
- [Adaptador Rails](../../packages/design-system/rails/prometeu_design_system.rb).
- [Galeria independente](../../packages/design-system/index.html).
- [Testes de comportamento](../../e2e/design-system.spec.ts).
- [Compatibilidade das telas](../../e2e/actions.spec.ts).
