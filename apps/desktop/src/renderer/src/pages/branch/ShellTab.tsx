import { Alert, Button, Card, Code, Group, Stack, Text } from '@mantine/core';
import { IconDatabase, IconTerminal2, IconBrandPython } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm } from '../../lib/query';
import { isMac } from '../../lib/bm';
import { shellOpen } from '../BranchPage';
import { t } from '../../i18n';

/** Shell (spec 8.9): external terminal with docker exec bash, odoo shell, psql. */
export function ShellTab({ branch }: { branch: BranchView }) {
  const live = branch.liveBuild;
  const app = useBm('config.app', {});
  if (!live) return <Alert color="gray">{t('tab.noLive')}</Alert>;
  const running = live.status === 'running';
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {isMac
          ? t('shellTab.mac')
          : t('shellTab.win', { terminal: app.data?.desktop.terminal ?? 'wt' })}
      </Text>
      <Card withBorder>
        <Stack>
          <Group>
            <Button leftSection={<IconTerminal2 size={14} />} disabled={!running} onClick={() => void shellOpen({ buildId: live.id, target: 'bash' })}>
              {t('shellTab.bash')}
            </Button>
            <Code>{t('shellTab.bashCmd')}</Code>
          </Group>
          <Group>
            <Button leftSection={<IconBrandPython size={14} />} disabled={!running} onClick={() => void shellOpen({ buildId: live.id, target: 'odoo-shell' })}>
              odoo shell
            </Button>
            <Code>odoo shell -d {live.dbName}</Code>
          </Group>
          <Group>
            <Button leftSection={<IconDatabase size={14} />} onClick={() => void shellOpen({ buildId: live.id, target: 'psql' })}>
              psql
            </Button>
            <Code>psql {live.dbName}</Code>
          </Group>
        </Stack>
      </Card>
      {!running && <Alert color="gray">{t('shellTab.stopped')}</Alert>}
    </Stack>
  );
}
