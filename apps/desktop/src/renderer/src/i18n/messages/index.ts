import type { Entry } from '@bm/shared';
import common from './common';
import shell from './shell';
import dialogs from './dialogs';
import repo from './repo';
import pages from './pages';
import lists from './lists';
import branches from './branches';
import tabs from './tabs';
import history from './history';
import backups from './backups';
import branchSettings from './branchSettings';
import addProject from './addProject';
import settings from './settings';

/** All renderer dictionaries (D69); keys are prefixed by area so the spread never overwrites. */
export const messages = {
  ...common,
  ...shell,
  ...dialogs,
  ...repo,
  ...pages,
  ...lists,
  ...branches,
  ...tabs,
  ...history,
  ...backups,
  ...branchSettings,
  ...addProject,
  ...settings,
} satisfies Record<string, Entry>;
