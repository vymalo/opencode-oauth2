import Parser from "tree-sitter";
import TS from "tree-sitter-typescript";

import type { Extraction, RefEdge, SymbolDef } from "./types.js";

const MODULE = "<module>";

/** Map a file extension (no dot) to a tree-sitter grammar, or null if unsupported. */
export function grammarForExtension(ext: string): unknown | null {
  switch (ext.toLowerCase()) {
    case "ts":
    case "mts":
    case "cts":
    case "js": // TS grammar is a superset of JS
    case "mjs":
    case "cjs":
      return TS.typescript;
    case "tsx":
    case "jsx":
      return TS.tsx;
    default:
      return null;
  }
}

export const SUPPORTED_EXTENSIONS = ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"] as const;

function nameOf(node: Parser.SyntaxNode): string | null {
  const n = node.childForFieldName("name");
  return n ? n.text : null;
}

/**
 * Parse one source string into definitions + call edges. Deliberately a *sound
 * but partial* graph (see docs/code-index.md §resolution): only bare-identifier
 * calls, `new Ctor()`, and `this.method()` become edges — generic `obj.method()`
 * is dropped because most of it is library/builtin noise we can't resolve
 * without type info, and emitting it would pollute the call graph.
 */
export function extractFromSource(source: string, ext: string): Extraction {
  const grammar = grammarForExtension(ext);
  if (!grammar) {
    return { defs: [], refs: [] };
  }
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);

  const defs: SymbolDef[] = [];
  const refs: RefEdge[] = [];

  const walk = (node: Parser.SyntaxNode, enclosing: string): void => {
    let current = enclosing;
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const nm = nameOf(node);
        if (nm) {
          defs.push({ name: nm, kind: "function", line: node.startPosition.row + 1 });
          current = nm;
        }
        break;
      }
      case "method_definition": {
        const nm = nameOf(node);
        if (nm) {
          defs.push({ name: nm, kind: "method", line: node.startPosition.row + 1 });
          current = nm;
        }
        break;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const nm = nameOf(node);
        if (nm) {
          defs.push({ name: nm, kind: "class", line: node.startPosition.row + 1 });
        }
        break;
      }
      case "variable_declarator": {
        const nm = nameOf(node);
        const val = node.childForFieldName("value");
        if (nm && val && (val.type === "arrow_function" || val.type === "function_expression")) {
          defs.push({ name: nm, kind: "function", line: node.startPosition.row + 1 });
          current = nm;
        }
        break;
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const line = node.startPosition.row + 1;
        if (fn?.type === "identifier") {
          refs.push({
            caller: enclosing,
            dstName: fn.text,
            kind: "call",
            line,
            confidence: "name"
          });
        } else if (fn?.type === "member_expression") {
          const obj = fn.childForFieldName("object");
          const prop = fn.childForFieldName("property");
          // Only `this.method()` is resolvable without type info; drop the rest.
          if (obj?.type === "this" && prop) {
            refs.push({
              caller: enclosing,
              dstName: prop.text,
              kind: "method",
              line,
              confidence: "this"
            });
          }
        }
        break;
      }
      case "new_expression": {
        const ctor = node.childForFieldName("constructor");
        if (ctor?.type === "identifier") {
          refs.push({
            caller: enclosing,
            dstName: ctor.text,
            kind: "new",
            line: node.startPosition.row + 1,
            confidence: "name"
          });
        }
        break;
      }
    }
    for (const child of node.namedChildren) {
      walk(child, current);
    }
  };

  walk(tree.rootNode, MODULE);
  return { defs, refs };
}
