import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Menu, Modal, ScrollArea, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconFileExport, IconFileImport, IconTemplate } from '@tabler/icons-react';
import type { PresetId } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { Diff } from '../Diff';
import { call, errorText } from '../../lib/bm';
import { t } from '../../i18n';

const BASES: PresetId[] = ['odoo', 'generic', 'demz'];

/**
 * Settings → project (spec 8.1, 9.4; D73): export of the project YAML and «Сохранить как пресет». Passwords never go
 * into either file; paths of this machine go into an export only on request.
 */
export function ProjectExportMenu({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [dialog, setDialog] = useState<'export' | 'preset' | 'apply' | null>(null);
  // «Застосувати пресет…»: the chosen preset or file, the YAML with it and the diff (nothing is saved before «Застосувати»).
  const [source, setSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; yaml: string; diff: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const presets = useBm('presets.list', {}, { enabled: dialog === 'apply' });
  const update = useBmMutation('projects.update');
  const [keepPaths, setKeepPaths] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(projectName);
  const [base, setBase] = useState<string>('auto');
  const save = useBmMutation('presets.save');

  const doExport = async () => {
    const path = await window.bm.desktop.selectSavePath({ title: t('exp.saveTitle'), defaultPath: `${projectId}.yaml`, extensions: ['yaml', 'yml'] });
    if (!path) return;
    setBusy(true);
    try {
      const r = await call('projects.export', { projectId, path, keepPaths });
      notifications.show({ color: 'green', message: t('exp.saved', { path: r.path }) });
      setDialog(null);
    } catch (e) {
      notifications.show({ color: 'red', title: t('common.error'), message: errorText(e), autoClose: 12000 });
    } finally {
      setBusy(false);
    }
  };

  const choose = async (key: string) => {
    setPreview(null);
    try {
      let params: { projectId: string; file?: string; path?: string } = { projectId };
      if (key === 'file') {
        const path = await window.bm.desktop.selectFile({ title: t('ap.ovPick'), extensions: ['yaml', 'yml'] });
        if (!path) return;
        params = { projectId, path };
      } else params = { projectId, file: key.slice(2) };
      setSource(key);
      setPreviewing(true);
      setPreview(await call('presets.applyPreview', params));
    } catch (e) {
      notifications.show({ color: 'red', title: t('common.error'), message: errorText(e), autoClose: 12000 });
    } finally {
      setPreviewing(false);
    }
  };
  const doApply = () =>
    preview &&
    update.mutate(
      { projectId, yaml: preview.yaml },
      {
        onSuccess: () => {
          notifications.show({ color: 'green', message: t('exp.applied', { name: preview.name }) });
          setDialog(null);
        },
      },
    );

  const doPreset = () =>
    save.mutate(
      { projectId, name: name.trim(), ...(base === 'auto' ? {} : { base: base as PresetId }) },
      {
        onSuccess: (p) => {
          notifications.show({ color: 'green', message: t('exp.presetSaved', { name: p.name }) });
          setDialog(null);
        },
      },
    );

  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button variant="default" rightSection={<IconChevronDown size={14} />}>
            {t('exp.menu')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconFileExport size={14} />} onClick={() => setDialog('export')}>
            {t('exp.export')}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconTemplate size={14} />}
            onClick={() => {
              setName(projectName);
              setDialog('preset');
            }}
          >
            {t('exp.asPreset')}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFileImport size={14} />}
            onClick={() => {
              setSource(null);
              setPreview(null);
              setDialog('apply');
            }}
          >
            {t('exp.apply')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal opened={dialog === 'export'} onClose={() => setDialog(null)} title={t('exp.exportTitle', { id: projectId })}>
        <Stack>
          <Text size="sm">{t('exp.exportText')}</Text>
          <Checkbox checked={keepPaths} onChange={(e) => setKeepPaths(e.currentTarget.checked)} label={t('exp.keepPaths')} description={t('exp.keepPathsHint')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} onClick={() => void doExport()}>
              {t('exp.saveFile')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={dialog === 'apply'} onClose={() => setDialog(null)} title={t('exp.applyTitle', { id: projectId })} size="xl">
        <Stack>
          <Text size="sm">{t('exp.applyText')}</Text>
          <Select
            label={t('exp.applySource')}
            placeholder={t('exp.applyPick')}
            value={source}
            onChange={(v) => v && void choose(v)}
            allowDeselect={false}
            data={[
              ...(presets.data ?? []).map((p) => ({ value: `p:${p.file}`, label: p.name })),
              { value: 'file', label: t('ap.ovFile') },
            ]}
            data-testid="apply-preset-source"
          />
          {preview && !preview.diff && <Alert color="gray">{t('exp.applyNoChanges', { name: preview.name })}</Alert>}
          {preview && !!preview.diff && (
            <>
              <Text size="sm" fw={600}>
                {t('exp.applyDiff', { n: preview.diff.split('\n').length })}
              </Text>
              <ScrollArea.Autosize mah={360}>
                <Diff text={preview.diff} />
              </ScrollArea.Autosize>
              <Text size="xs" c="dimmed">
                {t('exp.applyAfter')}
              </Text>
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={previewing || update.isPending} disabled={!preview?.diff} onClick={doApply}>
              {t('exp.applyButton')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={dialog === 'preset'} onClose={() => setDialog(null)} title={t('exp.presetTitle')}>
        <Stack>
          <Text size="sm">{t('exp.presetText')}</Text>
          <TextInput label={t('exp.presetName')} value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={80} data-autofocus />
          <Select
            label={t('exp.base')}
            description={t('exp.baseHint')}
            value={base}
            onChange={(v) => setBase(v ?? 'auto')}
            allowDeselect={false}
            data={[{ value: 'auto', label: t('exp.baseAuto') }, ...BASES.map((b) => ({ value: b, label: t(`preset.${b}`) }))]}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={save.isPending} disabled={!name.trim()} onClick={doPreset}>
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
