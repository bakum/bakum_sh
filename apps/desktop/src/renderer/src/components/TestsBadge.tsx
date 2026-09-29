import { Badge, Stack, Text, Tooltip } from '@mantine/core';
import type { TestsResult } from '@bm/shared';

/** «Test: Success / Warnings / Failed» of a build (spec 8.8); `—` when its tests did not run. */
export function TestsBadge({ tests, onClick }: { tests: TestsResult | null; onClick?: () => void }) {
  if (!tests) {
    return (
      <Tooltip label="Тесты в этой сборке не запускались (tests.mode или нет модулей для тестов)">
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
            Тестов: {total}, пройдено {tests.passed}, упало {tests.failed}, ошибок {tests.errors}, предупреждений {tests.warnings}
          </Text>
          {tests.failures.slice(0, 8).map((f) => (
            <Text key={f} size="xs" ff="monospace">
              {f}
            </Text>
          ))}
          {tests.failures.length > 8 && <Text size="xs">… ещё {tests.failures.length - 8}</Text>}
          {onClick && <Text size="xs" c="dimmed">Клик — tests.log</Text>}
        </Stack>
      }
    >
      <Badge variant="light" color={color} size="sm" style={onClick ? { cursor: 'pointer' } : undefined} onClick={onClick} data-testid="tests-badge">
        Test: {text}
      </Badge>
    </Tooltip>
  );
}
