import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/**
 * Where .env.ingest and the .ingest/ ledger live. Anchored to this file, not
 * the working directory, so the CLI behaves the same wherever it is run from —
 * `npm run -w` in particular changes directory before starting it.
 */
export const REPO_ROOT = process.env.IMAGEREPO_HOME
  ? resolve(process.env.IMAGEREPO_HOME)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const ENV_PATH = resolve(REPO_ROOT, '.env.ingest');
export const STATE_PATH = resolve(REPO_ROOT, '.ingest/state.db');

/** The directory the user was in. npm records it before switching to the package. */
const CALLER_CWD = process.env.INIT_CWD ?? process.cwd();

/** Resolves a path the user typed, relative to where they typed it. */
export function userPath(p: string): string {
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : resolve(CALLER_CWD, p);
}
