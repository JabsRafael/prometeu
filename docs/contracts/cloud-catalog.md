# Catálogo na conta Prometeu

Status: implementado; decisão no [ADR 0019](../decisions/0019-cloud-catalog.md).

## Documento

Uma conta tem no máximo um documento JSON, com até 256 KB:

```ts
type Doc = {
  plugins: { id: string; source: string; note: string }[];
  mcp: { id: string; config: object; note: string }[];
  actions: Catalog | null; // Board.actions, ver actions.md
};
```

`plugins[].source` é o endereço de origem: `from` de um plugin clonado ou a
URL de um `.zip`. Caminho local nunca entra. `mcp[].config` é o objeto do
hub com todo valor de `env` e `headers` trocado por `""`; as chaves ficam.

## HTTP (Bearer do desktop)

| Rota | Corpo | Retorno |
| --- | --- | --- |
| `GET /api/catalog` | nenhum | `{ catalog: Doc \| null, revision: number \| null }` |
| `PUT /api/catalog` | `{ catalog: Doc, revision: number \| null }` | mesmo objeto, ou 409 com o documento atual |

`revision` é a revisão lida por último; `null` significa "ainda não existe".
Revisão diferente da guardada, ou `null` quando já existe, devolve 409 e o
documento vigente. Corpo que não é objeto devolve 400; acima do limite, 413.
Excluir a conta apaga o documento.

## Desktop

`<root>/catalog.json` guarda `{ revision, doc }`. Sem `cloud.json`, o módulo
não faz nada. Regras:

- `plugin_save`, `plugin_install`, `mcp_save`, `mcp_remove`, `plugin_remove` e
  `actions_save` gravam primeiro na nuvem quando há conta; erro de rede
  interrompe a gravação local. Plugin sem endereço grava só localmente.
- `cloud_status({ refresh: true })` e o fim do login chamam `pull`: nuvem vazia
  recebe o catálogo local; revisão nova aplica o documento aos hubs deste Mac.
- Aplicar: plugin `.zip` por URL entra no hub; repositório fica pendente;
  plugin que sumiu da nuvem sai daqui, apagando a pasta que o Prometeu criou.
  Servidor MCP novo entra com valores vazios; existente recebe a forma nova e
  mantém os valores locais. Ações substituem `Board.actions` após validação.
- Primeira conexão com nuvem já preenchida guarda o catálogo local anterior em
  `<root>/catalog.local.json`.
- `cloud_logout` apaga o cache; os hubs locais ficam como estão.

## IPC

| Comando | Argumentos | Retorno |
| --- | --- | --- |
| `catalog_state` | nenhum | `{ connected, plugins: Portable[], mcp: string[] }` |
| `catalog_refresh` | nenhum | vazio; erro de rede como `err.cloud.network` |

O evento `catalog` avisa a webview que os hubs mudaram por causa da nuvem. A
tela marca cada linha como "na nuvem" ou "só neste Mac" e lista plugins da
nuvem ainda não instalados com o botão de instalar.

## Evidência

- `src-tauri/src/catalog.rs`: testes de forma sem segredo, merge e portabilidade.
- `prometeu-cloud/test/integration/catalog_test.rb`: contrato HTTP completo.
- `e2e/cloud.spec.ts`: marcas e plugin pendente no mock após conectar.
