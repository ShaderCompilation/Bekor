// Loaded lazily (React.lazy) so Monaco and its workers stay out of the initial bundle.
import type { Language } from "@bekor/contracts";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { useEffect, useRef } from "react";

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
};
// Use the bundled copy instead of @monaco-editor/react's default CDN download.
loader.config({ monaco });

const compilerOptions = {
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  strict: true,
  noEmit: true,
  allowNonTsExtensions: true,
  lib: ["es2023"],
};
monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
monaco.typescript.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });

export interface CodeEditorProps {
  /** Unique per draft so each draft gets its own model and undo history. */
  path: string;
  language: Language;
  value: string;
  fontSize: number;
  onChange: (value: string) => void;
  onRun: () => void;
  onSubmit: () => void;
}

export default function CodeEditor(props: CodeEditorProps) {
  // Monaco registers actions once; keep the latest callbacks in refs.
  const run = useRef(props.onRun);
  const submit = useRef(props.onSubmit);
  useEffect(() => {
    run.current = props.onRun;
    submit.current = props.onSubmit;
  });
  const prefersDark =
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

  const onMount: OnMount = (editor) => {
    editor.addAction({
      id: "bekor.run",
      label: "Run public tests",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => run.current(),
    });
    editor.addAction({
      id: "bekor.submit",
      label: "Submit solution",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => submit.current(),
    });
  };

  return (
    <Editor
      path={props.path}
      language={props.language}
      value={props.value}
      theme={prefersDark ? "vs-dark" : "vs"}
      onChange={(value) => props.onChange(value ?? "")}
      onMount={onMount}
      loading={<div className="editor-loading">Loading editor…</div>}
      options={{
        fontSize: props.fontSize,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        automaticLayout: true,
        ariaLabel: "Solution code editor. Press Ctrl+M to toggle Tab focus moving.",
        accessibilitySupport: "auto",
        fixedOverflowWidgets: true,
      }}
    />
  );
}
