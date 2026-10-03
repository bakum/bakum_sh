import { Fragment, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData } from '@tanstack/react-query';
import { useDebouncedValue } from '@mantine/hooks';
import { Badge, Box, Button, Checkbox, Code, Container, Group, Pagination, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';
import type { AuditEntryView, MethodParams } from '@bm/shared';
import { useBm } from '../lib/query';
import { dayStartIso, fmtDate } from '../lib/format';
import { t } from '../i18n';
import { Diff } from '../components/Diff';

const PAGE = 50;
const FILTERS = ['action', 'q', 'result', 'from', 'to', 'app'] as const;
type Filter = (typeof FILTERS)[number];

/** Options of the action filter: a group per prefix (`build.` → «build.*»), then the exact actions. */
function actionOptions(actions: string[]) {
  const groups = [...new Set(actions.filter((a) => a.includes('.')).map((a) => `${a.split('.')[0]}.`))].filter((g) => actions.filter((a) => a.startsWith(g)).length > 1);
  return [
    ...(groups.length ? [{ group: t('audit.groups'), items: groups.map((g) => ({ value: g, label: `${g}*` })) }] : []),
    { group: t('audit.actions'), items: actions.map((a) => ({ value: a, label: a })) },
  ];
}

function Details({ a }: { a: AuditEntryView }) {
  const hasParams = Object.keys(a.params).length > 0;
  return (
    <Stack gap="xs">
      {hasParams && (
        <div>
          <Text size="xs" fw={600} mb={4}>
            {t('audit.params')}
          </Text>
          <Code block>{JSON.stringify(a.params, null, 2)}</Code>
        </div>
      )}
      {a.diff !== null && (
        <div>
          <Text size="xs" fw={600} mb={4}>
            {t('audit.settingsChanges')}
          </Text>
          <Diff text={a.diff} />
        </div>
      )}
      {!hasParams && a.diff === null && (
        <Text size="xs" c="dimmed">
          {t('audit.noDetails')}
        </Text>
      )}
    </Stack>
  );
}

/** Audit Logs (spec 8.11): actions of the app and the user with filters, parameters and diffs of settings changes. */
export function AuditPage() {
  const { pid } = useParams();
  const [sp, setSp] = useSearchParams();
  const f = (k: Filter) => sp.get(k) || null;
  const page = Number(sp.get('page') ?? 1) || 1;
  const set = (k: Filter | 'page', v: string | null) =>
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        if (k !== 'page') n.delete('page');
        return n;
      },
      { replace: true },
    );
  const [search, setSearch] = useState(f('q') ?? '');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const params: MethodParams<'audit.list'> = {
    projectId: pid,
    withApp: f('app') === '1',
    ...(f('action') ? { action: f('action')! } : {}),
    ...(q ? { q } : {}),
    ...(f('result') ? { result: f('result') as 'ok' | 'error' } : {}),
    ...(f('from') ? { since: dayStartIso(f('from')!) } : {}),
    ...(f('to') ? { until: dayStartIso(f('to')!, 1) } : {}),
    offset: (page - 1) * PAGE,
    limit: PAGE,
  };
  const r = useBm('audit.list', params, { refetchInterval: 10000, placeholderData: keepPreviousData });
  const items = r.data?.items ?? [];
  const total = r.data?.total ?? 0;
  const anyFilter = FILTERS.some((k) => f(k)) || !!q;
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Container size="xl" py="md">
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Audit Logs</Title>
          <Text size="sm" c="dimmed">
            {t(anyFilter ? 'list.filtered' : 'list.total', { n: total })}
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          {t('audit.about')}
        </Text>
        <Group gap="xs" align="flex-end">
          <Select
            size="xs"
            w={240}
            placeholder={t('audit.action')}
            searchable
            clearable
            data={actionOptions(r.data?.actions ?? [])}
            value={f('action')}
            onChange={(v) => set('action', v)}
          />
          <TextInput
            size="xs"
            w={240}
            placeholder={t('audit.search')}
            leftSection={<IconSearch size={12} />}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              set('q', e.currentTarget.value.trim() || null);
            }}
          />
          <Select
            size="xs"
            w={130}
            placeholder={t('audit.result')}
            clearable
            data={[
              { value: 'ok', label: 'ok' },
              { value: 'error', label: t('audit.error') },
            ]}
            value={f('result')}
            onChange={(v) => set('result', v)}
          />
          <TextInput size="xs" type="date" label={t('list.from')} value={f('from') ?? ''} onChange={(e) => set('from', e.currentTarget.value || null)} />
          <TextInput size="xs" type="date" label={t('list.to')} value={f('to') ?? ''} onChange={(e) => set('to', e.currentTarget.value || null)} />
          {pid && (
            <Checkbox
              size="xs"
              mb={6}
              label={t('audit.appToo')}
              checked={f('app') === '1'}
              onChange={(e) => set('app', e.currentTarget.checked ? '1' : null)}
            />
          )}
          {anyFilter && (
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setSearch('');
                setSp(new URLSearchParams(), { replace: true });
              }}
            >
              {t('list.reset')}
            </Button>
          )}
        </Group>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={28} />
              <Table.Th w={160}>{t('audit.when')}</Table.Th>
              <Table.Th w={220}>{t('audit.action')}</Table.Th>
              <Table.Th>{t('audit.object')}</Table.Th>
              <Table.Th w={90}>{t('audit.result')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((a) => {
              const expanded = open.has(a.id);
              return (
                <Fragment key={a.id}>
                  <Table.Tr style={{ cursor: 'pointer' }} onClick={() => toggle(a.id)} data-testid={`audit-row-${a.id}`}>
                    <Table.Td>{expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</Table.Td>
                    <Table.Td>{fmtDate(a.at)}</Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm">{a.action}</Text>
                        {a.diff !== null && (
                          <Badge size="xs" variant="light" color="violet">
                            diff
                          </Badge>
                        )}
                        {!a.projectId && pid && (
                          <Badge size="xs" variant="light" color="gray">
                            {t('audit.app')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>{a.target}</Table.Td>
                    <Table.Td>
                      <Badge color={a.result === 'ok' ? 'teal' : 'red'} variant="light">
                        {a.result}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                  {expanded && (
                    <Table.Tr data-testid={`audit-details-${a.id}`}>
                      <Table.Td />
                      <Table.Td colSpan={4}>
                        <Details a={a} />
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              );
            })}
          </Table.Tbody>
        </Table>
        {r.data && !items.length && (
          <Text size="sm" c="dimmed">
            {t(anyFilter ? 'audit.noneFiltered' : 'audit.none')}
          </Text>
        )}
        {total > PAGE && <Pagination total={Math.ceil(total / PAGE)} value={page} onChange={(p) => set('page', String(p))} size="sm" />}
      </Stack>
    </Container>
  );
}
