/// Declare Vite ?raw text imports for TypeScript, including the bundled changelog.
declare module "*?raw" {
  const content: string;
  export default content;
}
