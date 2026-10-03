import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { checkForUpdates, installUpdate, ReleaseNotes, useUpdateState } from './UpdateBanner';
import { fmtDate } from '../lib/format';
import { isMac } from '../lib/bm';
import { t, tx } from '../i18n';

const statusText = (s: string): string =>
  ({
    idle: t('updates.idle'),
    checking: t('updates.checking'),
    none: t('updates.none'),
    available: t('updates.available'),
    downloading: t(isMac ? 'updates.downloadingDmg' : 'updates.downloadingExe'),
    ready: t(isMac ? 'updates.readyDmg' : 'updates.readyExe'),
    installing: t('updates.installing'),
    error: t('updates.error'),
  })[s] ?? s;
const bold = { b: (x: ReactNode) => <b>{x}</b> };

/** Settings → Приложение → Обновления: manual check and install. */
export function UpdatesCard() {
  const s = useUpdateState();
  const [checking, setChecking] = useState(false);
  const [notes, setNotes] = useState(false);
  if (!s) return null;
  const canInstall = s.status === 'available' || s.status === 'ready';
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between">
          <Title order={5}>{t('updates.title')}</Title>
          <Badge variant="light" color={s.status === 'error' ? 'red' : canInstall ? 'blue' : 'gray'}>
            {statusText(s.status)}
          </Badge>
        </Group>
        <Text size="sm">
          {tx('updates.installed', { current: s.current }, bold)}
          {s.latest && s.latest !== s.current ? (
            <>
              {tx('updates.latest', { latest: s.latest }, bold)}
              {s.publishedAt ? t('updates.of', { date: fmtDate(s.publishedAt) }) : ''}
            </>
          ) : null}
          {t('updates.lastCheck', { date: fmtDate(s.checkedAt) })}
        </Text>
        {s.error && (
          <Text size="sm" c="red">
            {s.error}
          </Text>
        )}
        {s.mode === 'dev' && (
          <Text size="xs" c="dimmed">
            {t('updates.dev')}
          </Text>
        )}
        {s.mode === 'portable' && (
          <Text size="xs" c="dimmed">
            {t('updates.portable')}
          </Text>
        )}
        <Group>
          <Button
            variant="default"
            loading={checking || s.status === 'checking'}
            onClick={async () => {
              setChecking(true);
              await checkForUpdates();
              setChecking(false);
            }}
            data-testid="check-updates"
          >
            {t('updates.check')}
          </Button>
          {canInstall && (
            <>
              <Button variant="subtle" onClick={() => setNotes(true)}>
                {t('updates.whatsNew', { version: s.latest })}
              </Button>
              <Button onClick={() => void installUpdate()}>{s.mode === 'portable' ? t('upd.download') : t('updates.updateTo', { version: s.latest })}</Button>
            </>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {t('updates.about')} {t(isMac ? 'updates.howMac' : 'updates.howWin')} {t('updates.untouched')}
        </Text>
      </Stack>
      <ReleaseNotes state={s} opened={notes} onClose={() => setNotes(false)} />
    </Card>
  );
}
