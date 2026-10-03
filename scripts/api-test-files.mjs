import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Vitest treats filenames as substring filters and can silently omit a typo
 * when another requested file exists. Explicit filenames must all exist. */
export async function assertApiTestFiles(args, root) {
  for (const arg of args) {
    if (!/^(?:\.\/)?(?:apps\/api\/)?test\/.+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(arg) || /[*?[\]{}]/.test(arg)) continue;
    const file = arg.startsWith('apps/api/') || arg.startsWith('./apps/api/') ? resolve(root, arg) : resolve(root, 'apps/api', arg);
    try { await access(file); }
    catch { throw new Error(`Requested API test file does not exist: ${arg}`); }
  }
}
