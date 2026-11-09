// Loaded lazily (React.lazy) so Monaco and its workers stay out of the initial bundle.
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { useEffect, useRef } from "react";
import { useResolvedTheme } from "../stores/preferences";

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    return new EditorWorker();
  },
};
// Use the bundled copy instead of @monaco-editor/react's default CDN download.
loader.config({ monaco });

// Mirror the judge's libraries (packages/runner/src/harness.ts COMPILER_OPTIONS) so the editor
// flags what the judge rejects (e.g. ES2023 `toSorted`) and accepts what it allows (`console`,
// `setTimeout`, which come from the DOM lib).
const compilerOptions = {
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  strict: true,
  noEmit: true,
  allowNonTsExtensions: true,
  lib: ["es2022", "dom"],
};
monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
monaco.typescript.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });

export interface CodeEditorProps {
  /** Unique per draft so each draft gets its own model and undo history. */
  path: string;
  language: string;
  preview?: boolean;
  value: string;
  fontSize: number;
  wordWrap?: boolean;
  onChange: (value: string) => void;
  onRun: () => void;
  onSubmit: () => void;
  /** Ctrl/Cmd+S. Drafts already save on every edit, so this only confirms it. */
  onSave?: () => void;
}

export default function CodeEditor(props: CodeEditorProps) {
  // Monaco registers actions once; keep the latest callbacks in refs.
  const run = useRef(props.onRun);
  const submit = useRef(props.onSubmit);
  const save = useRef(props.onSave);
  const value = useRef(props.value);
  useEffect(() => {
    run.current = props.onRun;
    submit.current = props.onSubmit;
    save.current = props.onSave;
    value.current = props.value;
  });
  const theme = useResolvedTheme();

  const onMount: OnMount = (editor) => {
    // Monaco picks CRLF for single-line models on Windows user agents. Keep drafts LF everywhere.
    const normalizeEol = () => editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);
    normalizeEol();
    editor.onDidChangeModel(normalizeEol);
    editor.addAction({
      id: "bekor.run",
      label: props.preview ? "Refresh preview" : "Run public tests",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => run.current(),
    });
    editor.addAction({
      id: "bekor.submit",
      label: props.preview ? "Refresh preview" : "Submit solution",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => submit.current(),
    });
    // Without this the browser's "Save page as" dialog opens.
    editor.addAction({
      id: "bekor.save",
      label: "Save draft",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save.current?.(),
    });
  };

  return (
    <Editor
      path={props.path}
      language={props.language}
      value={props.value}
      theme={theme === "dark" ? "vs-dark" : "vs"}
      onChange={(next) => {
        // Line-ending normalization alone is not a learner edit.
        if ((next ?? "") !== value.current) props.onChange(next ?? "");
      }}
      onMount={onMount}
      loading={<div className="editor-loading">Loading editor…</div>}
      options={{
        fontSize: props.fontSize,
        wordWrap: props.wordWrap ? "on" : "off",
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
