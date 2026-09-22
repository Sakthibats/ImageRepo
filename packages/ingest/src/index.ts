#!/usr/bin/env node
import { Command } from 'commander';
import pLimit from 'p-limit';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { scanLibrary, summarise } from './scan.js';
import { IngestState } from './state.js';
import { R2 } from './r2.js';
import { AdminApi } from './api.js';
import { processFile } from './pipeline.js';
import { hashFile } from './hash.js';
import type { MediaRecord } from '@imagerepo/shared';

const CLI_VERSION = '0.1.0';
const STATE_PATH = resolve(process.cwd(), '.ingest/state.db');

const fmtBytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)}${u[i]}`;
};
const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
};

const program = new Command();
program.name('imagerepo').description('Ingest a photo library into R2 + D1').version(CLI_VERSION);

// ----------------------------------------------------------------- scan
program
  .command('scan')
  .description('Walk the library and show what would be ingested. Touches nothing.')
  .argument('<root>', 'library root folder')
  .option('--album-depth <n>', 'folder levels that form an album name', (v) => parseInt(v, 10), 1)
  .action(async (root: string, opts) => {
    const files = await scanLibrary(resolve(root), opts.albumDepth);
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

// -------------------------------------------------------------- process
program
  .command('process')
  .description('Hash, derive, strip metadata, upload, and record.')
  .argument('<root>', 'library root folder')
  .option('--dry-run', 'process locally, upload nothing', false)
  .option('--limit <n>', 'stop after N files (use this for your first run)', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'files in flight', (v) => parseInt(v, 10), 4)
  .option('--preserve-original', 'upload byte-exact originals, keeping GPS', false)
  .option('--preview-all-video', 'generate a 720p preview for every video', false)
  .option('--album-depth <n>', 'folder levels that form an album name', (v) => parseInt(v, 10), 1)
  .action(async (root: string, opts) => {
    const state = new IngestState(STATE_PATH);
    const files = await scanLibrary(resolve(root), opts.albumDepth);
    for (const f of files) state.upsert(f);

    let cfg = null, r2: R2 | null = null, api: AdminApi | null = null;
    if (!opts.dryRun) {
      cfg = loadConfig();
      r2 = new R2(cfg);
      api = new AdminApi(cfg);
      const chk = await r2.check();
      if (!chk.ok) { console.error(`\n  R2 unreachable: ${chk.error}\n`); process.exit(1); }
    }

    const queue = state.pending(opts.limit);
    if (!queue.length) {
      console.log('\n  nothing pending — everything is already ingested\n');
      state.close(); return;
    }

    // Seed albums first so the metadata post never references a missing album.
    if (api?.configured) {
      const albums = [...summarise(files)].map(([id, a]) => ({ id, title: a.title, seededFrom: a.title }));
      await api.ensureAlbums(albums);
    }

    console.log(`\n  ${queue.length.toLocaleString()} files to process${opts.dryRun ? '  (dry run)' : ''}\n`);

    const limit = pLimit(opts.concurrency);
    const batch: MediaRecord[] = [];
    let done = 0, failed = 0, bytes = 0;
    const started = Date.now();

    const flush = async () => {
      if (!batch.length || !api?.configured) { batch.length = 0; return; }
      const chunk = batch.splice(0, batch.length);
      await api.recordMedia(chunk);
      for (const r of chunk) {
        const row = queue.find((q) => q.hash === r.id);
        if (row) state.setStatus(row.path, 'recorded', undefined, r.derivatives);
      }
    };

    await Promise.all(queue.map((row) => limit(async () => {
      try {
        if (!row.hash) { row.hash = await hashFile(row.path); state.setHash(row.path, row.hash); }

        const dup = state.findByHash(row.hash);
        if (dup && dup.path !== row.path) {
          state.setStatus(row.path, 'skipped', 'duplicate of ' + dup.path);
          done++; return;
        }

        const res = await processFile(row, r2, {
          preserveOriginal: opts.preserveOriginal,
          previewAllVideo: opts.previewAllVideo,
          dryRun: opts.dryRun,
        });

        bytes += res.uploadedBytes;
        state.setStatus(row.path, opts.dryRun ? 'processed' : 'uploaded', undefined, res.record.derivatives);
        // Persist before attempting the POST, so a Worker outage never
        // discards work that took CPU to produce.
        state.saveRecord(row.path, res.record);
        batch.push(res.record);
        if (batch.length >= 200) await flush();

        done++;
        if (done % 25 === 0 || done === queue.length) {
          const pct = ((done / queue.length) * 100).toFixed(0);
          const rate = done / ((Date.now() - started) / 1000);
          const eta = (queue.length - done) / Math.max(rate, 0.01);
          process.stdout.write(
            `\r  ${pct}%  ${done}/${queue.length}  ${fmtBytes(bytes)}  ` +
            `${rate.toFixed(1)}/s  eta ${fmtDur(eta * 1000)}${failed ? `  ${failed} failed` : ''}   `
          );
        }
      } catch (e: any) {
        failed++;
        state.setStatus(row.path, 'failed', String(e?.message ?? e).slice(0, 500));
      }
    })));

    await flush();
    console.log(`\n\n  done in ${fmtDur(Date.now() - started)} — ${done} processed, ${failed} failed, ${fmtBytes(bytes)}\n`);
    if (failed) console.log(`  re-run to retry failures, or 'imagerepo status' to inspect them\n`);
    const held = state.unrecorded().length;
    if (held) {
      console.log(`  ${held} records held locally (worker not configured).`);
      console.log(`  set ADMIN_API_URL + ADMIN_TOKEN, then: imagerepo flush\n`);
    }
    state.close();
  });

// ---------------------------------------------------------------- flush
program
  .command('flush')
  .description('Send locally held metadata to the Worker. Safe to re-run.')
  .option('--batch <n>', 'records per request', (v) => parseInt(v, 10), 200)
  .action(async (opts) => {
    const state = new IngestState(STATE_PATH);
    const api = new AdminApi(loadConfig());
    if (!api.configured) {
      console.error('\n  ADMIN_API_URL / ADMIN_TOKEN not set in .env.ingest\n');
      process.exit(1);
    }
    const held = state.unrecorded();
    if (!held.length) { console.log('\n  nothing held — everything is recorded\n'); state.close(); return; }

    const records: MediaRecord[] = held.map((h) => JSON.parse(h.record));
    const used = new Set(records.flatMap((r) => r.albums));
    const albums = state.albumTitles()
      .filter((a) => used.has(a.id))
      .map((a) => ({ id: a.id, title: a.title, seededFrom: a.title }));
    await api.ensureAlbums(albums);

    console.log(`\n  sending ${records.length} records...`);
    let sent = 0;
    for (let i = 0; i < records.length; i += opts.batch) {
      const chunk = records.slice(i, i + opts.batch);
      await api.recordMedia(chunk);
      for (const r of chunk) {
        const row = held.find((h) => JSON.parse(h.record).id === r.id);
        if (row) state.setStatus(row.path, 'recorded');
      }
      sent += chunk.length;
      process.stdout.write(`\r  ${sent}/${records.length}   `);
    }
    console.log(`\n  done — ${sent} recorded\n`);
    state.close();
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
    const hits = shares.filter((s) => String(s.token_hash).startsWith(prefix.replace(/\u2026|\.\.\./g, '')));
    if (!hits.length) { console.error(`\n  no share matching "${prefix}"\n`); process.exit(1); }
    if (hits.length > 1) { console.error(`\n  "${prefix}" matches ${hits.length} shares — be more specific\n`); process.exit(1); }
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
  .description('Show ingest progress from the local ledger.')
  .action(() => {
    const state = new IngestState(STATE_PATH);
    const counts = state.counts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!total) { console.log('\n  nothing scanned yet\n'); state.close(); return; }

    console.log(`\n  ${total.toLocaleString()} files tracked — ${fmtBytes(state.totalBytes())}\n`);
    for (const [k, v] of Object.entries(counts)) {
      console.log(`    ${k.padEnd(10)} ${String(v).padStart(7)}`);
    }
    console.log('\n  albums:');
    for (const a of state.albums()) console.log(`    ${a.album.padEnd(32)} ${String(a.n).padStart(6)}`);
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
    try { cfg = loadConfig(); line(true, 'config', `bucket "${cfg.bucket}"`); }
    catch (e: any) { line(false, 'config', e?.message?.split('\n')[0] ?? ''); console.log(); return; }

    const chk = await new R2(cfg).check();
    line(chk.ok, 'R2 bucket', chk.ok ? `reachable (${chk.objects} objects sampled)` : chk.error ?? '');

    const api = new AdminApi(cfg);
    if (!api.configured) line(false, 'worker api', 'ADMIN_API_URL / ADMIN_TOKEN not set (fine until Phase 2)');
    else { const h = await api.health(); line(h.ok, 'worker api', h.ok ? cfg.apiUrl : h.error ?? ''); }
    console.log();
  });

program.parseAsync().catch((e) => { console.error(`\n  ${e?.message ?? e}\n`); process.exit(1); });
