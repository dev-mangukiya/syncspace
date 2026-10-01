import React from 'react';

interface AnsiSpan {
  text: string;
  color?: string;
  bold?: boolean;
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: 'var(--color-text-muted)',
  31: 'var(--color-danger)',
  32: 'var(--color-success)',
  33: 'var(--color-warning)',
  34: 'var(--color-accent)',
  35: '#d946ef',
  36: '#06b6d4',
  37: 'var(--color-text)',
  90: 'var(--color-text-muted)',
  91: '#f87171',
  92: '#4ade80',
  93: '#fde047',
  94: '#60a5fa',
  95: '#e879f9',
  96: '#22d3ee',
  97: '#ffffff',
};

/**
 * parseAnsi converts ANSI escape sequences into structured segments.
 * All text is returned as plain strings to ensure React renders them safely as JSX text nodes,
 * preventing any stored or reflected XSS execution (no innerHTML / dangerouslySetInnerHTML).
 */
export function parseAnsi(input: string): AnsiSpan[] {
  if (!input) return [];

  // Regex to match ANSI escape codes: \x1b[...m
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[([0-9;]*)m/g;
  const spans: AnsiSpan[] = [];

  let lastIndex = 0;
  let currentColor: string | undefined = undefined;
  let currentBold: boolean | undefined = undefined;

  let match: RegExpExecArray | null;
  while ((match = ansiRegex.exec(input)) !== null) {
    const textBefore = input.slice(lastIndex, match.index);
    if (textBefore) {
      spans.push({
        text: textBefore,
        color: currentColor,
        bold: currentBold,
      });
    }

    const codeStr = match[1];
    if (!codeStr || codeStr === '0') {
      currentColor = undefined;
      currentBold = undefined;
    } else {
      const codes = codeStr.split(';').map(c => parseInt(c, 10));
      for (const code of codes) {
        if (code === 0) {
          currentColor = undefined;
          currentBold = undefined;
        } else if (code === 1) {
          currentBold = true;
        } else if (code === 22) {
          currentBold = false;
        } else if (code >= 30 && code <= 37) {
          currentColor = ANSI_COLOR_MAP[code];
        } else if (code === 39) {
          currentColor = undefined; // default color
        } else if (code >= 90 && code <= 97) {
          currentColor = ANSI_COLOR_MAP[code];
        }
      }
    }

    lastIndex = ansiRegex.lastIndex;
  }

  const remaining = input.slice(lastIndex);
  if (remaining) {
    spans.push({
      text: remaining,
      color: currentColor,
      bold: currentBold,
    });
  }

  return spans;
}

/**
 * AnsiRenderer renders ANSI text as an array of React <span> elements.
 * Absolutely NEVER uses dangerouslySetInnerHTML.
 */
export const AnsiRenderer: React.FC<{ text: string }> = ({ text }) => {
  const spans = parseAnsi(text);

  return (
    <>
      {spans.map((span, idx) => (
        <span
          key={idx}
          style={{
            color: span.color,
            fontWeight: span.bold ? 600 : undefined,
          }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
};
