import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Code, CopyButton, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { errorCode, errorText, isMac, type BmCallError } from '../../lib/bm';
import { t, tx } from '../../i18n';

/** Fork (spec 8.10, D33): the new branch is created on GitHub from the live build commit (or the branch head) → Development → build. */
export function ForkDialog({ open, branch, onClose }: { open: boolean; branch: BranchView; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const preview = useBm('branches.forkName', { projectId: branch.projectId, name }, { enabled: open && !!name });
  const fork = useBmMutation('branches.fork', { success: t('fork.created'), silentError: true });
  useEffect(() => {
    if (open) setName('');
    fork.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const from = branch.liveBuild?.commitSha ? t('fork.fromLive', { sha: branch.liveBuild.commitSha.slice(0, 7) }) : t('fork.fromHead', { branch: branch.name });
  const run = (interactive: boolean) =>
    fork.mutate(
      { branchId: branch.id, name: preview.data!.name, interactive },
      {
        onSuccess: (r) => {
          onClose();
          nav(`/projects/${branch.projectId}/branches/${r.branch.id}`);
        },
      },
    );
  return (
    <Modal opened={open} onClose={onClose} title={t('fork.title', { branch: branch.name })} size={fork.error ? 'lg' : 'md'}>
      <Stack>
        <TextInput
          label={t('fork.name')}
          placeholder="test999"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            fork.reset();
          }}
          data-autofocus
        />
        {preview.data && (
          <Text size="sm">
            {tx('fork.preview', { name: preview.data.name, from }, { b: (x) => <b>{x}</b> })}
          </Text>
        )}
        {preview.data?.error && <Alert color="red">{preview.data.error}</Alert>}
        {fork.error && <ForkError error={fork.error} busy={fork.isPending} onLogin={() => run(true)} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!preview.data?.valid} loading={fork.isPending} onClick={() => run(false)}>
            {t('fork.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface PushDetails {
  problem?: string;
  account?: string | null;
  https?: boolean;
  urlUser?: string | null;
}

function Cmd({ cmd }: { cmd: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Code>{cmd}</Code>
      <CopyButton value={cmd}>
        {({ copied, copy }) => (
          <Button size="compact-xs" variant="subtle" onClick={copy}>
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}

/** What went wrong with the push and what to do next (D57): the app may run on machines of people it was not set up by. */
function ForkError({ error, busy, onLogin }: { error: Error; busy: boolean; onLogin: () => void }) {
  const d = (errorCode(error) === 'GIT_PUSH' ? ((error as BmCallError).details as PushDetails | undefined) : undefined) ?? {};
  const login = d.https && (d.problem === 'auth' || d.problem === 'denied');
  const loginButton = login && (
    <Group>
      <Button size="xs" variant="light" loading={busy} onClick={onLogin}>
        {t('fork.loginRetry')}
      </Button>
    </Group>
  );
  const token = d.urlUser && (
    <List.Item>
      {tx(
        'fork.tokenProject',
        {
          user: d.urlUser,
          cred: isMac ? `github.com (${d.urlUser})` : `git:https://${d.urlUser}@github.com`,
          where: t(isMac ? 'fork.whereMac' : 'fork.whereWin'),
        },
        { code: (x) => <Code>{x}</Code> },
      )}
    </List.Item>
  );
  return (
    <Alert color="red" title={t('fork.notCreated')} data-testid="fork-error">
      <Stack gap="xs">
        <Text size="sm">{errorText(error).replace(/^git push: /, '')}</Text>
        {d.problem === 'auth' && (
          <>
            <Text size="sm">
              {t('fork.authNote')}
            </Text>
            {d.https ? (
              <Text size="sm">
                {t('fork.authHttps')}
              </Text>
            ) : null}
            {loginButton}
          </>
        )}
        {d.problem === 'denied' && (
          <>
            <List size="sm" spacing={4}>
              <List.Item>
                {tx('fork.askAdmin', { who: d.account ? <b>{d.account}</b> : t('fork.yourAccount') })}
              </List.Item>
              {d.https && (
                <List.Item>
                  {t('fork.otherAccount')}
                  <Cmd cmd={d.account ? `git credential-manager github logout ${d.account}` : 'git credential-manager github list'} />
                  {t(d.account ? 'fork.thenLogin' : 'fork.whoSigned')}
                </List.Item>
              )}
              {token}
              {!d.urlUser && !d.account && (
                <List.Item>
                  {t('fork.fineGrained')}
                </List.Item>
              )}
            </List>
            {loginButton}
          </>
        )}
        {d.problem === 'rules' && (
          <Text size="sm">
            {t('fork.rules')}
          </Text>
        )}
        {d.problem === 'network' && <Text size="sm">{t('fork.network')}</Text>}
      </Stack>
    </Alert>
  );
}
