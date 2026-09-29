import { Alert, Badge, Group, Text } from '@mantine/core';

/** A function that is not there yet (postponed or planned for stage 3): visible, with the reason. */
export function Placeholder({ what, stage }: { what: string; stage: string }) {
  return (
    <Alert color="gray" variant="light">
      <Group gap="xs" wrap="nowrap">
        <Badge color="gray" variant="filled" size="sm">
          {stage}
        </Badge>
        <Text size="sm">{what}</Text>
      </Group>
    </Alert>
  );
}
