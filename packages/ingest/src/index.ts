import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { scanLibrary, summarise } from './scan.js';
import { openLedger, fileState, failureOf } from './ledger.js';
import { R2 } from './r2.js';
import { AdminApi } from './api.js';
import { addFiles, collect, resolveAlbum, fmtBytes, fmtDur, type AddOptions } from './add.js';
import { runFiles } from './runner.js';
import { STAGES } from './stages/index.js';
import { ENV_PATH, STATE_PATH, userPath } from './paths.js';

const CLI_VERSION = '0.2.0';
const int = (v: string) => parseInt(v, 10);

const program = new Command();
program.name('imagerepo').description('Add photos and videos to your ImageRepo library').version(CLI_VERSION);

/** Stops with a plain-language reason. */
function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/**
 * Checks everything an upload needs before any work starts, so the first
 * problem is reported in the first second rather than after an hour.
 */
async function connect(): Promise<{ cfg: Config; r2: R2; api: AdminApi }> {
  let cfg: Config;
  try { cfg = loadConfig(); }
  catch (e: any) { fail(e.message); }

  const r2 = new R2(cfg);
  const chk = await r2.check();
  if (!chk.ok) fail(`Can't reach your storage bucket "${cfg.bucket}": ${chk.error}\n  Check the R2 keys in ${ENV_PATH}`);

  const api = new AdminApi(cfg);
  if (api.configured) {
    const h = await api.health();
    if (!h.ok) fail(`Can't reach your library at ${cfg.apiUrl}: ${h.error}\n  Run "imagerepo doctor" for details.`);
  }
  return { cfg, r2, api };
}

async function needTool(bin: string, why: string) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try { await promisify(execFile)(bin, ['-version']); }
  catch { fail(`${bin} is not installed, and ${why}.\n  Install it with: brew install ffmpeg`); }
}

const pipelineFlags = (c: Command) => c
  .option('--dry-run', 'show what would happen; upload nothing', false)
  .option('-y, --yes', 'do not ask for confirmation', false)
  .option('--limit <n>', 'stop after N files', int)
  .option('--concurrency <n>', 'files in flight', int, 4)
  .option('--preserve-original', 'upload byte-exact originals, keeping GPS', false)
  .option('--preview-all-video', 'generate a 720p preview for every video', false)
  .option('--album-depth <n>', 'folder levels that form an album name', int, 1);

async function runAdd(paths: string[], opts: any, legacyLibrary: boolean) {
  const targets = paths.map(userPath);
  const online = opts.dryRun ? null : await connect();

  let album: { id: string; title: string } | undefined;
  if (opts.album) {
    const existing = online?.api.configured ? (await online.api.listAlbums()).albums : [];
    album = resolveAlbum(opts.album, existing);
  }

  const found = await collect(targets, {
    album, albumDepth: opts.albumDepth, looseAsUnsorted: legacyLibrary,
  });
  if (found.files.some((f) => f.kind === 'video')) {
    await needTool('ffmpeg', 'videos need it');
    await needTool('ffprobe', 'videos need it');
  }

  const state = openLedger(STATE_PATH);
  try {
    const addOpts: AddOptions = {
      dryRun: opts.dryRun, yes: opts.yes || legacyLibrary, limit: opts.limit,
      concurrency: opts.concurrency,
      preserveOriginal: opts.preserveOriginal, previewAllVideo: opts.previewAllVideo,
    };
    const result = await addFiles(found, addOpts, {
      state, storage: online?.r2 ?? null, api: online?.api ?? null,
      siteUrl: online?.cfg.apiUrl || undefined,
    });
    if (result && (result.counts.failed || result.counts.held)) process.exitCode = 1;
  } finally {
    state.close();
  }
}

// ------------------------------------------------------------------ add
pipelineFlags(program
  .command('add')
  .description('Add photos and videos. Point it at files, folders, or both.')
  .argument('<paths...>', 'files or folders')
  .option('-a, --album <name>', 'put everything in this album (created if new)'))
  .addHelpText('after', `
Examples:
  imagerepo add ~/Pictures/Goa                 one album, named "Goa"
  imagerepo add ~/Pictures                     each subfolder becomes an album
  imagerepo add IMG_1.jpg IMG_2.jpg -a "Mum"   these files, into the album "Mum"
  imagerepo add ~/Pictures/Goa --dry-run       see what would happen first

Safe to re-run: anything already in your library is skipped.`)
  .action((paths: string[], opts) => runAdd(paths, opts, false));

// -------------------------------------------------------------- process
pipelineFlags(program
  .command('process')
  .description('Add a whole library folder without asking. Loose files go to "unsorted".')
  .argument('<root>', 'library root folder'))
  .action((root: string, opts) => runAdd([root], opts, true));

// ---------------------------------------------------------------- retry
program
  .command('retry')
  .description('Try again: everything that failed or was left unfinished.')
  .option('--concurrency <n>', 'files in flight', int, 4)
  .action(async (opts) => {
    const state = openLedger(STATE_PATH);
    const runs = state.runs();
    const all = state.files().filter((f) => fileState(f, f.hash ? runs.get(f.hash) : undefined) !== 'recorded');
    const gone = all.filter((f) => !existsSync(f.path));
    const rows = all.filter((f) => existsSync(f.path));
    if (gone.length) console.log(`\n  ${gone.length} unfinished file(s) are no longer on disk and were left alone`);
    if (!rows.length) { console.log('\n  nothing to retry\n'); state.close(); return; }

    const { cfg, r2, api } = await connect();
    try {
      // The ledger already knows each file's album, so nothing is re-scanned.
      const found = { files: rows.map((r) => ({ ...r })), ignored: [], missing: [] };
      const result = await addFiles(found, { yes: true, concurrency: opts.concurrency }, {
        state, storage: r2, api, siteUrl: cfg.apiUrl || undefined,
      });
      if (result && (result.counts.failed || result.counts.held)) process.exitCode = 1;
    } finally {
      state.close();
    }
  });

// ------------------------------------------------------------- failures
program
  .command('failures')
  .description('List files that could not be added, and why.')
  .action(() => {
    const state = openLedger(STATE_PATH);
    const runs = state.runs();
    const failed = state.files().filter((f) => fileState(f, f.hash ? runs.get(f.hash) : undefined) === 'failed');
    if (!failed.length) { console.log('\n  no failures\n'); state.close(); return; }
    console.log();
    for (const f of failed) {
      console.log(`  ${f.path}`);
      console.log(`      ${failureOf(f, f.hash ? runs.get(f.hash) : undefined)}`);
    }
    console.log(`\n  ${failed.length} failed — "imagerepo retry" tries them again\n`);
    state.close();
  });

// ---------------------------------------------------------------- flush
program
  .command('flush')
  .description('Record uploads the database has not heard about yet. Safe to re-run.')
  .action(async () => {
    const state = openLedger(STATE_PATH);
    const api = new AdminApi(loadConfig());
    if (!api.configured) { state.close(); fail(`ADMIN_API_URL / ADMIN_TOKEN are not set in ${ENV_PATH}`); }

    const runs = state.runs();
    const held = state.files().filter((f) => fileState(f, f.hash ? runs.get(f.hash) : undefined) === 'uploaded');
    if (!held.length) { console.log('\n  nothing held — everything is recorded\n'); state.close(); return; }

    const used = new Set(held.map((f) => f.album));
    await api.ensureAlbums(state.albumTitles()
      .filter((a) => used.has(a.id))
      .map((a) => ({ id: a.id, title: a.title, seededFrom: a.title })));

    console.log(`\n  recording ${held.length} file(s)...`);
    const result = await runFiles(held, { state, storage: null, recorder: api, opts: {}, recordOnly: true });
    for (const album of used) await api.bake(album);
    console.log(`  done — ${result.counts.added + result.counts.linked} recorded` +
      (result.counts.held ? `, ${result.counts.held} still held` : '') + '\n');
    state.close();
  });

// ----------------------------------------------------------------- scan
program
  .command('scan')
  .description('Walk a folder and show what is in it. Touches nothing.')
  .argument('<root>', 'library root folder')
  .option('--album-depth <n>', 'folder levels that form an album name', int, 1)
  .action(async (root: string, opts) => {
    const files = await scanLibrary(userPath(root), opts.albumDepth);
    const albums = summarise(files);
    const bytes = files.reduce((a, f) => a + f.size, 0);

    console.log(`\n${files.length.toLocaleString()} files in ${albums.size} albums — ${fmtBytes(bytes)}\n`);
    const w = Math.max(...[...albums.values()].map((a) => a.title.length), 5);
    for (const [slug, a] of [...albums].sort((x, y) => y[1].bytes - x[1].bytes)) {
      console.log(
        `  ${a.title.padEnd(w)}  ${String(a.photos).padStart(6)} photos  ` +
        `${String(a.videos).padStart(5)} videos  ${fmtBytes(a.bytes).padStart(8)}   ${slug}`
      );
    }
    const est = bytes / (20 * 1024 * 1024 / 8);
    console.log(`\n  upload estimate: ${fmtDur(est * 1000)} at 20Mbps, ${fmtDur(est * 1000 / 5)} at 100Mbps\n`);
  });

// ---------------------------------------------------------------- share
const share = program.command('share').description('Manage read-only share links.');

share
  .command('create')
  .description('Mint a share link for an album. The URL is shown once.')
  .argument('<album>', 'album id (see: imagerepo share albums)')
  .option('--label <text>', 'a note for yourself, e.g. "sent to mum"')
  .option('--days <n>', 'expire after N days', (v) => parseFloat(v))
  .option('--passcode <text>', 'require a passcode')
  .option('--no-download', 'viewers can browse but not download originals')
  .action(async (album: string, opts) => {
    const api = new AdminApi(loadConfig());
    const r = await api.createShare({
      albumId: album,
      label: opts.label,
      expiresInDays: opts.days,
      passcode: opts.passcode,
      allowDownload: opts.download !== false,
    });
    console.log(`\n  ${r.url}\n`);
    console.log(`  album      ${album}`);
    console.log(`  expires    ${r.expiresAt ? new Date(r.expiresAt * 1000).toLocaleString() : 'never'}`);
    console.log(`  passcode   ${r.hasPasscode ? 'yes' : 'no'}`);
    console.log(`  downloads  ${r.allowDownload ? 'allowed' : 'blocked'}`);
    console.log(`  revoke     imagerepo share revoke ${r.tokenHash.slice(0, 16)}…`);
    console.log(`\n  The link is not stored anywhere — copy it now.\n`);
  });

share
  .command('list')
  .description('List share links and their status.')
  .action(async () => {
    const api = new AdminApi(loadConfig());
    const { shares } = await api.listShares();
    if (!shares.length) { console.log('\n  no share links\n'); return; }
    const now = Math.floor(Date.now() / 1000);
    console.log();
    for (const s of shares) {
      const state = s.revoked ? 'revoked'
        : s.expires_at && s.expires_at < now ? 'expired' : 'active';
      console.log(
        `  ${state.padEnd(8)} ${String(s.album_id).padEnd(14)} ` +
        `views=${String(s.view_count).padStart(4)}  ` +
        `${s.has_passcode ? 'passcode ' : '         '}` +
        `${s.allow_download ? 'dl ' : '   '} ` +
        `${s.label ?? ''}`
      );
      console.log(`           ${s.token_hash.slice(0, 24)}…`);
    }
    console.log();
  });

share
  .command('revoke')
  .description('Revoke a link immediately. Accepts a token-hash prefix.')
  .argument('<tokenHashPrefix>')
  .action(async (prefix: string) => {
    const api = new AdminApi(loadConfig());
    const { shares } = await api.listShares();
    const hits = shares.filter((s) => String(s.token_hash).startsWith(prefix.replace(/…|\.\.\./g, '')));
    if (!hits.length) fail(`no share matching "${prefix}"`);
    if (hits.length > 1) fail(`"${prefix}" matches ${hits.length} shares — be more specific`);
    await api.revokeShare(hits[0].token_hash);
    console.log(`\n  revoked — album "${hits[0].album_id}"${hits[0].label ? ` (${hits[0].label})` : ''}\n`);
  });

share
  .command('albums')
  .description('List albums you can share.')
  .action(async () => {
    const api = new AdminApi(loadConfig());
    const { albums } = await api.listAlbums();
    console.log();
    for (const a of albums) console.log(`  ${String(a.id).padEnd(20)} ${String(a.n).padStart(5)} items   ${a.title}`);
    console.log();
  });

// ---------------------------------------------------------------- bake
program
  .command('bake')
  .description('Regenerate album manifests.')
  .argument('[album]', 'one album, or all if omitted')
  .action(async (album?: string) => {
    const api = new AdminApi(loadConfig());
    const r = await api.bake(album) as any;
    console.log(`\n  baked ${r.baked?.length ?? 0} album(s)\n`);
  });

// --------------------------------------------------------------- status
program
  .command('status')
  .description('Show what this computer has added, from the local ledger.')
  .action(() => {
    const state = openLedger(STATE_PATH);
    const files = state.files();
    if (!files.length) { console.log('\n  nothing added yet\n'); state.close(); return; }

    const runs = state.runs();
    const counts: Record<string, number> = {};
    const albums = new Map<string, number>();
    for (const f of files) {
      const s = fileState(f, f.hash ? runs.get(f.hash) : undefined);
      counts[s] = (counts[s] ?? 0) + 1;
      albums.set(f.albumTitle, (albums.get(f.albumTitle) ?? 0) + 1);
    }
    const label: Record<string, string> = {
      recorded: 'in your library', uploaded: 'uploaded, not yet recorded',
      pending: 'not yet added', failed: 'failed',
    };
    console.log(`\n  ${files.length.toLocaleString()} files tracked — ${fmtBytes(files.reduce((n, f) => n + f.size, 0))}\n`);
    for (const k of ['recorded', 'uploaded', 'pending', 'failed']) {
      if (counts[k]) console.log(`    ${String(counts[k]).padStart(7)}  ${label[k]}`);
    }
    console.log('\n  albums:');
    for (const [title, n] of [...albums].sort()) console.log(`    ${title.padEnd(32)} ${String(n).padStart(6)}`);
    console.log(`\n  stages:  photo ${STAGES.photo.map((s) => `${s.name}@${s.version}`).join(' → ')}`);
    console.log(`           video ${STAGES.video.map((s) => `${s.name}@${s.version}`).join(' → ')}`);
    if (counts.failed) console.log(`\n  "imagerepo failures" shows what went wrong`);
    console.log();
    state.close();
  });

// --------------------------------------------------------------- doctor
program
  .command('doctor')
  .description('Check tooling and cloud connectivity.')
  .action(async () => {
    console.log();
    const line = (ok: boolean, label: string, detail = '') =>
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(22)} ${detail}`);

    line(Number(process.versions.node.split('.')[0]) >= 20, 'node >= 20', process.versions.node);

    for (const bin of ['ffmpeg', 'ffprobe']) {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { stdout } = await promisify(execFile)(bin, ['-version']);
        line(true, bin, stdout.split('\n')[0].split(' ').slice(0, 3).join(' '));
      } catch { line(false, bin, 'not found — brew install ffmpeg'); }
    }

    try {
      const sharp = (await import('sharp')).default;
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).avif().toBuffer();
      line(true, 'sharp + AVIF', 'encoding works');
    } catch (e: any) { line(false, 'sharp + AVIF', e?.message ?? ''); }

    let cfg;
    try { cfg = loadConfig(); line(true, 'config', `${basename(ENV_PATH)}, bucket "${cfg.bucket}"`); }
    catch (e: any) { line(false, 'config', e?.message?.split('\n').join(' ') ?? ''); console.log(); return; }

    const chk = await new R2(cfg).check();
    line(chk.ok, 'R2 bucket', chk.ok ? `reachable (${chk.objects} objects sampled)` : chk.error ?? '');

    const api = new AdminApi(cfg);
    if (!api.configured) line(false, 'worker api', 'ADMIN_API_URL / ADMIN_TOKEN not set');
    else { const h = await api.health(); line(h.ok, 'worker api', h.ok ? cfg.apiUrl : h.error ?? ''); }
    console.log();
  });

program.parseAsync().catch((e) => { console.error(`\n  ${e?.message ?? e}\n`); process.exit(1); });
