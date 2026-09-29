import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { projectConfigSchema, type ProjectConfig } from '@bm/shared';
import { demzPreset, odooPreset } from '../src/config/presets';
import { parseSkill, renderSkill, skillFile, skillHash, type SkillInput } from '../src/agents/skill';

const demz = projectConfigSchema.parse(
  demzPreset({
    id: 'demz',
    name: 'DEMZ Odoo 19',
    repo: { url: 'https://github.com/demz-ua/demz-odoo.git', mirrorDir: 'C:/bm/repos/demz-odoo.git', localFolder: 'E:/demz-odoo-19/repositories/demz-odoo' },
    github: 'DEMZ-UA/demz-odoo',
    remote: 'origin',
    projectRoot: 'E:/demz-odoo-19',
    worktreesDir: 'E:/demz-odoo-19/worktrees',
    moduleRoots: [],
    modulesToInstall: null,
    image: 'demz-odoo-19-odoo',
    network: 'demz-odoo-19_default',
    repoMount: '/mnt/repositories/demz-odoo',
    mounts: [{ host: 'E:/demz-odoo-19/config/odoo.conf', container: '/etc/odoo/odoo.conf', readOnly: true }],
    filestoreHostDir: 'E:/demz-odoo-19/data/filestore',
    postgres: { host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: 'secret-pw', protectedContainers: ['odoo19', 'odoo19-db'] },
    managedPg: { image: 'postgres:16', port: 55432 },
    stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
    productionBranch: '19.0',
    odooVersion: '19.0',
  }),
);

const shop = projectConfigSchema.parse(
  odooPreset({
    id: 'shop',
    name: 'shop',
    repo: { url: 'https://github.com/acme/shop.git', mirrorDir: 'C:/bm/repos/shop.git', localFolder: null },
    repoName: 'shop',
    github: 'acme/shop',
    remote: 'origin',
    worktreesDir: 'C:/bm/worktrees',
    filestoreHostDir: 'C:/bm/filestore/shop',
    moduleRoots: ['addons'],
    modulesToInstall: null,
    productionBranch: 'main',
    odooVersion: '18.0',
    pgPort: 55433,
    enterpriseDir: null,
  }),
);

const input = (cfg: ProjectConfig, extra: Partial<SkillInput> = {}): SkillInput => ({
  cfg,
  appVersion: '0.12.0',
  proxyPort: 8080,
  logsDir: 'C:/Users/u/AppData/Local/Odoo Branch Manager/logs',
  configDir: 'C:/Users/u/AppData/Roaming/Odoo Branch Manager',
  protectedBranches: cfg.repo.protectedBranches,
  appRepository: 'bakum/bakum_sh',
  cli: { cmd: 'C:/Users/u/AppData/Local/Odoo Branch Manager/bin/bm.cmd', sh: 'C:/Users/u/AppData/Local/Odoo Branch Manager/bin/bm' },
  ...extra,
});

describe('assistant skill (D52)', () => {
  it('matches the snapshot for DEMZ and the «Odoo in Docker» preset', () => {
    expect(skillFile(input(demz))).toMatchSnapshot();
    expect(skillFile(input(shop, { proxyPort: 80, cli: null }))).toMatchSnapshot();
  });

  it('puts the app command line first and keeps docker as the fallback (D53)', () => {
    const text = renderSkill(input(demz));
    expect(text).toContain('BM="C:/Users/u/AppData/Local/Odoo Branch Manager/bin/bm"');
    expect(text.indexOf('## Команды приложения: bm')).toBeLessThan(text.indexOf('## Без приложения: docker'));
    expect(renderSkill(input(demz, { cli: null }))).not.toContain('bm status');
  });

  it('has a frontmatter name and description Claude Code and Cursor accept', () => {
    const text = renderSkill(input(demz));
    const fm = YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]!);
    expect(fm.name).toBe('branch-manager-demz');
    expect(fm.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toContain('DEMZ Odoo 19');
  });

  it('never contains the Postgres password', () => {
    expect(skillFile(input(demz))).not.toContain('secret-pw');
    expect(skillFile(input({ ...shop, postgres: { ...shop.postgres, password: 'shop-pw-9' } }))).not.toContain('shop-pw-9');
  });

  it('uses the project values: labels, protected branches, managed Postgres, one-off options', () => {
    const text = renderSkill(input(demz, { protectedBranches: ['19.0-demz-crm', 'hotfix'] }));
    expect(text).toContain('--filter label=bm.project=demz');
    expect(text).toContain('Production `19.0` и защищённые ветки (`19.0-demz-crm`, `hotfix`)');
    expect(text).toContain('docker exec -it bm-demz-db psql -U odoo -d $DB');
    expect(text).toContain('http://prod.localhost:8080');
    expect(text).toContain("`ARGS='-c /etc/odoo/odoo.conf --data-dir=/var/lib/odoo --db_host=db --db_port=5432 --db_user=odoo --db_password='`");
    // docker exec bypasses the image entrypoint: the password comes from the container's PASSWORD, not the text.
    expect(text).toContain("sh -c 'PGPASSWORD=$PASSWORD; export PGPASSWORD; exec odoo");
    expect(text).toContain('`E:/demz-odoo-19/repositories/demz-odoo` — код правим здесь');
    expect(text).toContain('контейнер `odoo19`, контейнер `odoo19-db`');
  });

  it('tells hand edits from an older app version', () => {
    const v1 = skillFile(input(demz));
    expect(parseSkill(v1)).toEqual({ version: '0.12.0', hash: skillHash(renderSkill(input(demz))), modified: false });
    // git autocrlf: line endings do not make the file «modified».
    expect(parseSkill(v1.replace(/\n/g, '\r\n'))!.modified).toBe(false);
    expect(parseSkill(v1.replace('## Тесты', '## Тесты (мои)'))!.modified).toBe(true);
    const v2 = skillFile(input(demz, { appVersion: '0.13.0' }));
    expect(parseSkill(v2)!.hash).not.toBe(parseSkill(v1)!.hash);
    expect(parseSkill('# свой skill\n')).toBeNull();
  });
});
