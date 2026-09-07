# ADR 0019 — Catálogo portátil na conta Prometeu

Data: 2026-09-06
Status: Substituído pelo [ADR 0020](0020-personal-catalog-and-local-items.md)

## Contexto

Com a conta opcional publicada, o mantenedor passa a usar o Prometeu em dois
Macs. Plugins, servidores MCP e Ações eram cadastrados por máquina, em
`plugins.json`, `mcp.json` e `board.actions`. Repetir o cadastro à mão diverge
com o tempo, e nada dizia qual Mac tinha a versão certa.

Ao mesmo tempo, a conta continua opcional: o desktop precisa funcionar sem
rede e sem cadastro. E o SaaS não recebe segredos de providers.

## Opções consideradas

1. Sincronização bidirecional com merge: cada Mac edita offline e reconcilia
   depois. Exige resolução de conflitos e uma UI para explicá-los.
2. Exportar e importar um arquivo à mão. Não diverge menos; só muda quem copia.
3. O SaaS é o repositório do catálogo; o desktop é cache e materializador.
   Edição vai primeiro à nuvem; instalação e segredos ficam por Mac.

## Decisão

Adotar a opção 3. O SaaS guarda um documento por conta com o que é
declaração: plugins com endereço (`from` ou URL de `.zip`), a forma de cada
servidor MCP sem os valores de `env` e `headers`, e o catálogo de Ações
inteiro. O desktop guarda o documento em `<root>/catalog.json` com a revisão
lida por último.

Cada gravação de plugin com endereço, servidor MCP ou Ações vai antes à nuvem
por `PUT /api/catalog` com a revisão conhecida. A nuvem responde 409 com o
documento atual quando outro Mac gravou antes; o desktop aplica esse
documento, refaz a edição em cima e tenta uma vez. Sem resposta da nuvem, a
edição falha com erro visível e o hub local não muda. Sem conta, nada disso
acontece e os hubs continuam locais.

`cloud_status` com `refresh` e a conclusão do login puxam o documento. Nuvem
vazia recebe o catálogo deste Mac. Nuvem com catálogo ganha: o que este Mac
tinha vai uma vez para `<root>/catalog.local.json`. Plugin `.zip` por URL
entra no hub local sozinho; repositório aparece como "não instalado" até a
pessoa mandar clonar. Servidor MCP entra com as chaves e valores vazios;
valores já preenchidos neste Mac sobrevivem a atualizações da forma. Plugin
apontado para pasta local nunca vai à nuvem e fica marcado "só neste Mac".

Sair da conta apaga o cache e mantém o que está instalado. Excluir a conta no
SaaS apaga o documento junto.

## Consequências

Positivas:

- um cadastro vale para todos os Macs da pessoa, sem merge nem UI de conflito;
- segredos, clones, `codex-workspaces/` e seleção por workspace continuam
  por máquina, como antes;
- a conta segue opcional: sem ela, nenhuma linha de código de rede roda.

Negativas:

- com conta e sem rede, cadastrar plugin com endereço, MCP ou Ação falha até a
  rede voltar; leitura e sessões continuam funcionando;
- `overrides` de Ações são chaveados pelo id do projeto, que é deste board;
  em outro Mac ficam sem efeito até um id estável de projeto existir;
- o documento é gravado inteiro, com limite de 256 KB;
- uma edição feita no Mac B entre a leitura e a gravação do Mac A custa uma
  tentativa a mais, nunca uma perda silenciosa.

## Evidência

- `src-tauri/src/catalog.rs`: forma sem segredo, merge dos valores locais e
  regra de portabilidade em testes unitários;
- `prometeu-cloud/test/integration/catalog_test.rb`: isolamento por conta,
  revisão, 409 com documento atual, limites e exclusão em cascata;
- [`contracts/cloud-catalog.md`](../contracts/cloud-catalog.md).
