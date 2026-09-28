import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Badge,
  Box,
  Collapse,
  Group,
  Loader,
  Menu,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { IconChevronDown, IconChevronRight, IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react';
import type { BranchesList, BranchView, Stage, UnassignedBranch } from '@bm/shared';
import { StatusDot } from './StatusDot';
import { fmtAgo } from '../lib/format';
import classes from './Sidebar.module.css';

const STAGES: { key: Stage; title: string }[] = [
  { key: 'production', title: 'PRODUCTION' },
  { key: 'staging', title: 'STAGING' },
  { key: 'development', title: 'DEVELOPMENT' },
];

export interface SidebarActions {
  onMove: (b: BranchView, stage: Stage) => void;
  onAdd: (name: string, stage: Stage) => void;
  onAddDialog: (stage: Stage) => void;
  onMerge: (source: BranchView, target: BranchView) => void;
  onFetch: () => void;
  onContext: (b: BranchView, action: 'connect' | 'rebuild' | 'start' | 'stop' | 'editor' | 'logs' | Stage) => void;
}

/** Branches sidebar (spec 6): stages with drag & drop, filter, «не добавлены», context menu. */
export function Sidebar(props: {
  data: BranchesList | undefined;
  selectedId: number | null;
  projectId: string;
  lastFetchAt: string | null;
  fetching: boolean;
  actions: SidebarActions;
}) {
  const nav = useNavigate();
  const [filter, setFilter] = useState('');
  const [showUnassigned, setShowUnassigned] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);

  const all = useMemo(() => (props.data ? [...props.data.production, ...props.data.staging, ...props.data.development] : []), [props.data]);

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over) return;
    if (id.startsWith('u:')) {
      const name = id.slice(2);
      if (over.startsWith('stage:')) props.actions.onAdd(name, over.slice(6) as Stage);
      return;
    }
    const b = all.find((x) => `b:${x.id}` === id);
    if (!b) return;
    if (over.startsWith('stage:')) {
      const stage = over.slice(6) as Stage;
      if (stage !== b.stage) props.actions.onMove(b, stage);
    } else if (over.startsWith('target:')) {
      const t = all.find((x) => `target:${x.id}` === over);
      if (t && t.id !== b.id) props.actions.onMerge(b, t);
    }
  };

  return (
    <Box className={classes.sidebar}>
      <Group p="xs" gap={6} wrap="nowrap">
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          placeholder="Filter branches…"
          leftSection={<IconSearch size={14} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        <Tooltip label={`Fetch (последний: ${fmtAgo(props.lastFetchAt)})`}>
          <ActionIcon variant="default" size="md" onClick={props.actions.onFetch} aria-label="Fetch">
            {props.fetching ? <Loader size={14} /> : <IconRefresh size={16} />}
          </ActionIcon>
        </Tooltip>
      </Group>
      <ScrollArea style={{ flex: 1 }} type="auto">
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          {STAGES.map((s) => (
            <StageGroup
              key={s.key}
              stage={s.key}
              title={s.title}
              items={(props.data?.[s.key] ?? []).filter((b) => match(b.name))}
              selectedId={props.selectedId}
              onSelect={(b) => nav(`/projects/${props.projectId}/branches/${b.id}`)}
              onPlus={s.key === 'production' ? undefined : () => props.actions.onAddDialog(s.key)}
              onContext={props.actions.onContext}
            />
          ))}
          <Box px="xs" pt="md" pb="xs">
            <UnstyledButton onClick={() => setShowUnassigned((v) => !v)} className={classes.groupHead}>
              <Group gap={4}>
                {showUnassigned ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                <Text size="xs" fw={700} c="dimmed">
                  НЕ ДОБАВЛЕНЫ ({props.data?.unassigned.length ?? 0})
                </Text>
                {!!props.data?.hiddenCount && (
                  <Tooltip label="Скрыты правилом stage: ignore">
                    <Badge size="xs" variant="light" color="gray">
                      скрыто {props.data.hiddenCount}
                    </Badge>
                  </Tooltip>
                )}
              </Group>
            </UnstyledButton>
            <Collapse in={showUnassigned}>
              <Stack gap={0} mt={4}>
                {(props.data?.unassigned ?? [])
                  .filter((u) => match(u.name))
                  .map((u) => (
                    <UnassignedRow key={u.name} u={u} onAdd={(st) => props.actions.onAdd(u.name, st)} />
                  ))}
              </Stack>
            </Collapse>
          </Box>
        </DndContext>
      </ScrollArea>
    </Box>
  );
}

function StageGroup(props: {
  stage: Stage;
  title: string;
  items: BranchView[];
  selectedId: number | null;
  onSelect: (b: BranchView) => void;
  onPlus?: () => void;
  onContext: SidebarActions['onContext'];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${props.stage}` });
  return (
    <Box ref={setNodeRef} className={`${classes.group} ${isOver ? classes.over : ''}`} data-testid={`stage-${props.stage}`}>
      <Group justify="space-between" px="xs" className={classes.groupHead}>
        <Text size="xs" fw={700} c="dimmed">
          {props.title}
        </Text>
        {props.onPlus && (
          <ActionIcon size="sm" onClick={props.onPlus} aria-label={`Добавить в ${props.title}`}>
            <IconPlus size={14} />
          </ActionIcon>
        )}
      </Group>
      {!props.items.length && (
        <Text size="xs" c="dimmed" px="md" py={4}>
          {props.stage === 'production' ? 'нет ветки' : 'перетащите ветку сюда'}
        </Text>
      )}
      {props.items.map((b) => (
        <BranchRowItem key={b.id} b={b} selected={b.id === props.selectedId} onSelect={() => props.onSelect(b)} onContext={props.onContext} />
      ))}
    </Box>
  );
}

function BranchRowItem({ b, selected, onSelect, onContext }: { b: BranchView; selected: boolean; onSelect: () => void; onContext: SidebarActions['onContext'] }) {
  const drag = useDraggable({ id: `b:${b.id}`, disabled: b.stage === 'production' });
  const drop = useDroppable({ id: `target:${b.id}` });
  const [menu, setMenu] = useState(false);
  const running = b.liveBuild?.status === 'running';
  const style = drag.transform ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 10, position: 'relative' as const } : undefined;
  return (
    <Menu opened={menu} onChange={(o) => !o && setMenu(false)} position="right-start" withinPortal shadow="md">
      <Menu.Target>
        <Box
          ref={(n) => {
            drag.setNodeRef(n);
            drop.setNodeRef(n);
          }}
          style={style}
          {...drag.listeners}
          {...drag.attributes}
          className={`${classes.row} ${selected ? classes.selected : ''} ${drop.isOver && !drag.isDragging ? classes.mergeOver : ''}`}
          onClick={onSelect}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(true);
          }}
          data-testid={`branch-${b.name}`}
        >
          <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
            <StatusDot indicator={b.indicator} />
            <Text size="sm" truncate style={{ flex: 1 }}>
              {b.name}
            </Text>
            {b.badges.some((x) => x.kind === 'unbuilt-commits' || x.kind === 'config-changed' || x.kind === 'stage-changed' || x.kind === 'mirror-newer') && (
              <Tooltip label={b.badges.map((x) => x.text).join('\n')}>
                <Box className={classes.flag} />
              </Tooltip>
            )}
            <Text size="xs" c="dimmed">
              {b.odooVersion}
            </Text>
          </Group>
        </Box>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{b.name}</Menu.Label>
        <Menu.Item disabled={!running} onClick={() => onContext(b, 'connect')}>
          Connect
        </Menu.Item>
        <Menu.Item onClick={() => onContext(b, 'rebuild')}>Rebuild</Menu.Item>
        {b.liveBuild && (running ? <Menu.Item onClick={() => onContext(b, 'stop')}>Stop</Menu.Item> : <Menu.Item onClick={() => onContext(b, 'start')}>Start</Menu.Item>)}
        <Menu.Item onClick={() => onContext(b, 'editor')}>VS Code</Menu.Item>
        <Menu.Item onClick={() => onContext(b, 'logs')}>Логи</Menu.Item>
        {b.stage !== 'production' && (
          <>
            <Menu.Divider />
            <Menu.Label>Сменить стадию</Menu.Label>
            {(['production', 'staging', 'development'] as Stage[])
              .filter((s) => s !== b.stage)
              .map((s) => (
                <Menu.Item key={s} onClick={() => onContext(b, s)}>
                  → {s === 'production' ? 'Production' : s === 'staging' ? 'Staging' : 'Development'}
                </Menu.Item>
              ))}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

function UnassignedRow({ u, onAdd }: { u: UnassignedBranch; onAdd: (stage: Stage) => void }) {
  const drag = useDraggable({ id: `u:${u.name}` });
  const style = drag.transform ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 10, position: 'relative' as const } : undefined;
  const stage: Stage = u.suggestedStage === 'ignore' || u.suggestedStage === 'production' ? 'development' : u.suggestedStage;
  return (
    <Group ref={drag.setNodeRef} style={style} {...drag.listeners} {...drag.attributes} className={classes.row} gap={6} wrap="nowrap">
      <StatusDot indicator="none" />
      <Text size="sm" truncate style={{ flex: 1 }} c="dimmed">
        {u.name}
      </Text>
      <Tooltip label={`Добавить в ${stage}`}>
        <ActionIcon size="sm" onClick={() => onAdd(stage)} aria-label={`Добавить ${u.name}`}>
          <IconPlus size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
