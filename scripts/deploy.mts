// One command from a laptop to production:
//
//   npm run deploy                 checks, migrations, build, deploy, smoke test
//   npm run deploy -- --dry-run    checks, and say what would change; change nothing
//   npm run deploy -- --local      apply migrations to the local dev database only
//
// Migrations go first and are additive, so the Worker running during the gap
// still works against the new schema. Wrangler asks before applying them.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(ROOT, 'packages/worker');
const DB = 'imagerepo';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const local = args.has('--local');
const skipTests = args.has('--skip-tests');
const yes = args.has('--yes');
// Lets the local mode point at a database other than wrangler's default.
const persistTo = process.env.WRANGLER_PERSIST_TO;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const step = (s: string) => console.log(`\n${bold(`▸ ${s}`)}`);
const note = (s: string) => console.log(`  ${s}`);
function die(s: string): never {
  console.error(`\n  ${red(s)}\n`);
  process.exit(1);
}

function run(cmd: string, argv: string[], opts: SpawnSyncOptions = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', ...opts });
  return { ok: r.status === 0, out: r.stdout?.toString() ?? '' };
}
const must = (label: string, cmd: string, argv: string[], opts: SpawnSyncOptions = {}) => {
  const r = run(cmd, argv, opts);
  if (!r.ok) die(`${label} failed; nothing was deployed past this point.`);
  return r;
};
const wrangler = (argv: string[], opts: SpawnSyncOptions = {}) =>
  run('npx', ['wrangler', ...argv], { cwd: WORKER, ...opts });
const where = local ? ['--local', ...(persistTo ? ['--persist-to', persistTo] : [])] : ['--remote'];

/** Runs SQL against D1 and returns the rows, or null if it errored. */
function query<T>(sql: string): T[] | null {
  const r = wrangler(['d1', 'execute', DB, ...where, '--json', '--command', sql],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const parsed = JSON.parse(r.out);
    return Array.isArray(parsed) ? parsed[0].results as T[] : null;
  } catch {
    return null;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  ${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ---------------------------------------------------------------- preflight

if (!local) {
  step('Cloudflare login');
  const who = wrangler(['whoami'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!who.ok || /not authenticated/i.test(who.out)) {
    die('Not logged in to Cloudflare. Run: (cd packages/worker && npx wrangler login)');
  }
  note(who.out.match(/associated with the email (\S+)/)?.[1] ?? 'logged in');

  step('Working tree');
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).out.trim();
  const commit = run('git', ['log', '-1', '--format=%h %s'], { stdio: ['ignore', 'pipe', 'ignore'] }).out.trim();
  note(`${branch} @ ${commit}`);
  const dirty = run('git', ['status', '--porcelain', '--', 'packages', 'migrations', 'schema.sql'],
    { stdio: ['ignore', 'pipe', 'ignore'] }).out.trim();
  if (dirty) {
    note(red('Uncommitted changes will be deployed:'));
    for (const line of dirty.split('\n')) note(`  ${line}`);
  }

  step('Typecheck and tests');
  must('Worker typecheck', 'npm', ['run', '-s', '-w', '@imagerepo/worker', 'typecheck']);
  must('Web typecheck', 'npx', ['tsc', '--noEmit'], { cwd: join(ROOT, 'packages/web') });
  if (skipTests) note('Worker tests skipped (--skip-tests)');
  else must('Worker tests', 'npm', ['run', '-s', '-w', '@imagerepo/worker', 'test'], { stdio: ['ignore', 'ignore', 'inherit'] });
  note('ok');
}

// --------------------------------------------------------------- migrations

step(`Database migrations (${local ? 'local' : 'production'})`);

const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const tables = query<{ name: string; sql: string }>(
  `SELECT name, sql FROM sqlite_master WHERE type = 'table'`);
if (!tables) die(`Could not read the ${local ? 'local' : 'production'} database.`);
const table = (name: string) => tables.find((t) => t.name === name);
if (!table('media')) {
  die(`The database has no schema yet. Apply schema.sql first:\n` +
    `  (cd packages/worker && npx wrangler d1 execute ${DB} ${where.join(' ')} --file=../../schema.sql)`);
}

const recorded = table('d1_migrations')
  ? (query<{ name: string }>('SELECT name FROM d1_migrations') ?? []).map((r) => r.name)
  : [];

if (!recorded.length) {
  // Migrations used to be applied by hand with `d1 execute`, which leaves no
  // record, so wrangler would try to run them again. Each one is recognised by
  // what it created and recorded as applied, once.
  const signs: Record<string, () => boolean> = {
    '001_drv_ext.sql': () => /\bdrv_ext\b/.test(table('media')?.sql ?? ''),
    '002_tags.sql': () => Boolean(table('tags')),
    '003_stages.sql': () => Boolean(table('media_stages')),
    '004_settings.sql': () => Boolean(table('settings')),
    '005_folders.sql': () => Boolean(table('folders')),
    '006_share_scope.sql': () => Boolean(table('share_folders')),
  };
  const present = files.filter((f) => signs[f]?.());
  if (present.length) {
    note(`No migration history yet. Already in the database, applied by hand:`);
    for (const f of present) note(`  ${f}`);
    if (dryRun) {
      note('Would record these as applied (dry run: not recorded).');
      recorded.push(...present);
    } else {
      if (!(await confirm('Record these as applied, so they are not run again?'))) die('Stopped; nothing changed.');
      // The table exactly as wrangler creates it.
      const ok = query(`
        CREATE TABLE IF NOT EXISTS d1_migrations (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
        INSERT OR IGNORE INTO d1_migrations (name) VALUES ${present.map((f) => `('${f}')`).join(', ')};
      `);
      if (!ok) die('Could not record the migration history.');
      recorded.push(...present);
      note('Recorded.');
    }
  }
}

const pending = files.filter((f) => !recorded.includes(f));
if (!pending.length) {
  note('Up to date.');
} else {
  note(`To apply: ${pending.join(', ')}`);
  if (dryRun) {
    note('(dry run: not applied)');
  } else {
    // Wrangler shows the list and asks before touching the database.
    const r = wrangler(['d1', 'migrations', 'apply', DB, ...where]);
    if (!r.ok) die('A migration failed. The Worker was not deployed.');
  }
}

if (local) {
  console.log(`\n  Local database is up to date.\n`);
  process.exit(0);
}
if (dryRun) {
  console.log(`\n  Dry run finished. Nothing was changed or deployed.\n`);
  process.exit(0);
}

// ------------------------------------------------------------ build, deploy

step('Build the web app');
must('Web build', 'npm', ['run', '-s', '-w', '@imagerepo/web', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });
note('ok');

step('Deploy the Worker');
const deployed = wrangler(['deploy'], { stdio: ['inherit', 'pipe', 'inherit'] });
process.stdout.write(deployed.out);
if (!deployed.ok) die('wrangler deploy failed. Migrations were applied; they are additive, so the old Worker still works.');

// ---------------------------------------------------------------- smoke test

step('Smoke test');
const url = deployed.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!url) {
  note('No workers.dev URL in the deploy output; skipped.');
} else {
  const app = await fetch(`${url}/`).then((r) => r.text().then((t) => ({ status: r.status, t })), () => null);
  const api = await fetch(`${url}/admin/health`).then((r) => r.status, () => 0);
  const appOk = app?.status === 200 && /<div id="root"/.test(app.t);
  // No credentials sent: the Worker answering 401 proves the new code is up and still locked.
  const apiOk = api === 401;
  note(`${appOk ? 'ok  ' : red('FAIL')}  ${url}/ serves the app`);
  note(`${apiOk ? 'ok  ' : red('FAIL')}  /admin refuses a request with no credentials (${api})`);
  if (!appOk || !apiOk) die('Deployed, but the smoke test failed. Check with: (cd packages/worker && npx wrangler tail)');
}

console.log(`\n  ${bold('Deployed.')}\n`);
