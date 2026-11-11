import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/yaml/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { parseDocument } from "yaml";

globalThis.MonacoEnvironment = {
  /**
   * Starts the worker of the editor services.
   * @returns The worker.
   */
  getWorker(): Worker {
    return new EditorWorker();
  },
};

/**
 * Marks the YAML syntax errors and warnings of a model.
 * @param model The model.
 */
function markYamlProblems(model: monaco.editor.ITextModel): void {
  const document = parseDocument(model.getValue(), { prettyErrors: false });
  const problems = [
    ...document.errors.map((problem) => ({ problem, severity: monaco.MarkerSeverity.Error })),
    ...document.warnings.map((problem) => ({ problem, severity: monaco.MarkerSeverity.Warning })),
  ];
  monaco.editor.setModelMarkers(
    model,
    "yaml",
    problems.map(({ problem, severity }) => {
      const start = model.getPositionAt(problem.pos[0]);
      const end = model.getPositionAt(Math.max(problem.pos[1], problem.pos[0] + 1));
      return { severity, message: problem.message, startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
    }),
  );
}

monaco.editor.onDidCreateModel((model) => {
  if (model.getLanguageId() !== "yaml") {
    return;
  }

  markYamlProblems(model);
  model.onDidChangeContent(() => markYamlProblems(model));
});

export * from "monaco-editor/editor";
