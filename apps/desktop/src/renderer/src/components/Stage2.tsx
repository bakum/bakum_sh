import { Alert, Badge, Group, Text } from '@mantine/core';

/** Placeholder for functions planned for a later stage (they stay visible, disabled). */
export function Stage2({ what, stage = 'этап 2' }: { what: string; stage?: string }) {
  return (
    <Alert color="gray" variant="light">
      <Group gap="xs">
        <Badge color="gray" variant="filled" size="sm">
          {stage}
        </Badge>
        <Text size="sm">{what}</Text>
      </Group>
    </Alert>
  );
}
