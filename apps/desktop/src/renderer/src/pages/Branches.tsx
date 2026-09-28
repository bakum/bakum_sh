import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Center, Group, Modal, Select, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { BranchView, Stage } from '@bm/shared';
import { useBm, useBmMutation } from '../lib/query';
import { call, errorCode, errorText } from '../lib/bm';
import { Sidebar } from '../components/Sidebar';
import { BranchPage } from './BranchPage';
import { MergeDialog } from '../components/dialogs/MergeDialog';

const STAGE_LABEL: Record<Stage, string> = { production: 'Production', staging: 'Staging', development: 'Development' };

/** Branches page (spec 6): sidebar with stages + selected branch. */
export function BranchesPage() {
  const { pid, bid } = useParams();
  const nav = useNavigate();
  const projectId = pid!;
  const list = useBm('branches.list', { projectId }, { refetchInterval: 15000 });
  const projects = useBm('projects.list', {});
  const jobs = useBm('jobs.list', { projectId, active: true }, { refetchInterval: 4000 });
  const fetchM = useBmMutation('git.fetch', { success: 'Fetch запущен' });
  const [move, setMove] = useState<{ b: BranchView; stage: Stage } | null>(null);
  const [addStage, setAddStage] = useState<Stage | null>(null);
  const [merge, setMerge] = useState<{ source: BranchView; target: BranchView | null } | null>(null);
  const summary = projects.data?.find((p) => p.id === projectId);
  const selectedId = bid ? Number(bid) : null;
  const fetching = !!jobs.data?.some((j) => j.type === 'fetch');

  const all = list.data ? [...list.data.production, ...list.data.staging, ...list.data.development] : [];

  const onContext = async (b: BranchView, action: string) => {
    try {
      if (action === 'connect' && b.url) await window.bm.desktop.openExternal(b.url);
      else if (action === 'rebuild') {
        await call('builds.rebuild', { branchId: b.id });
        notifications.show({ message: `Rebuild ${b.name} поставлен в очередь` });
      } else if ((action === 'start' || action === 'stop') && b.liveBuild) {
        await call('builds.action', { buildId: b.liveBuild.id, action });
      } else if (action === 'editor') await call('shell.open', { branchId: b.id, target: 'editor' });
      else if (action === 'logs') nav(`/projects/${projectId}/branches/${b.id}/logs`);
      else if (action === 'production' || action === 'staging' || action === 'development') setMove({ b, stage: action });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e), autoClose: 12000 });
    }
  };

  return (
    <Box style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Sidebar
        data={list.data}
        selectedId={selectedId}
        projectId={projectId}
        lastFetchAt={summary?.lastFetchAt ?? null}
        fetching={fetching}
        actions={{
          onMove: (b, stage) => setMove({ b, stage }),
          onAdd: async (name, stage) => {
            try {
              const v = await call('branches.add', { projectId, name, stage });
              nav(`/projects/${projectId}/branches/${v.id}`);
            } catch (e) {
              notifications.show({ color: 'red', message: errorText(e) });
            }
          },
          onAddDialog: (stage) => setAddStage(stage),
          onMerge: (source, target) => setMerge({ source, target }),
          onFetch: () => fetchM.mutate({ projectId }),
          onContext: (b, a) => void onContext(b, a),
        }}
      />
      <Box style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {summary?.lastFetchError && (
          <Alert color="orange" radius={0} py={6}>
            Последний fetch завершился ошибкой: {summary.lastFetchError}
          </Alert>
        )}
        {selectedId && all.some((b) => b.id === selectedId) ? (
          <BranchPage branchId={selectedId} projectId={projectId} onMerge={(source) => setMerge({ source, target: null })} />
        ) : (
          <Center h="80%">
            <Stack align="center" gap={4}>
              <Title order={4} c="dimmed">
                Выберите ветку
              </Title>
              <Text c="dimmed" size="sm">
                Перетащите ветку в другую стадию, чтобы сменить её; на другую ветку — чтобы открыть Merge.
              </Text>
            </Stack>
          </Center>
        )}
      </Box>

      <MoveDialog move={move} onClose={() => setMove(null)} production={list.data?.production[0]?.name ?? null} />
      <AddDialog stage={addStage} projectId={projectId} options={list.data?.unassigned.map((u) => u.name) ?? []} onClose={() => setAddStage(null)} />
      <MergeDialog value={merge} branches={all} onClose={() => setMerge(null)} />
    </Box>
  );
}

function MoveDialog({ move, onClose, production }: { move: { b: BranchView; stage: Stage } | null; onClose: () => void; production: string | null }) {
  const setStage = useBmMutation('branches.setStage');
  const rebuild = useBmMutation('builds.rebuild', { success: 'Rebuild поставлен в очередь' });
  const [done, setDone] = useState(false);
  if (!move) return null;
  const close = () => {
    setDone(false);
    onClose();
  };
  return (
    <Modal opened onClose={close} title={`Сменить стадию: ${move.b.name}`} size="lg">
      {!done ? (
        <Stack>
          <Text>
            {STAGE_LABEL[move.b.stage]} → <b>{STAGE_LABEL[move.stage]}</b>. Стадия будет зафиксирована вручную: правила её больше не
            меняют («Сбросить к правилу» — в Settings ветки).
          </Text>
          {move.stage === 'production' && (
            <Alert color="orange" title="Смена продакшн-ветки">
              Текущая продакшн-ветка {production ? <b>{production}</b> : ''} уйдёт в Staging. Зеркало прода для новой ветки нужно пересоздать
              импортом бэкапа (Backups → Импортировать).
            </Alert>
          )}
          <Text size="sm" c="dimmed">
            Сборка сама не пересоздаётся: у ветки появится отметка «настройки стадии изменились — Rebuild».
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Отмена
            </Button>
            <Button
              loading={setStage.isPending}
              onClick={() => setStage.mutate({ branchId: move.b.id, stage: move.stage }, { onSuccess: () => setDone(true) })}
            >
              Сменить стадию
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text>Стадия изменена. Пересобрать ветку по правилам новой стадии сейчас?</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Позже
            </Button>
            <Button
              loading={rebuild.isPending}
              onClick={() =>
                rebuild.mutate(
                  { branchId: move.b.id, trigger: 'stage_change' },
                  {
                    onSuccess: close,
                    onError: (e) => {
                      if (errorCode(e) === 'BRANCH_IN_MAIN_CHECKOUT') close();
                    },
                  },
                )
              }
            >
              Rebuild
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function AddDialog({ stage, projectId, options, onClose }: { stage: Stage | null; projectId: string; options: string[]; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState<string | null>(null);
  const add = useBmMutation('branches.add');
  if (!stage) return null;
  return (
    <Modal opened onClose={onClose} title={`Добавить ветку в ${STAGE_LABEL[stage]}`}>
      <Stack>
        <Select label="Ветка (origin/* и локальные)" searchable data={options} value={name} onChange={setName} nothingFoundMessage="Нет ветки — выполните fetch" />
        <Text size="sm" c="dimmed">
          Новую ветку от существующей создаёт Fork на странице ветки-источника.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!name}
            loading={add.isPending}
            onClick={() =>
              add.mutate(
                { projectId, name: name!, stage },
                {
                  onSuccess: (v) => {
                    onClose();
                    nav(`/projects/${projectId}/branches/${v.id}`);
                  },
                },
              )
            }
          >
            Добавить
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
