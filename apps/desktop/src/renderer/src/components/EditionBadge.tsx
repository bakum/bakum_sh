import { Badge, Code, Group, Text, Tooltip } from '@mantine/core';
import type { OdooEdition } from '@bm/shared';
import { t } from '../i18n';

const LABEL = { enterprise: 'Enterprise', community: 'Community' } as const;
const SHORT = { enterprise: 'EE', community: 'CE' } as const;

/** Odoo edition of the project (CE / EE) with how it was determined in the tooltip. */
export function EditionBadge({ edition, short = false }: { edition: OdooEdition | null | undefined; short?: boolean }) {
  if (!edition) return null;
  return (
    <Tooltip multiline w={360} withArrow label={`${LABEL[edition.kind]}: ${edition.note}${edition.source ? ` (${edition.source})` : ''}`}>
      <Badge variant={short ? 'filled' : 'light'} color={edition.kind === 'enterprise' ? 'violet' : 'gray'} size={short ? 'sm' : 'md'}>
        {short ? SHORT[edition.kind] : LABEL[edition.kind]}
      </Badge>
    </Tooltip>
  );
}

/** One line for the Runtime settings: the edition, where its addons come from and why. */
export function EditionLine({ edition }: { edition: OdooEdition | null | undefined }) {
  if (!edition) return null;
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
        {t('edition.title')}
      </Text>
      <EditionBadge edition={edition} />
      <Text size="sm" c="dimmed">
        {edition.note}
        {edition.source && (
          <>
            {' '}
            — <Code>{edition.source}</Code>
          </>
        )}
        {t('edition.how')}
      </Text>
    </Group>
  );
}
