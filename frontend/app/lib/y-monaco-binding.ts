'use client';

/**
 * Inlined y-monaco MonacoBinding.
 *
 * WHY THIS EXISTS:
 * The npm `y-monaco` package has a hard top-level import:
 *
 *     import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
 *
 * This path doesn't exist in a Next.js project that uses `@monaco-editor/react`,
 * which loads Monaco from a CDN at runtime instead of bundling it from npm.
 * Neither Turbopack (dev) nor Webpack (prod) can resolve that import.
 *
 * The previous workaround — `Function('return import("y-monaco")')()` — bypassed
 * static analysis but still failed at runtime because the browser's native
 * `import()` also couldn't resolve the specifier.
 *
 * THE FIX:
 * We inline the MonacoBinding source (222 lines, MIT-licensed) and replace the
 * static `import * as monaco from '...'` with a `monaco` parameter passed in at
 * binding creation time. The Monaco namespace is available from `@monaco-editor/react`'s
 * `onMount` callback and `useMonaco()` hook. All Yjs imports (`yjs`, `lib0`, 
 * `y-protocols`) resolve normally because they have no platform-specific imports.
 *
 * Source: https://github.com/yjs/y-monaco (MIT License)
 */

import * as Y from 'yjs';
import * as error from 'lib0/error';
import { createMutex } from 'lib0/mutex';
import { Awareness } from 'y-protocols/awareness';

// Monaco types (imported for TypeScript only, not at runtime)
import type { editor as MonacoEditor, Selection, Range as MonacoRange, SelectionDirection } from 'monaco-editor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoNamespace = any;

class RelativeSelection {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
  direction: number;

  constructor(start: Y.RelativePosition, end: Y.RelativePosition, direction: number) {
    this.start = start;
    this.end = end;
    this.direction = direction;
  }
}

const createRelativeSelection = (
  editor: MonacoEditor.IStandaloneCodeEditor,
  monacoModel: MonacoEditor.ITextModel,
  type: Y.Text,
): RelativeSelection | null => {
  const sel = editor.getSelection();
  if (sel !== null) {
    const startPos = sel.getStartPosition();
    const endPos = sel.getEndPosition();
    const start = Y.createRelativePositionFromTypeIndex(type, monacoModel.getOffsetAt(startPos));
    const end = Y.createRelativePositionFromTypeIndex(type, monacoModel.getOffsetAt(endPos));
    return new RelativeSelection(start, end, sel.getDirection());
  }
  return null;
};

const createMonacoSelectionFromRelativeSelection = (
  monaco: MonacoNamespace,
  editor: MonacoEditor.IStandaloneCodeEditor,
  type: Y.Text,
  relSel: RelativeSelection,
  doc: Y.Doc,
) => {
  const start = Y.createAbsolutePositionFromRelativePosition(relSel.start, doc);
  const end = Y.createAbsolutePositionFromRelativePosition(relSel.end, doc);
  if (start !== null && end !== null && start.type === type && end.type === type) {
    const model = editor.getModel()!;
    const startPos = model.getPositionAt(start.index);
    const endPos = model.getPositionAt(end.index);
    return monaco.Selection.createWithDirection(
      startPos.lineNumber, startPos.column,
      endPos.lineNumber, endPos.column,
      relSel.direction,
    );
  }
  return null;
};

export class MonacoBinding {
  doc: Y.Doc;
  ytext: Y.Text;
  monacoModel: MonacoEditor.ITextModel;
  editors: Set<MonacoEditor.IStandaloneCodeEditor>;
  mux: ReturnType<typeof createMutex>;
  awareness?: Awareness;

  private _savedSelections: Map<MonacoEditor.IStandaloneCodeEditor, RelativeSelection>;
  private _beforeTransaction: () => void;
  private _decorations: Map<MonacoEditor.IStandaloneCodeEditor, string[]>;
  private _rerenderDecorations: () => void;
  private _ytextObserver: (event: Y.YTextEvent) => void;
  private _monacoChangeHandler: { dispose: () => void };
  private _monacoDisposeHandler: { dispose: () => void };

  /**
   * @param monaco - The Monaco namespace (from @monaco-editor/react's onMount or useMonaco)
   */
  constructor(
    monaco: MonacoNamespace,
    ytext: Y.Text,
    monacoModel: MonacoEditor.ITextModel,
    editors: Set<MonacoEditor.IStandaloneCodeEditor> = new Set(),
    awareness: Awareness | null = null,
  ) {
    this.doc = ytext.doc as Y.Doc;
    this.ytext = ytext;
    this.monacoModel = monacoModel;
    this.editors = editors;
    this.mux = createMutex();
    this._savedSelections = new Map();
    this._decorations = new Map();

    // Save selections before transactions so we can restore them after Y.Text changes
    this._beforeTransaction = () => {
      this.mux(() => {
        this._savedSelections = new Map();
        editors.forEach(editor => {
          if (editor.getModel() === monacoModel) {
            const rsel = createRelativeSelection(editor, monacoModel, ytext);
            if (rsel !== null) {
              this._savedSelections.set(editor, rsel);
            }
          }
        });
      });
    };
    this.doc.on('beforeAllTransactions', this._beforeTransaction);

    // Render remote cursors and selections as Monaco decorations
    this._rerenderDecorations = () => {
      editors.forEach(editor => {
        if (awareness && editor.getModel() === monacoModel) {
          const currentDecorations = this._decorations.get(editor) || [];
          const newDecorations: MonacoEditor.IModelDeltaDecoration[] = [];

          awareness.getStates().forEach((state, clientID) => {
            if (
              clientID !== this.doc.clientID &&
              state.selection != null &&
              state.selection.anchor != null &&
              state.selection.head != null
            ) {
              const anchorAbs = Y.createAbsolutePositionFromRelativePosition(state.selection.anchor, this.doc);
              const headAbs = Y.createAbsolutePositionFromRelativePosition(state.selection.head, this.doc);
              if (anchorAbs !== null && headAbs !== null && anchorAbs.type === ytext && headAbs.type === ytext) {
                let start, end, afterContentClassName: string | null, beforeContentClassName: string | null;
                if (anchorAbs.index < headAbs.index) {
                  start = monacoModel.getPositionAt(anchorAbs.index);
                  end = monacoModel.getPositionAt(headAbs.index);
                  afterContentClassName = 'yRemoteSelectionHead yRemoteSelectionHead-' + clientID;
                  beforeContentClassName = null;
                } else {
                  start = monacoModel.getPositionAt(headAbs.index);
                  end = monacoModel.getPositionAt(anchorAbs.index);
                  afterContentClassName = null;
                  beforeContentClassName = 'yRemoteSelectionHead yRemoteSelectionHead-' + clientID;
                }
                newDecorations.push({
                  range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                  options: {
                    className: 'yRemoteSelection yRemoteSelection-' + clientID,
                    afterContentClassName,
                    beforeContentClassName,
                  },
                });
              }
            }
          });
          this._decorations.set(editor, editor.deltaDecorations(currentDecorations, newDecorations));
        } else {
          this._decorations.delete(editor);
        }
      });
    };

    // Observe Y.Text changes → apply to Monaco model
    this._ytextObserver = (event: Y.YTextEvent) => {
      this.mux(() => {
        let index = 0;
        event.delta.forEach(op => {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (op.insert !== undefined) {
            const pos = monacoModel.getPositionAt(index);
            const range = new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
            const insert = op.insert as string;
            monacoModel.applyEdits([{ range, text: insert }]);
            index += insert.length;
          } else if (op.delete !== undefined) {
            const pos = monacoModel.getPositionAt(index);
            const endPos = monacoModel.getPositionAt(index + op.delete);
            const range = new monaco.Selection(pos.lineNumber, pos.column, endPos.lineNumber, endPos.column);
            monacoModel.applyEdits([{ range, text: '' }]);
          } else {
            throw error.unexpectedCase();
          }
        });
        this._savedSelections.forEach((rsel, editor) => {
          const sel = createMonacoSelectionFromRelativeSelection(monaco, editor, ytext, rsel, this.doc);
          if (sel !== null) {
            editor.setSelection(sel);
          }
        });
      });
      this._rerenderDecorations();
    };

    ytext.observe(this._ytextObserver);

    // Sync initial content
    const ytextValue = ytext.toString();
    if (monacoModel.getValue() !== ytextValue) {
      monacoModel.setValue(ytextValue);
    }

    // Observe Monaco model changes → apply to Y.Text
    this._monacoChangeHandler = monacoModel.onDidChangeContent(event => {
      this.mux(() => {
        this.doc.transact(() => {
          event.changes
            .sort((change1, change2) => change2.rangeOffset - change1.rangeOffset)
            .forEach(change => {
              ytext.delete(change.rangeOffset, change.rangeLength);
              ytext.insert(change.rangeOffset, change.text);
            });
        }, this);
      });
    });

    this._monacoDisposeHandler = monacoModel.onWillDispose(() => {
      this.destroy();
    });

    // Track cursor position and send via awareness
    if (awareness) {
      editors.forEach(editor => {
        editor.onDidChangeCursorSelection(() => {
          if (editor.getModel() === monacoModel) {
            const sel = editor.getSelection();
            if (sel === null) return;
            let anchor = monacoModel.getOffsetAt(sel.getStartPosition());
            let head = monacoModel.getOffsetAt(sel.getEndPosition());
            if (sel.getDirection() === monaco.SelectionDirection.RTL) {
              const tmp = anchor;
              anchor = head;
              head = tmp;
            }
            awareness.setLocalStateField('selection', {
              anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
              head: Y.createRelativePositionFromTypeIndex(ytext, head),
            });
          }
        });
        awareness.on('change', this._rerenderDecorations);
      });
      this.awareness = awareness;
    }
  }

  private _destroyed = false;

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      this._monacoChangeHandler?.dispose();
    } catch { /* ignore */ }
    try {
      this._monacoDisposeHandler?.dispose();
    } catch { /* ignore */ }
    try {
      this.ytext?.unobserve(this._ytextObserver);
    } catch { /* ignore */ }
    try {
      this.doc?.off('beforeAllTransactions', this._beforeTransaction);
    } catch { /* ignore */ }
    if (this.awareness) {
      try {
        this.awareness.off('change', this._rerenderDecorations);
      } catch { /* ignore */ }
    }
  }
}
