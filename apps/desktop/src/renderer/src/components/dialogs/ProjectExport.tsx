import { useState } from 'react';
import { Button, Checkbox, Group, Menu, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconFileExport, IconTemplate } from '@tabler/icons-react';
import type { PresetId } from '@bm/shared';
import { useBmMutation } from '../../lib/query';
import { call, errorText } from '../../lib/bm';
import { t } from '../../i18n';

const BASES: PresetId[] = ['odoo', 'generic', 'demz'];

/**
 * Settings → project (spec 8.1, 9.4; D73): export of the project YAML and «Сохранить как пресет». Passwords never go
 * into either file; paths of this machine go into an export only on request.
 */
export function ProjectExportMenu({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [dialog, setDialog] = useState<'export' | 'preset' | null>(null);
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
