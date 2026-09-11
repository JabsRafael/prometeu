# ADR 0039 — Catálogos da organização disponíveis no desktop

Data: 2026-09-11
Status: Aceito. Substitui parcialmente o [ADR 0021](0021-cloud-organizations.md)
quanto à necessidade de copiar itens para o catálogo pessoal antes de instalá-los.

## Contexto

O catálogo da organização já contém definições portáteis, mas exigir uma cópia
no navegador impede sua descoberta no lugar onde a pessoa instala ferramentas.

## Decisão

O desktop lista plugins, MCPs e skills de todas as organizações com matrícula
aceita, junto aos hubs existentes, com o nome da organização e `Instalar aqui`.
A organização ativa no relay não filtra essas definições. Instalação é explícita
e cria um registro local independente, sem escrever no catálogo pessoal ou
institucional e sem ativar ferramentas em conversas.

Cada catálogo é lido por Bearer em uma rota própria, respeitando o limite de
256 KB por documento e a autorização pela matrícula atual. O refresh existente
atualiza a disponibilidade. Antes de instalar, o desktop verifica novamente
o acesso e a definição exibida; mudanças exigem rever a lista atualizada.

O cache mantém os IDs locais instalados por organização, tipo e item. Nomes
ocupados recebem outro ID, usando a regra de colisão já existente. Atualizações
da organização não substituem código, configurações ou credenciais instaladas.
Revogação retira a disponibilidade no próximo refresh, preservando instalações.

## Alternativas e consequências

Copiar pelo navegador continua disponível, mas deixa de ser requisito. Mesclar
organizações no documento pessoal confundiria autorização, revisões e propriedade.
Sincronizar instalações continuamente exigiria resolver edições locais e fontes
alteradas; esta mudança se limita à descoberta e instalação direta.

Não há migração do servidor. Publique primeiro o Cloud e depois o desktop.
Cloud antigo responde 404 e mantém o catálogo pessoal funcionando. Clientes
antigos ignoram o campo aditivo do cache; arquivos instalados permanecem locais.

## Evidência

- `src-tauri/src/catalog.rs`: colisões, credenciais, instalação local e cache antigo.
- `e2e/cloud.spec.ts`: descoberta e instalação sem copiar para a conta.
- Cloud, `test/integration/organizations_test.rb`: Bearer, matrícula, revogação e isolamento.
