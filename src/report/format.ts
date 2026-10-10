import type { Change, Report, Severity } from '../types.js';

export type Format = 'text' | 'markdown' | 'json';
export const FORMATS: readonly Format[] = ['text', 'markdown', 'json'];

export interface FormatOptions {
  color?: boolean;
  /** Include safe changes in text/markdown output (JSON always includes everything). */
  showSafe?: boolean;
}

export function formatReport(report: Report, format: Format, options: FormatOptions = {}): string {
  switch (format) {
    case 'json':
      return JSON.stringify(report, null, 2);
    case 'markdown':
      return formatMarkdown(report, options);
    case 'text':
      return formatText(report, options);
  }
}

// ---------------------------------------------------------------------- text

const ANSI = { red: 31, yellow: 33, green: 32, dim: 2, bold: 1, cyan: 36 } as const;

function formatText(report: Report, { color = false, showSafe = true }: FormatOptions): string {
  const paint = (style: keyof typeof ANSI, s: string) => (color ? `\x1b[${ANSI[style]}m${s}\x1b[0m` : s);
  const badge: Record<Severity, string> = {
    breaking: paint('red', paint('bold', '✖ BREAKING')),
    review: paint('yellow', paint('bold', '▲ REVIEW  ')),
    safe: paint('green', '✔ SAFE    '),
  };
  const { breaking, review } = report.summary;
  const lines: string[] = [];

  lines.push(paint('bold', 'ContractGuard compatibility report'));
  lines.push(
    `${paint('red', `${breaking} breaking`)} · ${paint('yellow', `${review} need review`)} · ${paint('green', `${report.summary.safe} safe`)}`,
  );

  if (report.changes.length === 0) {
    lines.push('', paint('green', 'No contract changes detected.'));
    return lines.join('\n');
  }

  const safe = report.changes.filter((c) => c.severity === 'safe');
  for (const change of report.changes) {
    if (change.severity === 'safe') continue;
    lines.push('', `${badge[change.severity]} ${paint('bold', change.endpoint)}`);
    lines.push(`  ${change.message}`);
    lines.push(`  ${paint('dim', 'at: ')}  ${change.location}`);
    lines.push(`  ${paint('dim', 'why:')}  ${change.reason}`);
    if (change.suggestion) lines.push(`  ${paint('cyan', 'fix:')}  ${change.suggestion}`);
  }

  if (showSafe && safe.length) {
    lines.push('');
    for (const c of safe) lines.push(`${badge.safe} ${paint('bold', c.endpoint)}  ${c.message}`);
  }

  return lines.join('\n');
}

// ------------------------------------------------------------------ markdown

const MD_ICON: Record<Severity, string> = { breaking: '🔴', review: '🟡', safe: '🟢' };
const MD_TITLE: Record<Severity, string> = {
  breaking: 'Breaking changes',
  review: 'Needs review',
  safe: 'Safe changes',
};

function formatMarkdown(report: Report, { showSafe = true }: FormatOptions): string {
  const { breaking, review, safe } = report.summary;
  const verdict =
    breaking > 0
      ? '🔴 **This change breaks the API contract.**'
      : review > 0
        ? '🟡 **No proven breaking changes, but some need review.**'
        : '🟢 **Compatible with the previous contract.**';

  const out: string[] = ['## ContractGuard report', '', verdict, ''];
  out.push('| Breaking | Needs review | Safe |', '|---:|---:|---:|', `| ${breaking} | ${review} | ${safe} |`);

  for (const severity of ['breaking', 'review', 'safe'] as const) {
    const changes = report.changes.filter((c) => c.severity === severity);
    if (changes.length === 0 || (severity === 'safe' && !showSafe)) continue;

    out.push('', `### ${MD_ICON[severity]} ${MD_TITLE[severity]}`, '');
    if (severity === 'safe') {
      // Safe changes are informational: keep them compact and collapsed.
      out.push('<details><summary>Show safe changes</summary>', '');
      for (const c of changes) out.push(`- **${escape(c.endpoint)}**: ${c.message}`);
      out.push('', '</details>');
      continue;
    }
    for (const c of changes) out.push(markdownChange(c));
  }

  return out.join('\n');
}

function markdownChange(c: Change): string {
  const lines = [
    `#### \`${c.endpoint}\`: ${c.message}`,
    '',
    `- **Location:** ${escape(c.location)}`,
    `- **Why:** ${c.reason}`,
  ];
  if (c.suggestion) lines.push(`- **Suggested fix:** ${c.suggestion}`);
  lines.push('');
  return lines.join('\n');
}

function escape(s: string): string {
  return s.replace(/([|*_<>])/g, '\\$1');
}
