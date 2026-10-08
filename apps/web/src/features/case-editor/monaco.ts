import type * as Monaco from 'monaco-editor/editor/editor.api';

let loading: Promise<typeof Monaco> | undefined;

/**
 * Lazily loads Monaco with only the YAML language and the base editor worker (so the case editor's main
 * chunk stays small). Rejects when the worker cannot start; callers fall back to a plain textarea.
 */
export function loadMonaco(): Promise<typeof Monaco> {
  loading ??= (async () => {
    const [monaco, worker] = await Promise.all([
      import('monaco-editor/editor/editor.api'),
      import('monaco-editor/editor/editor.worker?worker'),
      import('monaco-editor/languages/definitions/yaml/register'),
    ]);
    (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new worker.default() };
    return monaco;
  })();
  return loading;
}
