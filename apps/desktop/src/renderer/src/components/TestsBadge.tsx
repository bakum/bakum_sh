import { Badge, Stack, Text, Tooltip } from '@mantine/core';
import type { TestsResult } from '@bm/shared';
import { t } from '../i18n';

/** «Test: Success / Warnings / Failed» of a build (spec 8.8); `—` when its tests did not run. */
export function TestsBadge({ tests, onClick }: { tests: TestsResult | null; onClick?: () => void }) {
  if (!tests) {
    return (
      <Tooltip label={t('tests.notRun')}>
        <Badge variant="outline" color="gray" size="sm">
          Test: —
        </Badge>
      </Tooltip>
    );
  }
  const failed = tests.failed + tests.errors > 0;
  const color = failed ? 'red' : tests.warnings ? 'orange' : 'teal';
  const text = failed ? 'Failed' : tests.warnings ? 'Warnings' : 'Success';
  const total = tests.passed + tests.failed + tests.errors;
  return (
    <Tooltip
      multiline
      w={420}
      label={
        <Stack gap={2}>
          <Text size="xs">
            {t('tests.summary', { total, passed: tests.passed, failed: tests.failed, errors: tests.errors, warnings: tests.warnings })}
          </Text>
          {tests.failures.slice(0, 8).map((f) => (
            <Text key={f} size="xs" ff="monospace">
              {f}
            </Text>
          ))}
          {tests.failures.length > 8 && <Text size="xs">{t('tests.more', { n: tests.failures.length - 8 })}</Text>}
          {onClick && <Text size="xs" c="dimmed">{t('tests.click')}</Text>}
        </Stack>
      }
    >
      <Badge variant="light" color={color} size="sm" style={onClick ? { cursor: 'pointer' } : undefined} onClick={onClick} data-testid="tests-badge">
        Test: {text}
      </Badge>
    </Tooltip>
  );
}
