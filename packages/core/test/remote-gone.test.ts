import { describe, expect, it } from 'vitest';
import { remoteGoneDecision } from '../src/services/remote-gone';
import { userChanges } from '../src/git';
import { APP_STAGE_DEFAULTS } from '../src/config/presets';

describe('branch deleted on the remote (D50)', () => {
  const dev = { stage: 'development' as const, scope: APP_STAGE_DEFAULTS.development, protectedBranch: false, dirty: false };

  it('deletes a Development branch by default', () => {
    expect(remoteGoneDecision(dev)).toBeNull();
  });

  it('keeps what may hold the user’s work or the production data', () => {
    expect(remoteGoneDecision({ ...dev, stage: 'production', scope: { ...APP_STAGE_DEFAULTS.production, deleteWithRemote: true } })).toBe('production');
    expect(remoteGoneDecision({ ...dev, scope: { ...dev.scope, protected: true } })).toBe('protected');
    expect(remoteGoneDecision({ ...dev, protectedBranch: true })).toBe('protected');
    expect(remoteGoneDecision({ ...dev, scope: { ...dev.scope, folder: 'E:/work/repo' } })).toBe('folder');
    expect(remoteGoneDecision({ ...dev, scope: { ...dev.scope, deleteWithRemote: false } })).toBe('setting');
    expect(remoteGoneDecision({ ...dev, dirty: true })).toBe('dirty');
  });

  it('does not count Python bytecode Odoo wrote into the worktree as the user’s changes', () => {
    expect(userChanges('?? addons/bm_probe/__pycache__/\n?? addons/x/models/y.cpython-312.pyc\n')).toEqual([]);
    expect(userChanges(' M addons/bm_probe/models.py\n?? addons/bm_probe/__pycache__/\n?? notes.txt\n')).toEqual([
      ' M addons/bm_probe/models.py',
      '?? notes.txt',
    ]);
  });
});
