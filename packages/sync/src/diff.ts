/**
 * Unified diff of two texts (line based, LCS). Returns `''` when they are equal.
 * Small inputs only (O(n*m)): meant for test-case YAML files.
 */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string, context = 3): string {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (r: number, c: number): number => (table[r] as number[])[c] as number;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (table[i] as number[])[j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  interface Op {
    t: ' ' | '-' | '+';
    s: string;
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ t: ' ', s: x[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ t: '-', s: x[i++] as string });
    } else {
      ops.push({ t: '+', s: y[j++] as string });
    }
  }
  while (i < n) ops.push({ t: '-', s: x[i++] as string });
  while (j < m) ops.push({ t: '+', s: y[j++] as string });

  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  const changed = ops.flatMap((op, idx) => (op.t === ' ' ? [] : [idx]));
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, (changed[k] as number) - context);
    let end = Math.min(ops.length, (changed[k] as number) + context + 1);
    let next = k + 1;
    while (next < changed.length && (changed[next] as number) - context <= end) {
      end = Math.min(ops.length, (changed[next] as number) + context + 1);
      next++;
    }
    const slice = ops.slice(start, end);
    const before = ops.slice(0, start);
    const aStart = before.filter((o) => o.t !== '+').length + 1;
    const bStart = before.filter((o) => o.t !== '-').length + 1;
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const op of slice) out.push(`${op.t}${op.s}`);
    k = next;
  }
  return `${out.join('\n')}\n`;
}
