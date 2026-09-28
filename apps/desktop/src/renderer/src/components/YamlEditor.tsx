import { useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { useComputedColorScheme } from '@mantine/core';
import { setYamlSchema } from '../lib/monaco';
import { useBm } from '../lib/query';

/** Monaco YAML editor with the zod-generated schema of the given kind (project / app / branch). */
export function YamlEditor(props: {
  value: string;
  onChange?: (v: string) => void;
  schema: 'project' | 'app' | 'branch' | null;
  height?: number | string;
  readOnly?: boolean;
  path: string;
}) {
  const scheme = useComputedColorScheme('light');
  const schemas = useBm('config.jsonSchema', {}, { staleTime: Infinity });
  useEffect(() => {
    if (schemas.data && props.schema) setYamlSchema(props.schema, schemas.data[props.schema]);
  }, [schemas.data, props.schema]);
  return (
    <Editor
      height={props.height ?? 480}
      language="yaml"
      path={props.schema ? `${props.path}/${props.schema}.yaml` : `${props.path}.yaml`}
      value={props.value}
      theme={scheme === 'dark' ? 'vs-dark' : 'light'}
      onChange={(v) => props.onChange?.(v ?? '')}
      options={{
        readOnly: props.readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        tabSize: 2,
        automaticLayout: true,
        quickSuggestions: { other: true, strings: true, comments: false },
      }}
    />
  );
}
