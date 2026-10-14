import type { TrackerDefect } from './types.js';

/** A block of an issue body, tracker-neutral. */
export interface Section {
  heading: string;
  paragraphs?: string[];
  /** Ordered list when `ordered`, bullets otherwise. */
  items?: string[];
  ordered?: boolean;
}

/** Sections of the issue body: repro steps, expected / actual, environment. */
export function buildSections(d: TrackerDefect, attachmentNames: string[] = []): Section[] {
  const out: Section[] = [];
  if (d.description) out.push({ heading: 'Description', paragraphs: [d.description] });
  if (d.stepsToReproduce.length > 0) out.push({ heading: 'Steps to reproduce', items: d.stepsToReproduce, ordered: true });
  out.push({ heading: 'Expected', paragraphs: [d.expected || 'Not recorded'] });
  out.push({ heading: 'Actual', paragraphs: [d.actual || 'Not recorded'] });
  const env = [
    d.environment ? `Environment: ${d.environment}` : '',
    d.browser ? `Browser: ${d.browser}` : '',
    d.buildRef ? `Build: ${d.buildRef}` : '',
    d.sourceLabel ? `Source: ${d.sourceLabel}` : '',
    `Severity: ${d.severity}`,
  ].filter(Boolean);
  out.push({ heading: 'Environment', items: env });
  if (attachmentNames.length > 0) out.push({ heading: 'Attachments', items: attachmentNames });
  return out;
}

/** Markdown rendering (GitHub, Linear). */
export function toMarkdown(sections: Section[], footer = 'Reported by s1pilot'): string {
  const parts = sections.map((s) => {
    const lines = [...(s.paragraphs ?? []), ...(s.items ?? []).map((i, n) => (s.ordered ? `${n + 1}. ${i}` : `- ${i}`))];
    return `## ${s.heading}\n\n${lines.join(s.items ? '\n' : '\n\n')}`;
  });
  return `${parts.join('\n\n')}\n\n---\n${footer}\n`;
}

interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
}

const adfText = (text: string): AdfNode[] => (text === '' ? [] : [{ type: 'text', text }]);
const adfParagraph = (text: string): AdfNode => ({ type: 'paragraph', content: adfText(text) });

/** Atlassian Document Format rendering (Jira Cloud REST v3). */
export function toAdf(sections: Section[], footer = 'Reported by s1pilot'): { type: 'doc'; version: 1; content: AdfNode[] } {
  const content: AdfNode[] = [];
  for (const s of sections) {
    content.push({ type: 'heading', attrs: { level: 3 }, content: adfText(s.heading) });
    for (const p of s.paragraphs ?? []) content.push(adfParagraph(p));
    if (s.items && s.items.length > 0) {
      content.push({
        type: s.ordered ? 'orderedList' : 'bulletList',
        content: s.items.map((i) => ({ type: 'listItem', content: [adfParagraph(i)] })),
      });
    }
  }
  content.push(adfParagraph(footer));
  return { type: 'doc', version: 1, content };
}
