# ADR 0037 — browser com contexto visual para a conversa

Data: 2026-09-10
Status: Aceito

## Contexto

O preview nativo substituía a conversa e interceptava arrastes que o app
ignorava por serem de outra webview. Seleção de HTML, estilos e captura não
existia. Designers precisam apontar a interface em execução e anexar esse
contexto ao rascunho da conversa.

## Opções consideradas

- Trocar o motor do aplicativo: amplia distribuição e manutenção antes de
  demonstrar uma limitação que impeça esse fluxo.
- Usar iframe no produto: facilita composição DOM, mas não atende páginas que
  proíbem enquadramento nem dá acesso de inspeção entre origens.
- Manter WKWebView, coordenar seu ciclo de vida e capturar contexto por script
  fixo com retorno validado: reutiliza o motor e preserva isolamento de origem.

## Decisão

Manter webview por workspace e exibir a conversa simultaneamente. A apresentação
serializa efeitos de visibilidade e invalida continuações antigas. A filha
entrega uploads ao WebKit; a view principal conserva o recebimento nativo de
anexos definido no [ADR 0018](0018-native-file-promises.md).

Inspeção é explícita. Script pertencente ao bundle destaca e descreve elementos;
Rust consulta um resultado limitado, sem abrir IPC geral para a página. Captura
usa a API pública WKSnapshotConfiguration. HTML, estilos, URL e PNG entram no
rascunho por ação da pessoa, reutilizando o contrato de mensagens e anexos.

## Consequências

A camada nativa ainda exige suspensão durante overlays e testes próprios no
macOS. Captura é do viewport, com recorte opcional, e não da página inteira.
Não implementa editor CSS ao vivo, árvore de componentes de framework ou
resolução automática de código fonte. O mock interativo é uma fixture de UI,
não substitui essa verificação nativa.

Não há mudança em estado persistido, transcript, providers ou relay. O IPC novo
é aditivo e seu formato é testado; não há migração de dados.

## Evidência

- [Contrato do browser](../contracts/browser.md), com testes e limites.
- [Cursor Design Mode](https://cursor.com/docs/agent/design-mode): referência de
  interação para selecionar elementos e acrescentar contexto à conversa.
- [Tauri Webview](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html):
  avaliação com retorno na webview.
