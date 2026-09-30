import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Center, Group, Modal, Select, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { BranchesList, BranchView, Stage } from '@bm/shared';
import { useBm, useBmMutation } from '../lib/query';
import { call, errorText } from '../lib/bm';
import { Sidebar } from '../components/Sidebar';
import { useRebuild } from '../components/useRebuild';
import { BranchPage } from './BranchPage';
import { MergeDialog } from '../components/dialogs/MergeDialog';

const STAGE_LABEL: Record<Stage, string> = { production: 'Production', development: 'Development' };

const lastBranchKey = (projectId: string) => `bm.lastBranch.${projectId}`;

function storeLastBranch(projectId: string, value: string): void {
  try {
    localStorage.setItem(lastBranchKey(projectId), value);
  } catch {
    /* storage unavailable */
  }
}

/** `<branchId>` or `<branchId>/<tab>` of the branch last open in the project. */
function readLastBranch(projectId: string): string | null {
  try {
    return localStorage.getItem(lastBranchKey(projectId));
  } catch {
    return null;
  }
}

/** Branches page (spec 6): sidebar with stages + selected branch. */
export function BranchesPage() {
  const { pid, bid, tab } = useParams();
  const nav = useNavigate();
  const projectId = pid!;
  const list = useBm('branches.list', { projectId }, { refetchInterval: 15000 });
  const projects = useBm('projects.list', {});
  const jobs = useBm('jobs.list', { projectId, active: true }, { refetchInterval: 4000 });
  const fetchM = useBmMutation('git.fetch', { success: 'Fetch запущен' });
  const login = useBmMutation('projects.login');
  const [move, setMove] = useState<{ b: BranchView; stage: Stage } | null>(null);
  const [addStage, setAddStage] = useState<Stage | null>(null);
  const [merge, setMerge] = useState<{ source: BranchView; target: BranchView | null } | null>(null);
  const summary = projects.data?.find((p) => p.id === projectId);
  const selectedId = bid ? Number(bid) : null;
  const fetching = !!jobs.data?.some((j) => j.type === 'fetch');

  const all = list.data ? [...list.data.production, ...list.data.development] : [];

  // The open branch (and its tab) is remembered per project: coming back from Settings, Builds or another project
  // opens it again; the first time — the Production branch.
  useEffect(() => {
    if (bid) storeLastBranch(projectId, `${bid}${tab ? `/${tab}` : ''}`);
  }, [projectId, bid, tab]);
  useEffect(() => {
    if (bid || !list.data) return;
    const last = readLastBranch(projectId);
    const lastId = last ? Number(last.split('/')[0]) : null;
    const target = lastId && all.some((b) => b.id === lastId) ? last : (list.data.production[0]?.id ?? null);
    if (target) nav(`/projects/${projectId}/branches/${target}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, bid, list.data]);

  const rebuild = useRebuild();
  const onContext = async (b: BranchView, action: string) => {
    try {
      if (action === 'connect' && b.url) await window.bm.desktop.openExternal(b.url);
      else if (action === 'rebuild') await rebuild(b);
      else if ((action === 'start' || action === 'stop') && b.liveBuild) {
        await call('builds.action', { buildId: b.liveBuild.id, action });
      } else if (action === 'editor') await call('shell.open', { branchId: b.id, target: 'editor' });
      else if (action === 'logs') nav(`/projects/${projectId}/branches/${b.id}/logs`);
      else if (action === 'hide' || action === 'show') await call('branches.setHidden', { branchId: b.id, hidden: action === 'hide' });
      else if (action === 'production' || action === 'development') setMove({ b, stage: action });
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
        {summary?.legacy && (
          <Alert color="red" radius={0} py={6}>
            Проект создан по старой схеме: приложение работало внутри вашего репозитория, сборки и fetch для него отключены. Удалите проект (Settings →
            «Удалить проект…») и добавьте заново — код сборок будет браться с GitHub.
          </Alert>
        )}
        {summary?.lastFetchError && (
          <Alert color="orange" radius={0} py={6}>
            <Group justify="space-between" wrap="nowrap">
              <span>Последний fetch завершился ошибкой: {summary.lastFetchError}</span>
              {/нет доступа к репозиторию/.test(summary.lastFetchError) && (
                <Button
                  size="compact-sm"
                  variant="white"
                  loading={login.isPending}
                  onClick={() =>
                    login.mutate(
                      { projectId },
                      { onSuccess: (p) => notifications.show({ color: p.ok ? 'green' : 'red', message: p.ok ? 'Доступ есть, fetch запущен' : (p.message ?? 'Нет доступа') }) },
                    )
                  }
                >
                  Войти
                </Button>
              )}
            </Group>
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
      <AddDialog stage={addStage} projectId={projectId} options={list.data?.unassigned.map((u) => u.name) ?? []} autoAdd={list.data?.autoAdd ?? 'none'} onClose={() => setAddStage(null)} />
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
            {STAGE_LABEL[move.b.stage]} → <b>{STAGE_LABEL[move.stage]}</b>.
          </Text>
          {move.stage === 'production' && (
            <Alert color="orange" title="Смена продакшн-ветки">
              Текущая продакшн-ветка {production ? <b>{production}</b> : ''} уйдёт в Development. Зеркало прода для новой ветки нужно пересоздать
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

/** Where new remote branches go by `autoAddBranches`: under «+» they only show up when fetch did not add them. */
const AUTO_ADD_TEXT: Record<BranchesList['autoAdd'], string> = {
  all: 'Новые ветки с GitHub приложение добавляет само при fetch. Здесь бывают только ветки, которые вы удалили из приложения.',
  rules: 'Новые ветки с GitHub, подходящие под правила стадий, приложение добавляет само при fetch. Здесь — остальные и те, что вы удалили из приложения.',
  none: 'Ветку, только что созданную на GitHub, здесь видно после fetch.',
};

function AddDialog({
  stage,
  projectId,
  options,
  autoAdd,
  onClose,
}: {
  stage: Stage | null;
  projectId: string;
  options: string[];
  autoAdd: BranchesList['autoAdd'];
  onClose: () => void;
}) {
  const nav = useNavigate();
  const [name, setName] = useState<string | null>(null);
  const add = useBmMutation('branches.add');
  useEffect(() => setName(null), [stage]);
  const preview = useBm('branches.addPreview', { projectId, name: name ?? '', stage: stage ?? 'development' }, { enabled: !!stage && !!name });
  if (!stage) return null;
  const pv = name ? preview.data : undefined;
  return (
    <Modal opened onClose={onClose} title={`Добавить ветку в ${STAGE_LABEL[stage]}`}>
      <Stack>
        <Text size="sm">Подключает к приложению ветку, которая уже есть в репозитории на GitHub. Новую ветку здесь создать нельзя.</Text>
        {options.length ? (
          <Select
            label="Ветка из репозитория, ещё не добавленная в приложение"
            searchable
            data={options}
            value={name}
            onChange={setName}
            nothingFoundMessage="Такой ветки нет — выполните fetch"
            data-autofocus
          />
        ) : (
          <Alert color="gray">Все ветки репозитория уже добавлены в приложение.</Alert>
        )}
        <Text size="sm" c="dimmed">
          {AUTO_ADD_TEXT[autoAdd]}
        </Text>
        {pv && (
          <Text size="sm">
            Ветка появится в {STAGE_LABEL[stage]}; на GitHub ничего не меняется.{' '}
            {pv.build ? 'Сразу начнётся сборка' : 'Сборка сама не начнётся (выключено «Собирать при добавлении») — запустите её кнопкой Rebuild на странице ветки'}
            : код из <b>{name}</b>, база —{' '}
            {pv.copyOf ? (
              <>
                копия базы <b>{pv.copyOf}</b>
              </>
            ) : (
              `чистая${pv.withDemo ? ' с демо-данными' : ''}`
            )}
            .
          </Text>
        )}
        <Text size="sm" c="dimmed">
          Новую ветку от существующей создаёт Fork на странице ветки-источника.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {options.length ? 'Отмена' : 'Закрыть'}
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
