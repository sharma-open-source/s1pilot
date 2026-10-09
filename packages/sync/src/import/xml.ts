import { importError } from './types.js';

/** Minimal XML element tree (enough for TestRail exports; no namespaces or DTDs). */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Parses an XML document into a tree. Comments, processing instructions and CDATA are handled. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1] as XmlNode;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length < 2 || top.name !== m[2]) importError(`XML: unexpected closing tag </${m[2]}>`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1] as string] = decode(a[2] ?? a[3] ?? '');
      const node: XmlNode = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) importError(`XML: unclosed tag <${(stack[stack.length - 1] as XmlNode).name}>`);
  const first = root.children[0];
  if (!first) importError('XML document is empty');
  return first;
}

/** First direct child with the given name. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** Direct children with the given name. */
export function childrenOf(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Trimmed text of a direct child, or `''`. */
export function textOf(node: XmlNode, name: string): string {
  return (child(node, name)?.text ?? '').trim();
}
