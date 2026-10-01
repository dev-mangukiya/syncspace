'use client';

/**
 * Wrapper for the inlined MonacoBinding.
 * 
 * This module re-exports the MonacoBinding from our inlined copy of y-monaco
 * and provides a convenience factory that matches the call signature used in
 * the workspace page component.
 *
 * The binding requires the Monaco namespace (for Selection, Range, SelectionDirection)
 * which is available from @monaco-editor/react's onMount callback.
 */

import type { editor as MonacoEditor } from 'monaco-editor';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { MonacoBinding } from './y-monaco-binding';

export type { MonacoBinding };

export interface YMonacoBindingWrapper {
  destroy: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoLike = any;

/**
 * Create a MonacoBinding connecting Y.Text ↔ Monaco editor model.
 * 
 * @param monacoNamespace - The Monaco API namespace (from editor.onMount or useMonaco()).
 *   We use `any` because @monaco-editor/react's onMount provides a Monaco object that
 *   doesn't exactly match the full `typeof import('monaco-editor')` type.
 */
export function createYMonacoBinding(
  monacoNamespace: MonacoLike,
  ytext: Y.Text,
  model: MonacoEditor.ITextModel,
  editors: Set<MonacoEditor.IStandaloneCodeEditor>,
  awareness: Awareness,
): YMonacoBindingWrapper {
  return new MonacoBinding(monacoNamespace, ytext, model, editors, awareness);
}
