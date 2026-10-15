// Minimal S-expression reader for KiCad files (port of exporter/sexp.py).
// A node is an array whose first element is its tag; atoms are strings (numbers stay strings).

export type Node = (string | Node)[];

const TOKEN = /\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+/g;

export function parse(text: string): Node {
  const stack: Node[] = [[]];
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0];
    if (tok === "(") {
      const node: Node = [];
      stack[stack.length - 1].push(node);
      stack.push(node);
    } else if (tok === ")") {
      stack.pop();
      if (!stack.length) throw new Error("unbalanced s-expression");
    } else if (tok[0] === '"') {
      stack[stack.length - 1].push(unquote(tok.slice(1, -1)));
    } else {
      stack[stack.length - 1].push(tok);
    }
  }
  if (stack.length !== 1 || stack[0].length !== 1) throw new Error("unbalanced s-expression");
  return stack[0][0] as Node;
}

function unquote(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t" })[c] ?? c);
}

const isNode = (c: unknown): c is Node => Array.isArray(c) && c.length > 0;

export function children(node: Node, tag: string): Node[] {
  return node.slice(1).filter((c): c is Node => isNode(c) && c[0] === tag);
}

export function child(node: Node | undefined, tag: string): Node | undefined {
  if (!node) return undefined;
  for (const c of node.slice(1)) if (isNode(c) && c[0] === tag) return c;
  return undefined;
}

/** First atom of the child `tag`, e.g. value(fp, "layer") -> "F.Cu". */
export function value(node: Node | undefined, tag: string): string | undefined {
  const c = child(node, tag);
  return c && c.length > 1 && typeof c[1] === "string" ? c[1] : undefined;
}

/** Numeric atoms of `node` (or of its child `tag`). */
export function floats(node: Node | undefined, tag?: string): number[] {
  const n = tag !== undefined ? child(node, tag) : node;
  if (!n) return [];
  const out: number[] = [];
  for (const a of n.slice(1)) {
    if (typeof a === "string" && a !== "" && !Number.isNaN(Number(a))) out.push(Number(a));
  }
  return out;
}

export function hasAtom(node: Node, atom: string): boolean {
  return node.slice(1).some((a) => a === atom);
}
