// Decides which CI groups a push or pull request needs (.github/workflows/ci.yml,
// job `changes`). docs/ci-and-testing.md explains the rules.
//
//   api  the four api test shards and the migration/backup smokes
//   web  the browser (Playwright) shards
//   code anything that is not documentation: typecheck, lint, unit tests,
//        builds and the image smoke. Docs-only changes run only the doc checks.
//
// Conservative by design: a file no rule knows, an empty or unreadable diff, a
// new branch, a force push or a base that is not an ancestor runs everything.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ZERO_SHA = /^0+$/;

/** Each changed path maps to the groups it needs. First match wins. */
const RULES = [
  [/^docs\//, []],
  [/^[^/]+\.md$/, []],
  [/^apps\/api\//, ['api']],
  [/^apps\/web\//, ['web']],
  [/^packages\/shared\//, ['api', 'web']],
  [/^scripts\//, ['api']],
];

export function classify(files) {
  const groups = { api: false, web: false };
  for (const file of files) {
    const rule = RULES.find(([pattern]) => pattern.test(file));
    // pnpm-lock.yaml, .github/**, root configs, patches/** and anything new.
    for (const group of rule ? rule[1] : ['api', 'web']) groups[group] = true;
  }
  return { ...groups, code: groups.api || groups.web };
}

const everything = (reason) => ({ api: true, web: true, code: true, reason, files: [] });

/**
 * Picks the commit to diff against.
 *  - pull_request: the merge base with the PR's base commit.
 *  - push: the head of the branch's latest successful CI run (LAST_GREEN_SHA),
 *    not just `before`. A run cancelled by a newer push, or a red one, then
 *    has its changes checked again by the next run, so a docs-only push on
 *    top of an untested api change still runs the api tests.
 */
export function decide({ event, eventName, lastGreen, git }) {
  let base;
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    if (!base) return everything('pull request without a base commit');
  } else if (eventName === 'push') {
    if (!event.before || ZERO_SHA.test(event.before)) return everything('new branch (before is the zero SHA)');
    if (event.forced) return everything('force push');
    if (!lastGreen) return everything('no successful CI run on this branch to diff against');
    base = lastGreen;
  } else {
    return everything(`event ${eventName}`);
  }
  if (!git.isAncestor(base, 'HEAD')) return everything(`${base.slice(0, 12)} is not an ancestor of HEAD`);
  const files = git.changedFiles(base);
  if (files.length === 0) return everything(`no file changed since ${base.slice(0, 12)} (a re-run)`);
  return { ...classify(files), reason: `${files.length} files changed since ${base.slice(0, 12)}`, files };
}

const shell = {
  isAncestor(base, head) {
    try { execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' }); return true; }
    catch { return false; }
  },
  changedFiles(base) {
    const out = execFileSync('git', ['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`], { encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  },
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    result = decide({ event, eventName: process.env.GITHUB_EVENT_NAME, lastGreen: process.env.LAST_GREEN_SHA?.trim(), git: shell });
  } catch (error) {
    result = everything(`could not compute the diff: ${error instanceof Error ? error.message : error}`);
  }
  const outputs = { api: result.api, web: result.web, code: result.code };
  console.log(`${result.reason}\n${JSON.stringify(outputs)}`);
  if (result.files.length) console.log(result.files.slice(0, 200).join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Changed groups\n\n${result.reason}\n\n| api | web | code |\n| --- | --- | --- |\n| ${outputs.api} | ${outputs.web} | ${outputs.code} |\n`);
  }
}
