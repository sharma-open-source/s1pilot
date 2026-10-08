/** A parsed XML element. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/** Parses well-formed XML (elements, attributes, text, entities, declaration). Throws on malformed input. */
export function parseXml(xml: string): XmlElement {
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`XML error at ${i}: ${msg}`);
  };
  const decode = (s: string): string =>
    s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      return String.fromCodePoint(e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10));
    });
  const skipWs = (): void => {
    while (i < xml.length && /\s/.test(xml[i] ?? '')) i++;
  };
  if (xml.startsWith('<?xml')) i = xml.indexOf('?>') + 2;
  const element = (): XmlElement => {
    skipWs();
    if (xml[i] !== '<') fail('expected "<"');
    i++;
    const name = /^[A-Za-z_][\w.-]*/.exec(xml.slice(i))?.[0] ?? fail('bad element name');
    i += name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWs();
      if (xml[i] === '/' || xml[i] === '>') break;
      const a = /^([A-Za-z_][\w.:-]*)="([^"<]*)"/.exec(xml.slice(i));
      if (!a || a[1] === undefined || a[2] === undefined) return fail('bad attribute');
      if (Object.hasOwn(attrs, a[1])) fail(`duplicate attribute ${a[1]}`);
      attrs[a[1]] = decode(a[2]);
      i += a[0].length;
    }
    const el: XmlElement = { name, attrs, children: [], text: '' };
    if (xml[i] === '/') {
      if (xml.slice(i, i + 2) !== '/>') fail('bad empty element');
      i += 2;
      return el;
    }
    i++;
    for (;;) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) fail(`unclosed <${name}>`);
      el.text += decode(xml.slice(i, lt));
      i = lt;
      if (xml[i + 1] === '/') {
        const close = new RegExp(`^</${name}\\s*>`).exec(xml.slice(i));
        if (!close) return fail(`mismatched close tag for <${name}>`);
        i += close[0].length;
        return el;
      }
      el.children.push(element());
    }
  };
  const root = element();
  skipWs();
  if (i < xml.length) fail('content after the root element');
  return root;
}

const NUM = /^\d+(\.\d+)?$/;
const INT = /^\d+$/;

/**
 * Structural validation of JUnit XML against the commonly used JUnit XSD (Jenkins / Ant flavour):
 * element nesting (`testsuites > testsuite > testcase > failure|error|skipped|system-out`), required
 * attributes and numeric attribute formats, plus counters that add up. Returns the list of problems
 * (empty when valid). Throws only for XML that is not well-formed.
 */
export function validateJunit(xml: string): string[] {
  const root = parseXml(xml);
  const problems: string[] = [];
  const need = (el: XmlElement, attr: string, pattern?: RegExp): string | undefined => {
    const v = el.attrs[attr];
    if (v === undefined) problems.push(`<${el.name}> is missing "${attr}"`);
    else if (pattern && !pattern.test(v)) problems.push(`<${el.name} ${attr}="${v}"> has the wrong format`);
    return v;
  };
  if (root.name !== 'testsuites') problems.push(`root must be <testsuites>, got <${root.name}>`);
  need(root, 'tests', INT);
  need(root, 'failures', INT);
  need(root, 'errors', INT);
  need(root, 'time', NUM);
  const sum = { tests: 0, failures: 0, errors: 0 };
  for (const suite of root.children) {
    if (suite.name !== 'testsuite') {
      problems.push(`<testsuites> may only contain <testsuite>, got <${suite.name}>`);
      continue;
    }
    const label = suite.attrs['name'] ?? '';
    need(suite, 'name');
    need(suite, 'time', NUM);
    const counted = { failures: 0, errors: 0, skipped: 0 };
    for (const tc of suite.children) {
      if (tc.name !== 'testcase') {
        problems.push(`<testsuite> may only contain <testcase>, got <${tc.name}>`);
        continue;
      }
      need(tc, 'name');
      need(tc, 'classname');
      need(tc, 'time', NUM);
      const results = tc.children.filter((c) => ['failure', 'error', 'skipped'].includes(c.name));
      if (results.length > 1) problems.push(`testcase "${tc.attrs['name'] ?? ''}" has more than one result element`);
      for (const c of tc.children) {
        if (!['failure', 'error', 'skipped', 'system-out', 'system-err'].includes(c.name)) problems.push(`unexpected <${c.name}> in <testcase>`);
        if ((c.name === 'failure' || c.name === 'error') && c.attrs['message'] === undefined) problems.push(`<${c.name}> is missing "message"`);
        if (c.name === 'failure') counted.failures++;
        if (c.name === 'error') counted.errors++;
        if (c.name === 'skipped') counted.skipped++;
      }
    }
    const tests = suite.children.length;
    if (need(suite, 'tests', INT) !== String(tests)) problems.push(`suite "${label}": tests does not match its testcase count`);
    for (const k of ['failures', 'errors', 'skipped'] as const) {
      if (suite.attrs[k] !== undefined && suite.attrs[k] !== String(counted[k])) problems.push(`suite "${label}": ${k} does not match`);
    }
    sum.tests += tests;
    sum.failures += counted.failures;
    sum.errors += counted.errors;
  }
  if (root.attrs['tests'] !== String(sum.tests)) problems.push('testsuites: tests does not equal the sum over suites');
  if (root.attrs['failures'] !== String(sum.failures)) problems.push('testsuites: failures does not equal the sum over suites');
  if (root.attrs['errors'] !== String(sum.errors)) problems.push('testsuites: errors does not equal the sum over suites');
  return problems;
}
