/// Arquivo de texto importado como texto. O Vite entende `?raw`; o TypeScript,
/// só depois disto. Hoje é o `CHANGELOG.md`, que a tela de novidades lê.
declare module "*?raw" {
  const content: string;
  export default content;
}
