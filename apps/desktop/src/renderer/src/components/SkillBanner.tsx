import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Code, Group, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { OutdatedSkill } from '@bm/shared';
import { useBm, useBmMutation } from '../lib/query';
import { t, tx } from '../i18n';

/** «Позже» hides a warning until the app restarts or the skill falls behind again (another version / text). */
const hiddenKeys = new Set<string>();
const keyOf = (s: OutdatedSkill) => `${s.projectId}|${s.currentVersion}|${s.installedVersion}`;
/** «0.13.24 → 0.14.1» when the app changed (the commit only if the versions are otherwise equal), else the settings. */
function why(s: OutdatedSkill): string {
  if (!s.installedVersion) return t('skillBanner.settings');
  if (s.installedVersion === s.currentVersion) return t('skillBanner.settings');
  const short = (v: string) => v.split('+')[0]!;
  const same = short(s.installedVersion) === short(s.currentVersion);
  return same ? `${s.installedVersion} → ${s.currentVersion}` : `${short(s.installedVersion)} → ${short(s.currentVersion)}`;
}

/**
 * Warning under the header on every page (D75): an assistant skill is behind the app. The app does not rewrite it by
 * itself; «Обновить» writes it in one click, a skill edited by hand is overwritten only from the project settings.
 */
export function SkillBanner() {
  const nav = useNavigate();
  const status = useBm('system.status', {}, { refetchInterval: 15000 });
  const install = useBmMutation('agents.installSkill');
  const [, rerender] = useState(0);
  const items = (status.data?.outdatedSkills ?? []).filter((s) => !hiddenKeys.has(keyOf(s)));
  if (!items.length) return null;
  const code = { code: (x: ReactNode) => <Code>{x}</Code> };
  return (
    <>
      {items.map((s) => (
        <Alert
          key={s.projectId}
          color="orange"
          radius={0}
          py={6}
          withCloseButton
          closeButtonLabel={t('skillBanner.later')}
          onClose={() => {
            hiddenKeys.add(keyOf(s));
            rerender((n) => n + 1);
          }}
          data-testid="skill-banner"
        >
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              {tx(
                s.modified ? 'skillBanner.modified' : 'skillBanner.outdated',
                { name: s.projectName, why: why(s), path: s.path },
                code,
              )}
            </Text>
            {s.modified ? (
              <Button size="compact-sm" variant="light" color="orange" style={{ flexShrink: 0 }} onClick={() => nav(`/projects/${s.projectId}/settings/agents`)}>
                {t('skillBanner.open')}
              </Button>
            ) : (
              <Button
                size="compact-sm"
                color="orange"
                style={{ flexShrink: 0 }}
                loading={install.isPending && install.variables?.projectId === s.projectId}
                onClick={async () => {
                  const r = await install.mutateAsync({ projectId: s.projectId, dir: s.dir, overwrite: false });
                  notifications.show({
                    color: 'green',
                    message: t('skillBanner.updated', { name: s.projectName }) + (r.inGit ? ` ${t('skill.inGit')}` : ''),
                    autoClose: r.inGit ? 12000 : 4000,
                  });
                }}
              >
                {t('skill.update')}
              </Button>
            )}
          </Group>
        </Alert>
      ))}
    </>
  );
}
