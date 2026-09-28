/** Monaco bundled locally (no CDN) with the YAML language server worker (monaco-yaml). */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import { configureMonacoYaml, type MonacoYaml } from 'monaco-yaml';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import YamlWorker from 'monaco-yaml/yaml.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(id: string, label: string): Worker };
  }
}

window.MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'yaml' ? new YamlWorker() : new EditorWorker();
  },
};

loader.config({ monaco });

let yaml: MonacoYaml | null = null;
const schemas = new Map<string, unknown>();

/** Registers a JSON schema for editors whose model URI ends with `fileMatch`. */
export function setYamlSchema(name: string, schema: unknown): void {
  schemas.set(name, schema);
  const list = [...schemas.entries()].map(([n, s]) => ({ uri: `bm://schemas/${n}.json`, fileMatch: [`**/${n}.yaml`], schema: s as object }));
  if (!yaml) yaml = configureMonacoYaml(monaco, { enableSchemaRequest: false, validate: true, completion: true, hover: true, schemas: list });
  else yaml.update({ schemas: list });
}

export { monaco };
