# Catálogo pessoal e itens locais

Status: implementado; decisão no [ADR 0020](../decisions/0020-personal-catalog-and-local-items.md),
que substitui o [ADR 0019](../decisions/0019-cloud-catalog.md).

## Autoria e disponibilidade

O navegador oferece `/catalog`, com cadastro, edição e exclusão de MCPs,
plugins e skills da conta autenticada. Cada desktop reúne essas definições
com seus próprios itens. Criar ou instalar um item no desktop é local por
padrão, inclusive quando há conta. Conectar nunca publica o hub inteiro.

`Compartilhar na nuvem` publica uma definição e estabelece um vínculo:
edições posteriores atualizam a conta. `Criar cópia local` cria outra
definição, sem vínculo, e conserva a compartilhada. Uma cópia de plugin
referencia os mesmos arquivos instalados; remover qualquer dessas definições
não apaga o clone compartilhado. Para modificar os arquivos independentemente,
cadastre outro diretório. Skills copiadas têm pacote e conteúdo próprios.

MCPs recebidos entram no hub, sem conexão ou ativação automática. Plugins e
skills recebidos aparecem como disponíveis, com `Instalar aqui`. A seleção
por workspace/conversa continua determinando o que os providers recebem.
O desktop busca atualizações no login, ao recuperar foco, a cada 60 segundos
enquanto visível e em **Atualizar conta**. Não há WebSocket de catálogo.
Alterações na origem de um plugin exigem `Usar nova origem`; sincronizar
metadados não substitui um clone por código novo automaticamente. O editor
desktop altera a descrição de plugins compartilhados; a origem é editada no
SaaS, preservando a diferença entre definição e instalação local. Atualizar
um repositório continua sendo uma ação explícita no desktop.

Excluir pelo navegador remove a definição compartilhada. Os desktops
conservam os registros e arquivos já instalados como locais. Excluir um MCP
ou plugin compartilhado pelo desktop exige confirmação de exclusão na nuvem.
Remover uma skill do Mac apenas desinstala seu registro: ela volta à lista de
itens disponíveis. Sair da conta mantém os hubs e esquece os vínculos.

## Documento e HTTP

Uma conta tem no máximo um documento JSON de 256 KB:

```ts
type Doc = {
  plugins: { id: string; source: string; note: string }[];
  mcp: { id: string; config: object; note: string }[];
  skills: { id: string; description: string; content: string }[];
  actions: Catalog | null;
};
```

`skills` é aditivo: documentos antigos omitem a coleção. A API preserva
skills existentes quando um desktop antigo envia PUT sem essa chave. Enviar
`skills: []` remove suas definições. Ações anteriores conservam o contrato
existente; ainda não possuem editor no SaaS nem controle individual de compartilhamento.

| Rota | Autenticação | Corpo e resultado |
| --- | --- | --- |
| `GET /api/catalog` | Bearer desktop | `{ catalog: Doc ou null, revision: number ou null }` |
| `PUT /api/catalog` | Bearer desktop | `{ catalog: Doc, revision }`; retorna documento e revisão |
| `/catalog` e `/catalog/:kind` | cookie de navegador e CSRF | CRUD de item em `plugins`, `mcp` ou `skills` |

`revision: null` significa primeira gravação. Revisão diferente devolve 409,
sem escrever. Browser conserva o rascunho para revisão; desktop atualiza seu
cache e informa conflito, sem reenviar silenciosamente. Editores desktop
levam a revisão de quando foram abertos; um refresh no fundo não autoriza
sobrescrever outra edição. Falha de rede impede somente a edição compartilhada.
Edições privadas continuam disponíveis offline.

O servidor valida tipos, nomes únicos, origens remotas e limites antes de
persistir. IDs de skills seguem `[a-z0-9][a-z0-9-]{0,55}`; descrição tem até
2000 caracteres e conteúdo até 65536 bytes. O conteúdo é corpo Markdown,
sem frontmatter: o desktop gera nome e descrição com strings YAML escapadas.

Plugins guardam endereço Git ou URL de `.zip`, nunca upload de pasta local.
MCPs guardam o comando portátil ou URL e argumentos. Valores de `env` e
`headers` ficam vazios na nuvem; o servidor recusa valores preenchidos.
Credenciais são preenchidas em cada Mac e preservadas durante atualizações.
Argumentos e textos livres são conteúdo publicado pela pessoa: não coloque
segredos neles. O serviço não executa comandos, instala plugins nem acessa
as origens cadastradas.

## Identidade e persistência local

`<root>/catalog.json` guarda `{ revision, doc, links }`. `links` mapeia
`<tipo>:<id na conta>` para um ID local. Nomes privados ocupados recebem um
ID distinto para a definição remota (`cloud-<nome>-<n>`), preservando o item
privado. Cache antigo sem `links` migra os vínculos históricos por nome.
Trocar de conta/origem esquece o cache anterior, conservando itens locais.

`<root>/skills.json` guarda definições instaladas. Cada skill é materializada
em `<root>/skills-packages/<id>/`, com manifestos Claude/Codex e
`skills/<id>/SKILL.md`. O hub de plugins contém `skill-<id>` e reutiliza
seleção e adapters existentes. Esses pacotes aparecem na página Skills e
nos seletores, sem duplicar cadastro na página Plugins.

Cada catálogo pertence à pessoa (`user_id`) ou à organização (`organization_id`),
com exclusividade no banco. O desktop sincroniza o catálogo pessoal e lista
plugins, MCPs e skills de todas as organizações com matrícula aceita. Cada item
institucional mostra o nome da organização e `Instalar aqui`, sem exigir cópia
para a conta pessoal. A instalação cria um registro local independente, sem
ativação automática nem publicação. No Cloud, dono e administradores fazem CRUD;
copiar definições entre catálogos continua opcional. Ver [organizações](cloud-organizations.md)
e [ADR 0039](../decisions/0039-organization-catalog-on-desktop.md).

`GET /api/organizations/:id/catalog` aceita Bearer e retorna o mesmo envelope
`{ catalog, revision }` do catálogo pessoal, com autorização pela matrícula atual.
O desktop enumera `GET /api/organizations` e busca cada documento separadamente,
preservando o limite por resposta. 404 remove a disponibilidade daquele catálogo
e permite compatibilidade com Cloud antigo. Falhas de rede preservam o cache.

`catalog.json` acrescenta `organizations: [{ id, name, revision, doc, links }]`, ausente
em caches antigos. Esses `links` identificam instalações locais por tipo e ID;
nunca participam de PUTs pessoais. Colisões usam IDs locais distintos, inclusive
entre organizações e itens pessoais ainda não instalados. Refresh atualiza as
definições disponíveis; instalações e credenciais continuam independentes. Sair
da conta ou perder matrícula conserva registros e arquivos instalados.

## IPC

| Comando | Argumentos | Retorno |
| --- | --- | --- |
| `catalog_state` | nenhum | connected, revision, plugins, mcp, skills e shared |
| `catalog_refresh` | nenhum | vazio; busca definições da conta |
| `catalog_share` | kind, id local | vazio; publica e vincula |
| `catalog_copy` | kind, id local, newId | vazio; cria definição privada |
| `catalog_install_plugin` | id da conta | vazio; instala origem selecionada |
| `catalog_install_skill` | id da conta | vazio; materializa skill |
| `catalog_install_organization_item` | organization, kind, id, revision | vazio; verifica matrícula e revisão exibida e instala localmente |
| `skill_hub` | nenhum | Skill[] instaladas |
| `skill_save` | skill, revision | Skill[]; publica somente se vinculada |
| `skill_remove` | id local | Skill[]; remove somente deste Mac |

`plugin_save` e `mcp_save` também recebem `revision` quando editam um item
compartilhado. Novos itens privados não precisam de revisão. O evento
`catalog` atualiza hubs e marcas da interface. `plugins` e `skills` no estado
incluem `local_id` e `installed`; plugins também incluem `source_changed`.
`shared` mapeia `<tipo>:<id local>` para o ID na conta.
O campo aditivo `organization_items` contém `{ organization, organization_name,
revision, kind, id, description, installed }`. O frontend tolera sua ausência. A instalação
consulta novamente o catálogo da organização; se o documento mudou, atualiza o
cache e retorna conflito antes de instalar. MCPs institucionais entram no hub
somente após `Instalar aqui`, com credenciais vazias.

## Evidência

- `src-tauri/src/catalog.rs`: migração de vínculos, colisão de nomes, preservação
  de itens privados e credenciais, rejeição de documentos malformados.
- `src-tauri/src/skills.rs`: validação, isolamento de diretórios, frontmatter,
  manifestos dos dois providers e atualização de conteúdo.
- `e2e/cloud.spec.ts`: instalação, compartilhamento explícito, cópia privada,
  edição offline e conflito de revisão sobre mock.
- `prometeu-cloud/test/integration/catalog_test.rb` e `catalog_browser_test.rb`:
  autenticação, isolamento por conta, CRUD browser/API, conflito e compatibilidade.
- `prometeu-cloud/test/browser/catalog.spec.js`: formulários Rails reais,
  CSRF, consumo da API desktop e layout em Chromium/WebKit.
