import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Group, Modal, Progress, ScrollArea, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { UpdateState } from '@bm/shared';
import { isMac } from '../lib/bm';
import { t, tx } from '../i18n';

/** Update state from main, kept in sync by push events (docs/decisions.md D29). */
export function useUpdateState(): UpdateState | null {
  const [s, setS] = useState<UpdateState | null>(null);
  useEffect(() => {
    void window.bm.desktop.update.get().then(setS);
    return window.bm.desktop.update.onState(setS);
  }, []);
  return s;
}

export async function checkForUpdates(): Promise<void> {
  const s = await window.bm.desktop.update.check();
  if (!s) return;
  if (s.status === 'none') notifications.show({ color: 'teal', message: t('upd.upToDate', { current: s.current }) });
  else if (s.status === 'error') notifications.show({ color: 'red', message: s.error ?? t('upd.checkFailed'), autoClose: 10000 });
}

export async function installUpdate(): Promise<void> {
  const r = await window.bm.desktop.update.install();
  if (!r.ok && r.message && r.message !== t('upd.cancelled')) notifications.show({ color: 'red', title: t('upd.title'), message: r.message, autoClose: 12000 });
  else if (r.ok && r.message) notifications.show({ message: r.message });
}

export function ReleaseNotes({ state, opened, onClose }: { state: UpdateState; opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title={t('upd.whatsNewIn', { version: state.latest })} size="lg">
      <Stack>
        <ScrollArea.Autosize mah={420}>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {state.notes?.trim() || t('upd.emptyNotes')}
          </Text>
        </ScrollArea.Autosize>
        {state.url && (
          <Anchor size="sm" onClick={() => void window.bm.desktop.openExternal(state.url!)}>
            {t('upd.releasePage')}
          </Anchor>
        )}
      </Stack>
    </Modal>
  );
}

/** Banner under the header when a newer version is available. */
export function UpdateBanner() {
  const s = useUpdateState();
  const [hidden, setHidden] = useState<string | null>(null);
  const [notes, setNotes] = useState(false);
  if (!s || !s.latest) return null;
  const busy = s.status === 'downloading' || s.status === 'installing';
  const show = (s.status === 'available' && !s.skipped) || s.status === 'ready' || busy;
  if (!show || hidden === s.latest) return null;
  return (
    <Alert color="blue" radius={0} py={6} withCloseButton={!busy} onClose={() => setHidden(s.latest)} data-testid="update-banner">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">
          {tx('upd.banner', { version: s.latest, current: s.current }, { b: (x) => <b>{x}</b> })}{' '}
          {s.status === 'downloading' && t(isMac ? 'upd.downloadingDmg' : 'upd.downloadingExe', { pct: Math.round((s.progress ?? 0) * 100) })}
          {s.status === 'installing' && t(isMac ? 'upd.installingMac' : 'upd.installingWin')}
        </Text>
        <Group gap={6} wrap="nowrap">
          {s.status === 'downloading' && <Progress value={(s.progress ?? 0) * 100} w={160} />}
          <Button size="xs" variant="subtle" onClick={() => setNotes(true)}>
            {t('upd.whatsNew')}
          </Button>
          {!busy && (
            <Button size="xs" variant="subtle" color="gray" onClick={() => void window.bm.desktop.update.skip()}>
              {t('upd.skip')}
            </Button>
          )}
          <Button size="xs" loading={busy} onClick={() => void installUpdate()}>
            {s.mode === 'portable' ? t('upd.download') : t('upd.update')}
          </Button>
        </Group>
      </Group>
      <ReleaseNotes state={s} opened={notes} onClose={() => setNotes(false)} />
    </Alert>
  );
}
