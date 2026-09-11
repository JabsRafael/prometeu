# Browser e contexto visual

Status: implementado. Decisão: [ADR 0037](../decisions/0037-browser-design-context.md).

## Apresentação e ciclo de vida

Cada workspace local mantém uma webview nativa `run-<id>`. A conversa continua
visível ao lado do preview; trocar de conversa preserva a página. Arquivos,
Mudanças e terminais substituem essa composição. Fechar o browser destrói a
webview; sair do workspace apenas a esconde.

`src/browser.ts` serializa abertura, posicionamento, ocultação e fechamento.
Uma geração invalida aberturas e consultas de URL antigas. Uma geração da
seleção também invalida capturas após nova inspeção, navegação ou alteração
da largura. Menus, diálogos, popovers e feedback suspendem a view nativa;
redimensionar a divisão também a suspende, para preservar eventos do ponteiro.
Abrir o browser recolhe o painel direito de Arquivos, Mudanças, Review e
terminais de apoio para dar espaço à conversa e à página. O botão do painel
permite reabri-lo durante o preview. Sair do browser ou do workspace restaura
a visibilidade anterior do painel.

A largura escolhida é um máximo, limitada pelo espaço disponível. Não há
emulação de dispositivo, user-agent ou viewport maior que a superfície nativa.

## IPC aditivo

Os comandos antigos de navegação e bounds permanecem compatíveis. Novos comandos
existem no registro Rust, em `src/ipc.ts` e no mock:

| Comando | Argumentos | Retorno |
| --- | --- | --- |
| `browser_inspect` | `{ id, enabled }` | `void` |
| `browser_selection` | `{ id }` | `{ active, selection }` |
| `browser_capture` | `{ id, rect? }` | caminho absoluto de PNG privado |

`selection` é `null` ou:

```ts
{
  url: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
}
```

`rect` usa pixels CSS relativos ao viewport da página. Seletores atravessando
Shadow DOM aberto separam hosts com ` >>> `; essa convenção é contexto textual,
não um seletor CSS único. Conteúdo interno de iframes e Shadow DOM fechado não
é inspecionado. Não há associação garantida com componentes ou arquivos fonte.

## Confiança e limites

O backend injeta somente o script fixo de `src/browser-inspector.js`. Nenhum
comando recebe JavaScript arbitrário e nenhuma capability remota é adicionada.
A página continua não confiável: Rust desserializa e limita o resultado antes
de entregá-lo à interface. HTML e CSS são exibidos com `textContent`.

O script limita HTML a 12.000 unidades UTF-16, texto a 2.000, seletor a 1.000 e
URL a 4.096; cada estilo tem até 1.000. Remove valores de formulário, handlers
e conteúdo executável do trecho copiado. Rust admite o tamanho UTF-8
correspondente, limita o objeto a 256 KiB e recusa campos desconhecidos,
URL fora de HTTP(S), geometria inválida e mais de 64 propriedades de estilo.

A avaliação tem timeout de 3 segundos. A captura macOS usa a API pública
`WKWebView.takeSnapshot`, sem capturar a tela inteira e sem permissão de gravação
da tela. Recorta a seleção aos limites atuais; sem `rect`, captura o viewport
visível. Tem timeout de 5 segundos, limite de PNG de 20 MiB e grava em
`<root>/attachments/<uuid>/browser.png` com as permissões privadas existentes.
Antes e depois do recorte, confirma que o elemento continua conectado, na mesma
geometria, URL e viewport, sem scroll ou resize desde a seleção. Uma mudança
descarta somente o PNG, preservando o contexto textual escolhido. Isso não
congela animações ou garante que o conteúdo visual da página permaneça imóvel.
Fora do macOS, captura retorna `err.browser.captureFailed`. Falhas de inspeção
retornam `err.browser.inspectFailed`.

Selecionar um elemento prepara contexto e captura. **Adicionar ao chat** cria
uma tag **Elemento selecionado**, separada do texto digitado. A tag reúne dados
e PNG, permite revisar detalhes e pode ser removida inteira antes do envio.
Rascunhos mantêm essas tags por conversa, inclusive entre mesa e workspace.
Falha de captura preserva a tag com os dados textuais. A captura avulsa retém
o destino da conversa antes do IPC e usa o bloqueio de anexos pendentes existente.

## Contexto no texto da mensagem

A [decisão 0038](../decisions/0038-browser-context-chips.md) mantém IPC,
Conversation Events V1 e relay inalterados. Somente no envio cada tag vira um
bloco identificado dentro de `text`:

```text
<prometeu-browser-element v="1">
{"selection":{...},"image":"/caminho/browser.png"}
@"/caminho/browser.png"
</prometeu-browser-element>
```

O JSON completo ocupa uma linha; `<` nos valores vira `\u003c`. `selection`
segue o DTO acima. Sem captura, `image` é omitido e a linha da menção fica vazia.
A menção mantém o mecanismo de anexos já entendido pelos agentes. Não há
leitura local automática ao abrir um histórico ou uma conversa compartilhada.
Os blocos precedem o texto digitado, assim como anexos comuns, para que um
texto iniciado por `/` não descarte o contexto ao virar um comando do provider.

`src/browser-context.ts` reconhece apenas versão, estrutura e limites válidos,
com menção correspondente ao PNG declarado. Blocos inválidos ou desconhecidos
continuam como texto literal. Desktop e celular apresentam os blocos válidos
como tags também no histórico e durante espera de envio. O reducer e os
adapters conservam os dados completos; clientes antigos exibem o texto bruto.
Não há reescrita de transcripts anteriores nem migração de dados.

É possível enviar somente tags, combiná-las com texto e outros anexos, ou
usá-las como contexto em Ações. O envio conserva o tratamento existente de
erros e da fila persistida; a apresentação não reenfileira mensagens.

## Arraste

Somente a view principal adapta arquivos locais e promessas ao evento
`file-drag` existente. A filha desabilita a interceptação de drag do Tauri para
permitir uploads dentro da página. Soltar no chat segue o fluxo de anexos;
soltar no preview pertence à página. Isso evita que o Tauri consuma o upload
para depois ignorar seu evento por não vir de `main`.

## Evidência e limites da verificação

- `e2e/browser-inspector.spec.ts`: script real em Chromium e WebKit, seleção,
  Escape, navegação, sanitização, Shadow DOM, scroll e resize.
- `e2e/browser.spec.ts`: composição, rascunhos, anexos, navegação e ciclo de vida
  sobre o mock web, tags e conteúdo efetivo enviado ao agente.
- `src/browser-context.test.ts`: compatibilidade textual e rejeição de blocos
  inválidos sem ocultar conteúdo comum.
- `e2e/mobile.spec.ts`: tags e detalhes no histórico compartilhado em tela estreita.
- `src-tauri/src/browser.rs`: validação dos DTOs, recortes e limites.
- `e2e/file-drop.spec.ts`: contrato de anexos e promessas no frontend.

`src/mock-browser.ts` usa iframe somente no desenvolvimento web, com página
controlada e o mesmo script de inspeção. Capturas retornam caminhos fictícios.
Esses testes não provam PNG nativo, gesto AppKit ou consumo da imagem pelo CLI.
A verificação de gesto nativo neste ambiente permanece bloqueada por permissão
de Acessibilidade; isso não é evidência de aprovação desse gesto.
