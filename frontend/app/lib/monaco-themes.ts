import type { editor } from 'monaco-editor';

/**
 * SyncSpace Dark — Monaco theme
 * Matches --color-bg-app (#0D0F12), uses muted syntax colors.
 * No high-saturation or neon colors.
 */
export const syncspaceDark: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // General
    { token: '', foreground: 'E4E7EB', background: '0D0F12' },
    { token: 'comment', foreground: '5A6370', fontStyle: 'italic' },
    { token: 'comment.doc', foreground: '6A7380', fontStyle: 'italic' },

    // Keywords & control flow
    { token: 'keyword', foreground: 'B0A0D0' },
    { token: 'keyword.control', foreground: 'B0A0D0' },
    { token: 'keyword.operator', foreground: '9AA3AE' },
    { token: 'keyword.other', foreground: 'B0A0D0' },

    // Strings
    { token: 'string', foreground: 'A8C490' },
    { token: 'string.escape', foreground: '8BA87A' },

    // Numbers & constants
    { token: 'number', foreground: 'C9A06C' },
    { token: 'constant', foreground: 'C9A06C' },
    { token: 'constant.language', foreground: 'C9A06C' },

    // Types & classes
    { token: 'type', foreground: '7BAFCC' },
    { token: 'type.identifier', foreground: '7BAFCC' },
    { token: 'class', foreground: '7BAFCC' },

    // Functions
    { token: 'function', foreground: 'C4A8D0' },
    { token: 'function.declaration', foreground: 'C4A8D0' },

    // Variables & identifiers
    { token: 'variable', foreground: 'E4E7EB' },
    { token: 'variable.parameter', foreground: 'D0B89A' },
    { token: 'identifier', foreground: 'E4E7EB' },

    // Operators & punctuation
    { token: 'delimiter', foreground: '9AA3AE' },
    { token: 'delimiter.bracket', foreground: '9AA3AE' },
    { token: 'operator', foreground: '9AA3AE' },

    // Tags (HTML/JSX)
    { token: 'tag', foreground: '8DAFCC' },
    { token: 'attribute.name', foreground: 'C4A8D0' },
    { token: 'attribute.value', foreground: 'A8C490' },

    // Regex
    { token: 'regexp', foreground: 'C4A8D0' },

    // Markdown
    { token: 'markup.heading', foreground: '7BAFCC', fontStyle: 'bold' },
    { token: 'markup.bold', fontStyle: 'bold' },
    { token: 'markup.italic', fontStyle: 'italic' },
    { token: 'markup.inline.raw', foreground: 'A8C490' },
  ],
  colors: {
    // Editor backgrounds
    'editor.background': '#0D0F12',
    'editor.foreground': '#E4E7EB',
    'editor.lineHighlightBackground': '#191D2218',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#7BA3CC30',
    'editor.inactiveSelectionBackground': '#7BA3CC18',
    'editor.selectionHighlightBackground': '#7BA3CC15',

    // Find match
    'editor.findMatchBackground': '#C9A06C40',
    'editor.findMatchHighlightBackground': '#C9A06C20',

    // Word highlight
    'editor.wordHighlightBackground': '#7BA3CC15',
    'editor.wordHighlightStrongBackground': '#7BA3CC25',

    // Cursor
    'editorCursor.foreground': '#7BA3CC',

    // Line numbers
    'editorLineNumber.foreground': '#3A424C',
    'editorLineNumber.activeForeground': '#7A848F',

    // Indentation guides
    'editorIndentGuide.background': '#1E2329',
    'editorIndentGuide.activeBackground': '#2A3038',

    // Bracket match
    'editorBracketMatch.background': '#7BA3CC20',
    'editorBracketMatch.border': '#7BA3CC50',

    // Gutter
    'editorGutter.addedBackground': '#5B9E78',
    'editorGutter.modifiedBackground': '#C29A4B',
    'editorGutter.deletedBackground': '#C25B56',

    // Widget (autocomplete, hover, etc.)
    'editorWidget.background': '#13161A',
    'editorWidget.border': '#2A3038',

    // Suggest widget
    'editorSuggestWidget.background': '#13161A',
    'editorSuggestWidget.border': '#2A3038',
    'editorSuggestWidget.selectedBackground': '#1F242A',
    'editorSuggestWidget.highlightForeground': '#7BA3CC',

    // Scrollbar
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#2A303860',
    'scrollbarSlider.hoverBackground': '#3A424C80',
    'scrollbarSlider.activeBackground': '#3A424CA0',

    // Minimap
    'minimap.background': '#0D0F12',
    'minimapSlider.background': '#2A303840',

    // Overview ruler
    'editorOverviewRuler.border': '#00000000',

    // Diff editor
    'diffEditor.insertedTextBackground': '#5B9E7818',
    'diffEditor.removedTextBackground': '#C25B5618',
  },
};

/**
 * SyncSpace Light — Monaco theme
 * Matches --color-bg-surface (#FFFFFF), uses muted syntax colors.
 */
export const syncspaceLight: editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '16191D', background: 'FFFFFF' },
    { token: 'comment', foreground: '8B949E', fontStyle: 'italic' },
    { token: 'comment.doc', foreground: '8B949E', fontStyle: 'italic' },

    // Keywords
    { token: 'keyword', foreground: '7C3EAD' },
    { token: 'keyword.control', foreground: '7C3EAD' },
    { token: 'keyword.operator', foreground: '4F5964' },

    // Strings
    { token: 'string', foreground: '3A7A44' },
    { token: 'string.escape', foreground: '2E6335' },

    // Numbers
    { token: 'number', foreground: '9A6E30' },
    { token: 'constant', foreground: '9A6E30' },

    // Types
    { token: 'type', foreground: '2F5F8F' },
    { token: 'type.identifier', foreground: '2F5F8F' },

    // Functions
    { token: 'function', foreground: '7C3EAD' },
    { token: 'function.declaration', foreground: '7C3EAD' },

    // Variables
    { token: 'variable', foreground: '16191D' },
    { token: 'variable.parameter', foreground: '8B5C2A' },

    // Operators
    { token: 'delimiter', foreground: '4F5964' },
    { token: 'operator', foreground: '4F5964' },

    // Tags
    { token: 'tag', foreground: '2F5F8F' },
    { token: 'attribute.name', foreground: '7C3EAD' },
    { token: 'attribute.value', foreground: '3A7A44' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#16191D',
    'editor.lineHighlightBackground': '#EEF0F208',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#2F5F8F25',
    'editor.inactiveSelectionBackground': '#2F5F8F12',

    'editor.findMatchBackground': '#C29A4B30',
    'editor.findMatchHighlightBackground': '#C29A4B18',

    'editorCursor.foreground': '#2F5F8F',

    'editorLineNumber.foreground': '#C4CAD1',
    'editorLineNumber.activeForeground': '#6B7580',

    'editorIndentGuide.background': '#E8EAED',
    'editorIndentGuide.activeBackground': '#D9DDE2',

    'editorBracketMatch.background': '#2F5F8F15',
    'editorBracketMatch.border': '#2F5F8F40',

    'editorGutter.addedBackground': '#2E7D4F',
    'editorGutter.modifiedBackground': '#9A7530',
    'editorGutter.deletedBackground': '#B8413D',

    'editorWidget.background': '#FFFFFF',
    'editorWidget.border': '#D9DDE2',

    'editorSuggestWidget.background': '#FFFFFF',
    'editorSuggestWidget.border': '#D9DDE2',
    'editorSuggestWidget.selectedBackground': '#EEF0F2',
    'editorSuggestWidget.highlightForeground': '#2F5F8F',

    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#D9DDE240',
    'scrollbarSlider.hoverBackground': '#C4CAD160',
    'scrollbarSlider.activeBackground': '#C4CAD180',

    'minimap.background': '#FFFFFF',

    'editorOverviewRuler.border': '#00000000',

    'diffEditor.insertedTextBackground': '#2E7D4F15',
    'diffEditor.removedTextBackground': '#B8413D15',
  },
};
