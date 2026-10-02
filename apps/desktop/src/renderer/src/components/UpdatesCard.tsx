import { useState } from 'react';
import { Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { checkForUpdates, installUpdate, ReleaseNotes, useUpdateState } from './UpdateBanner';
import { fmtDate } from '../lib/format';
import { isMac } from '../lib/bm';

const STATUS: Record<string, string> = {
  idle: 'не проверялось',
  checking: 'проверка…',
  none: 'установлена последняя версия',
  available: 'доступно обновление',
  downloading: isMac ? 'загрузка образа…' : 'загрузка установщика…',
  ready: isMac ? 'образ скачан' : 'установщик скачан',
  installing: 'установка…',
  error: 'ошибка проверки',
};

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
          <Title order={5}>Обновления</Title>
          <Badge variant="light" color={s.status === 'error' ? 'red' : canInstall ? 'blue' : 'gray'}>
            {STATUS[s.status] ?? s.status}
          </Badge>
        </Group>
        <Text size="sm">
          Установлена версия <b>{s.current}</b>
          {s.latest && s.latest !== s.current ? (
            <>
              , последняя — <b>{s.latest}</b>
              {s.publishedAt ? ` от ${fmtDate(s.publishedAt)}` : ''}
            </>
          ) : null}
          . Последняя проверка: {fmtDate(s.checkedAt)}.
        </Text>
        {s.error && (
          <Text size="sm" c="red">
            {s.error}
          </Text>
        )}
        {s.mode === 'dev' && (
          <Text size="xs" c="dimmed">
            Приложение запущено из исходников: проверка работает, установка обновлений — только в установленной версии.
          </Text>
        )}
        {s.mode === 'portable' && (
          <Text size="xs" c="dimmed">
            Portable-версия: новая версия скачивается со страницы релиза.
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
            Проверить обновления
          </Button>
          {canInstall && (
            <>
              <Button variant="subtle" onClick={() => setNotes(true)}>
                Что нового в {s.latest}
              </Button>
              <Button onClick={() => void installUpdate()}>{s.mode === 'portable' ? 'Скачать' : `Обновить до ${s.latest}`}</Button>
            </>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          Приложение сверяется с релизами GitHub-репозитория из настройки updates.repository.{' '}
          {isMac
            ? 'При обновлении образ .dmg скачивается и проверяется, затем приложение полностью закрывается и открывает его: перетащите приложение в «Программы» с заменой.'
            : 'При обновлении установщик скачивается и проверяется, затем приложение полностью закрывается и запускает его.'}{' '}
          Контейнеры сборок, базы и настройки не затрагиваются.
        </Text>
      </Stack>
      <ReleaseNotes state={s} opened={notes} onClose={() => setNotes(false)} />
    </Card>
  );
}
