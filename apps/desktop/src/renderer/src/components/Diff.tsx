import { Box, Text } from '@mantine/core';
import { t } from '../i18n';

/** Colored line diff of a settings change (`+ ` added, `- ` removed). */
export function Diff({ text }: { text: string }) {
  return (
    <Box
      component="pre"
      m={0}
      p="xs"
      style={{ fontSize: 12, fontFamily: 'Cascadia Mono, Consolas, monospace', whiteSpace: 'pre-wrap', border: '1px solid var(--mantine-color-default-border)', borderRadius: 4 }}
    >
      {text ? (
        text.split('\n').map((l, i) => (
          <div
            key={i}
            style={{
              color: l.startsWith('+ ') ? 'var(--mantine-color-teal-7)' : l.startsWith('- ') ? 'var(--mantine-color-red-7)' : undefined,
              background: l.startsWith('+ ') ? 'var(--mantine-color-teal-light)' : l.startsWith('- ') ? 'var(--mantine-color-red-light)' : undefined,
            }}
          >
            {l}
          </div>
        ))
      ) : (
        <Text size="xs" c="dimmed">
          {t('audit.noChanges')}
        </Text>
      )}
    </Box>
  );
}
