import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/register.all'
import 'monaco-editor/languages/features/json/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import { parseDocument } from 'yaml'

globalThis.MonacoEnvironment = {
  /**
   * Starts the worker of a language service, or of the editor services for the other languages.
   * @param _workerId The identifier of the worker.
   * @param label The language the worker serves.
   * @returns The worker.
   */
  getWorker (_workerId: string, label: string): Worker {
    return label === 'json' ? new JsonWorker() : new EditorWorker()
  }
}

/** The file names, extensions and name patterns Monaco does not associate with their language out of the box. */
const FILE_LANGUAGES: monaco.languages.ILanguageExtensionPoint[] = [
  { id: 'ini', extensions: ['.env', '.toml', '.conf'], filenames: ['.npmrc'], filenamePatterns: ['.env.*'] },
  { id: 'shell', extensions: ['.zsh'], filenames: ['Makefile', '.zshrc', '.bashrc', '.profile'] },
  { id: 'json', extensions: ['.jsonc', '.json5'] },
  { id: 'dockerfile', filenamePatterns: ['Dockerfile.*'] }
]
FILE_LANGUAGES.forEach(language => monaco.languages.register(language))

/**
 * Finds the language matching a name such as the tag of a Markdown code fence, by its identifier, alias or extension.
 * @param name The name, such as `ts`, `bash` or `json`.
 * @returns The identifier of the language, if any.
 */
export function languageNamed (name: string): string | undefined {
  const key = name.toLowerCase()
  return monaco.languages.getLanguages().find(({ id, aliases = [], extensions = [] }) =>
    [id, ...aliases].some(alias => alias.toLowerCase() === key) || extensions.includes(`.${key}`)
  )?.id
}

/**
 * Marks the YAML syntax errors and warnings of a model.
 * @param model The model.
 */
function markYamlProblems (model: monaco.editor.ITextModel): void {
  const document = parseDocument(model.getValue(), { prettyErrors: false })
  const problems = [
    ...document.errors.map(problem => ({ problem, severity: monaco.MarkerSeverity.Error })),
    ...document.warnings.map(problem => ({ problem, severity: monaco.MarkerSeverity.Warning }))
  ]
  monaco.editor.setModelMarkers(
    model,
    'yaml',
    problems.map(({ problem, severity }) => {
      const start = model.getPositionAt(problem.pos[0])
      const end = model.getPositionAt(Math.max(problem.pos[1], problem.pos[0] + 1))
      return { severity, message: problem.message, startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
    })
  )
}

monaco.editor.onDidCreateModel(model => {
  if (model.getLanguageId() !== 'yaml') {
    return
  }

  markYamlProblems(model)
  model.onDidChangeContent(() => markYamlProblems(model))
})

export * from 'monaco-editor/editor'
