# ADR 0018: receber promessas de arquivos do macOS

Status: aceito.

## Contexto

A miniatura de uma captura de tela anuncia uma promessa de arquivo, não um
caminho já existente. O wry 0.55.1 usado pelo app lê `NSFilenamesPboardType`;
o frontend só conhece caminhos. Reiniciar não adiciona o tipo de arraste
ausente nem materializa a captura.

## Opções consideradas

- Exigir salvar no Finder: mantém o problema do gesto esperado pela pessoa.
- Desativar o arraste nativo e copiar todo `File` do navegador: perde os
  caminhos originais usados pelo chat e pelo terminal.
- Adaptar `NSFilePromiseReceiver` no backend: preserva os caminhos normais e
  usa a operação nativa específica para capturas ainda não salvas.

## Decisão

Registrar os tipos aceitos por `NSFilePromiseReceiver` na webview principal,
preservando o mecanismo de drag do Tauri. Reter os receptores no início do
gesto e materializá-los ao soltar, numa pasta privada por gesto. Os bindings
Objective-C já fazem parte das dependências transitivas do Tauri.

O evento interno `file-drag` unifica caminhos imediatos e promessas. `pending`
captura o destino na UI; `received` entrega os caminhos sem recalcular o alvo.
O AppKit recebe os arquivos em uma fila; uma espera limitada reúne resultados
fora da thread principal. Transcripts, providers e relay continuam consumindo
o contrato de caminhos existente.

## Consequências

O app depende da API pública AppKit nessa borda. Arquivos recebidos ficam fora
do worktree e persistem para não quebrar referências no histórico; não há
coleta automática. Mesmo um drop fora de um destino aceito pela UI pode ser
materializado, pois o Tauri já aceita o gesto nativo antes do hit test no DOM.
Falhas e timeouts produzem aviso; arquivos recebidos com sucesso são preservados.

## Evidência

- [Documentação Apple](https://developer.apple.com/documentation/appkit/supporting-table-view-drag-and-drop-through-file-promises).
- `src-tauri/src/file_drop.rs`: registro, recebimento, validação do destino e testes.
- `e2e/file-drop.spec.ts`: fases assíncronas, troca de aba, falha, repetição,
  Finder, lançador e terminal em Chromium e WebKit sobre mock.
- Gesto real da miniatura confirmado no Prometeu Dev em 2026-09-06, após
  registrar `on_webview_event`: com `unstable`, `on_window_event` não recebe
  o arraste da webview principal. O diagnóstico nativo confirmou a sequência
  de entrada, movimento e drop, com um `NSFilePromiseReceiver`.
