// tree-sitter-typescript ships no type declarations. It exports two grammars.
declare module "tree-sitter-typescript" {
  const grammars: { typescript: unknown; tsx: unknown };
  export default grammars;
}
