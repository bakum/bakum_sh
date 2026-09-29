import { useState } from 'react';
import { Alert, Badge, Button, Card, Code, Group, SimpleGrid, Stack, TagsInput, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBug, IconCopy, IconDatabase, IconKey } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { call, errorText } from '../../lib/bm';
import { shellOpen } from '../BranchPage';

/** Tools (spec 8.9): psql, connection string, admin password, manual modules, Debug (launch.json). */
export function ToolsTab({ branch }: { branch: BranchView }) {
  const live = branch.liveBuild;
  const changed = useBm('builds.changedModules', { branchId: branch.id }, { enabled: !!live });
  const launch = useBm('builds.launchJson', { buildId: live?.id ?? 0 }, { enabled: !!live });
  const resetPw = useBmMutation('builds.resetAdminPassword', { success: 'Пароль admin сброшен' });
  const mods = useBmMutation('builds.modulesAction', { success: 'Задача поставлена в очередь' });
  const [install, setInstall] = useState<string[]>([]);
  const [update, setUpdate] = useState<string[]>([]);
  const tests = useBmMutation('builds.testsAction', { success: 'Тесты поставлены в очередь' });
  const [testMods, setTestMods] = useState<string[]>([]);
  if (!live) return <Alert color="gray">У ветки нет живой сборки.</Alert>;

  return (
    <SimpleGrid cols={2}>
      <Card withBorder>
        <Stack>
          <Title order={5}>База данных</Title>
          <Text size="sm">
            БД <Code>{live.dbName}</Code>
          </Text>
          <Group>
            <Button leftSection={<IconDatabase size={14} />} onClick={() => void shellOpen({ buildId: live.id, target: 'psql' })}>
              psql в терминале
            </Button>
            <Button
              variant="default"
              leftSection={<IconCopy size={14} />}
              onClick={async () => {
                try {
                  const r = await call('builds.connectionString', { buildId: live.id });
                  await window.bm.desktop.copy(r.value);
                  notifications.show({ message: 'Строка подключения скопирована (с паролем, на экран не выводится)' });
                } catch (e) {
                  notifications.show({ color: 'red', message: errorText(e) });
                }
              }}
            >
              Скопировать строку подключения
            </Button>
          </Group>
          <Group>
            <Button
              variant="default"
              leftSection={<IconKey size={14} />}
              loading={resetPw.isPending}
              onClick={async () => {
                const r = await window.bm.desktop.confirm({ message: 'Сбросить пароль admin на connect.adminPassword?', buttons: ['Сбросить', 'Отмена'] });
                if (r === 0) resetPw.mutate({ buildId: live.id });
              }}
            >
              Сбросить пароль admin
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={5}>Debug</Title>
            <Badge variant="light">debugPort {live.debugPort ?? '—'}</Badge>
          </Group>
          <Text size="sm" c="dimmed">
            debugpy слушает в контейнере; порт опубликован только на 127.0.0.1. Attach из VS Code по конфигурации ниже, pathMappings указывают на
            папку с кодом ветки (worktree или вашу папку).
          </Text>
          {launch.data && (
            <Code block style={{ maxHeight: 180, overflow: 'auto' }}>
              {launch.data.json}
            </Code>
          )}
          <Group>
            <Button
              leftSection={<IconCopy size={14} />}
              variant="default"
              onClick={() => launch.data && void window.bm.desktop.copy(launch.data.json).then(() => notifications.show({ message: 'launch.json скопирован' }))}
            >
              Скопировать launch.json
            </Button>
            <Button
              leftSection={<IconBug size={14} />}
              onClick={async () => {
                try {
                  const r = await call('builds.writeLaunchJson', { buildId: live.id });
                  notifications.show({
                    color: r.gitignoreWarning ? 'orange' : 'green',
                    message: `Добавлено в ${r.path}${r.gitignoreWarning ? '. Внимание: .vscode/ не в .gitignore — не закоммитьте файл случайно.' : ''}`,
                    autoClose: 10000,
                  });
                } catch (e) {
                  notifications.show({ color: 'red', message: errorText(e) });
                }
              }}
            >
              Добавить в .vscode/launch.json папки кода
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={5}>Изменённые модули</Title>
          {changed.data ? (
            <>
              <Text size="xs" c="dimmed">
                {changed.data.from ? `${changed.data.from.slice(0, 7)}..${changed.data.to?.slice(0, 7)}` : 'нет базы для сравнения'} · файлов: {changed.data.files}
              </Text>
              <Group gap={4}>
                {changed.data.modules.map((m) => (
                  <Badge key={m.name} color={m.action === 'update' ? 'teal' : m.action === 'install' ? 'blue' : m.action === 'removed' ? 'red' : 'gray'} variant="light">
                    {m.name}: {m.action === 'update' ? '-u' : m.action === 'install' ? '-i' : m.action === 'removed' ? 'удалён' : 'не установлен'}
                  </Badge>
                ))}
                {!changed.data.modules.length && <Text size="sm">Нет изменённых модулей</Text>}
              </Group>
            </>
          ) : (
            <Text size="sm" c="dimmed">…</Text>
          )}
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={5}>Модули вручную</Title>
          <TagsInput label="Установить (-i)" value={install} onChange={setInstall} placeholder="имя_модуля" />
          <TagsInput label="Обновить (-u)" value={update} onChange={setUpdate} placeholder="имя_модуля" />
          <Group justify="flex-end">
            <Button
              disabled={!install.length && !update.length}
              loading={mods.isPending}
              onClick={() => mods.mutate({ buildId: live.id, install, update }, { onSuccess: () => { setInstall([]); setUpdate([]); } })}
            >
              Выполнить (контейнер будет перезапущен)
            </Button>
          </Group>
          <TagsInput
            label="Тесты модулей"
            description="на временной копии базы сборки (как тесты при сборке); итог — в бейдже Test и tests.log"
            value={testMods}
            onChange={setTestMods}
            placeholder="имя_модуля"
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={!testMods.length}
              loading={tests.isPending}
              onClick={() => tests.mutate({ buildId: live.id, modules: testMods })}
            >
              Запустить тесты
            </Button>
          </Group>
        </Stack>
      </Card>
    </SimpleGrid>
  );
}
