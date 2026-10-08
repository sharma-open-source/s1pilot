import { useEffect, useRef, useState } from 'react';

import { loadMonaco } from './monaco';

import { Textarea } from '@/components/ui';

export interface YamlMarker {
  line: number;
  column: number;
  message: string;
}

interface YamlEditorProps {
  value: string;
  onChange: (value: string) => void;
  markers: YamlMarker[];
  /** Ctrl/Cmd+S inside the editor. */
  onSave?: () => void;
  label: string;
}

/**
 * Monaco editor in YAML mode. Monaco loads lazily; until it is ready (or when it cannot start, e.g. without a
 * Worker) a plain monospace textarea edits the same value.
 */
export function YamlEditor({ value, onChange, markers, onSave, label }: YamlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<'loading' | 'monaco' | 'fallback'>('loading');
  const editorRef = useRef<import('monaco-editor/editor/editor.api').editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoRef = useRef<typeof import('monaco-editor/editor/editor.api') | undefined>(undefined);
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };

  useEffect(() => {
    let disposed = false;
    loadMonaco()
      .then((monaco) => {
        if (disposed || !host.current) return;
        monacoRef.current = monaco;
        const editor = monaco.editor.create(host.current, {
          value,
          language: 'yaml',
          ariaLabel: label,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 13,
          scrollBeyondLastLine: false,
          tabSize: 2,
          theme: getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'vs-dark' : 'vs',
        });
        editor.onDidChangeModelContent(() => latest.current.onChange(editor.getValue()));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave?.());
        editorRef.current = editor;
        setReady('monaco');
      })
      .catch(() => {
        if (!disposed) setReady('fallback');
      });
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value, ready]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      'yaml-validate',
      markers.map((m) => ({
        severity: monaco.MarkerSeverity.Error,
        message: m.message,
        startLineNumber: m.line,
        startColumn: m.column,
        endLineNumber: m.line,
        endColumn: m.column + 1,
      })),
    );
  }, [markers, ready]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={host}
        hidden={ready !== 'monaco'}
        className="h-[480px] overflow-hidden rounded-control border border-line-input"
        data-testid="yaml-monaco"
      />
      {ready !== 'monaco' && (
        <Textarea
          aria-label={label}
          mono
          spellCheck={false}
          className="h-[480px] text-[13px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
