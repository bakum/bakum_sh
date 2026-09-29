import YAML, { isMap, isSeq, type YAMLMap } from 'yaml';

/**
 * Project files written before D37 may still name the Staging stage. Rewrites the document so it validates again:
 * `stages.staging` goes away and its settings fill the overrides of every rule that sent branches to Staging (values
 * the rule states win), such rules and `hooks[].stages` say `development` instead. Those branches keep building the
 * way they did. Comments and formatting of the file are kept. Returns null when there is nothing to migrate.
 */
export function migrateProjectYaml(text: string): string | null {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) return null;
  let changed = false;

  const staging = doc.getIn(['stages', 'staging'], true);
  if (staging !== undefined) {
    doc.deleteIn(['stages', 'staging']);
    changed = true;
  }
  const stagingMap = isMap(staging) ? staging : null;
  // `folder` is a per-branch setting (rejected in rules); it was invalid under stages as well.
  stagingMap?.delete('folder');

  const rules = doc.get('branchRules', true);
  if (isSeq(rules)) {
    for (const rule of rules.items) {
      if (!isMap(rule) || rule.get('stage') !== 'staging') continue;
      rule.set('stage', 'development');
      if (stagingMap && stagingMap.items.length) {
        const own = rule.get('overrides', true);
        if (isMap(own)) fillMissing(doc, own, stagingMap);
        else rule.set('overrides', doc.createNode(stagingMap.toJSON()));
      }
      changed = true;
    }
  }

  const hooks = doc.get('hooks', true);
  if (isSeq(hooks)) {
    for (const hook of hooks.items) {
      if (!isMap(hook)) continue;
      const stages = hook.get('stages');
      if (!isSeq(stages) || !stages.items.some((s) => YAML.isScalar(s) && s.value === 'staging')) continue;
      const next = [...new Set(stages.toJSON().map((s: unknown) => (s === 'staging' ? 'development' : s)))];
      hook.set('stages', doc.createNode(next));
      changed = true;
    }
  }

  return changed ? doc.toString() : null;
}

/** Copies keys of `from` that `into` does not state; nested maps are filled key by key (like mergeLevels). */
function fillMissing(doc: YAML.Document, into: YAMLMap, from: YAMLMap): void {
  for (const pair of from.items) {
    const key = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
    const mine = into.get(key, true);
    if (mine === undefined) into.set(key, doc.createNode(YAML.isNode(pair.value) ? pair.value.toJSON() : pair.value));
    else if (isMap(mine) && isMap(pair.value)) fillMissing(doc, mine, pair.value);
  }
}
