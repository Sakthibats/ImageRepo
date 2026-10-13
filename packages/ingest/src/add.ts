import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { scanLibrary, kindOf, slugify, type ScannedFile } from './scan.js';
import type { IngestState, FileRow } from './state.js';
import { fileState } from './ledger.js';
import { runFiles, type RunResult, type Storage, type Recorder } from './runner.js';
import type { PipelineOptions } from './stages/index.js';

export const fmtBytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)}${u[i]}`;
};
export const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
};
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export interface AlbumApi extends Recorder {
  ensureAlbums(albums: { id: string; title: string; seededFrom?: string }[]): Promise<unknown>;
  listAlbums(): Promise<{ albums: { id: string; title: string }[] }>;
  bake(album?: string): Promise<unknown>;
}

export interface Collected {
  files: ScannedFile[];
  /** Paths given that are not photos or videos. */
  ignored: string[];
  /** Paths given that do not exist. */
  missing: string[];
}

/**
 * Turns what the user pointed at into a list of files with albums.
 *
 *  - A folder: its subfolders become albums; photos sitting directly in it go
 *    to an album named after the folder itself.
 *  - A single file: the album is its parent folder.
 *  - `album` overrides all of that and files everything in one album.
 */
export async function collect(
  paths: string[],
  o: { album?: { id: string; title: string }; albumDepth?: number; looseAsUnsorted?: boolean } = {},
): Promise<Collected> {
  const byPath = new Map<string, ScannedFile>();
  const ignored: string[] = [];
  const missing: string[] = [];

  for (const p of paths) {
    const s = await stat(p).catch(() => null);
    if (!s) { missing.push(p); continue; }

    if (s.isDirectory()) {
      const name = basename(p);
      const loose = o.looseAsUnsorted ? undefined : { album: slugify(name), albumTitle: name };
      for (const f of await scanLibrary(p, o.albumDepth ?? 1, loose)) byPath.set(f.path, f);
      continue;
    }

    const kind = kindOf(p);
    if (!s.isFile() || !kind) { ignored.push(p); continue; }
    const parent = basename(dirname(p));
    byPath.set(p, {
      path: p, kind, size: s.size, mtime: Math.floor(s.mtimeMs / 1000),
      album: slugify(parent), albumTitle: parent,
    });
  }

  const files = [...byPath.values()];
  if (o.album) for (const f of files) { f.album = o.album.id; f.albumTitle = o.album.title; }
  return { files, ignored, missing };
}

/**
 * Finds the album a name refers to. Matching an existing album by its title
 * matters: an album renamed in the web app keeps its old id, so slugging the
 * new name would quietly create a second album with the same title.
 */
export function resolveAlbum(name: string, existing: { id: string; title: string }[]) {
  const wanted = name.trim();
  const hit = existing.find((a) => a.id === wanted)
    ?? existing.find((a) => a.title.toLowerCase() === wanted.toLowerCase())
    ?? existing.find((a) => a.id === slugify(wanted));
  return hit ? { id: hit.id, title: hit.title } : { id: slugify(wanted), title: wanted };
}

export interface AddOptions extends PipelineOptions {
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Re-upload items deleted from the library since this computer added them. */
  restore?: boolean;
  concurrency?: number;
  limit?: number;
}

export interface AddDeps {
  state: IngestState;
  storage: Storage | null;
  api: AlbumApi | null;
  /** Where the library can be viewed, for the closing message. */
  siteUrl?: string;
  out?: (line: string) => void;
  /** Overridable so tests need no terminal. */
  confirm?: (question: string) => Promise<boolean>;
  progress?: (line: string, final: boolean) => void;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a === '' || a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

function ttyProgress(line: string, final: boolean) {
  if (process.stdout.isTTY) process.stdout.write(`\r${line}   ${final ? '\n' : ''}`);
  else if (final) console.log(line);
}

/** Preview, confirm, run, bake, summarise. Returns null if the user declined. */
export async function addFiles(
  found: Collected, opts: AddOptions, deps: AddDeps,
): Promise<RunResult | null> {
  const out = deps.out ?? console.log;
  const { state, api } = deps;
  const dry = Boolean(opts.dryRun);

  for (const p of found.missing) out(`  not found: ${p}`);
  if (found.ignored.length) {
    const names = found.ignored.slice(0, 3).map((p) => basename(p)).join(', ');
    out(`  skipping ${plural(found.ignored.length, 'file')} that ${found.ignored.length === 1 ? 'is' : 'are'} not a photo or video: ${names}${found.ignored.length > 3 ? ', …' : ''}`);
  }
  if (!found.files.length) {
    out('\n  no photos or videos found\n');
    return { files: [], uploadedBytes: 0, counts: { added: 0, linked: 0, unchanged: 0, held: 0, removed: 0, failed: 0 } };
  }

  for (const f of found.files) state.upsert(f);
  let rows = state.files(found.files.map((f) => f.path));
  const runs = state.runs();
  const stateOf = (r: FileRow) => fileState(r, r.hash ? runs.get(r.hash) : undefined);

  // ---------------------------------------------------------------- preview
  let known: Set<string> | null = null;
  if (api?.configured) {
    try { known = new Set((await api.listAlbums()).albums.map((a) => a.id)); }
    catch { /* the preview just won't say which albums are new */ }
  }

  const albums = new Map<string, { title: string; photos: number; videos: number; bytes: number }>();
  for (const r of rows) {
    const a = albums.get(r.album) ?? { title: r.albumTitle, photos: 0, videos: 0, bytes: 0 };
    if (r.kind === 'photo') a.photos++; else a.videos++;
    a.bytes += r.size;
    albums.set(r.album, a);
  }
  const todo = rows.filter((r) => stateOf(r) !== 'recorded');
  const upToDate = rows.length - todo.length;
  const total = rows.reduce((n, r) => n + r.size, 0);

  out(`\n  ${plural(rows.length, 'file')} (${fmtBytes(total)}) in ${plural(albums.size, 'album')}${dry ? '  — dry run, nothing will be uploaded' : ''}\n`);
  const w = Math.max(...[...albums.values()].map((a) => a.title.length), 5);
  for (const [id, a] of albums) {
    const tag = !known ? '' : known.has(id) ? 'existing album' : 'new album';
    out(`    ${a.title.padEnd(w)}  ${tag.padEnd(14)}  ${plural(a.photos, 'photo').padStart(12)}  ${plural(a.videos, 'video').padStart(10)}  ${fmtBytes(a.bytes).padStart(8)}`);
  }
  out(`\n    ${todo.length.toLocaleString()} to add` + (upToDate ? ` · ${upToDate.toLocaleString()} already in your library` : ''));

  if (!todo.length) { out('\n  everything here is already in your library\n'); }
  else if (!dry) {
    // Upload time dominates and depends on the connection, which we cannot
    // know in advance; a live estimate replaces this once the run starts.
    const seconds = todo.reduce((n, r) => n + r.size, 0) / (20 * 1024 * 1024 / 8);
    out(`    upload: roughly ${fmtDur(seconds * 1000)} on a 20 Mbps connection, ${fmtDur(seconds * 200)} on 100 Mbps`);
  }

  if (opts.limit && todo.length > opts.limit) {
    rows = todo.slice(0, opts.limit);
    out(`    limited to the first ${opts.limit} this run`);
  }

  if (todo.length && !dry && !opts.yes) {
    const confirm = deps.confirm ?? (process.stdin.isTTY ? askYesNo : null);
    if (!confirm) {
      out('\n  not running in a terminal, so cannot ask — re-run with --yes to go ahead\n');
      return null;
    }
    if (!(await confirm('\n  Add them? [Y/n] '))) { out('\n  nothing was uploaded\n'); return null; }
  }
  out('');

  // -------------------------------------------------------------------- run

  const started = Date.now();
  const progress = deps.progress ?? ttyProgress;
  const result = await runFiles(rows, {
    state, storage: deps.storage, recorder: api, opts, concurrency: opts.concurrency,
    restore: opts.restore,
    // Albums first, so no record ever references one that does not exist.
    beforeRecord: async (ids) => {
      await api?.ensureAlbums(ids.map((id) => {
        const title = albums.get(id)?.title ?? id;
        return { id, title, seededFrom: title };
      }));
    },
    onProgress: (p) => {
      const rate = p.done / Math.max((Date.now() - started) / 1000, 0.001);
      const eta = (p.total - p.done) / Math.max(rate, 0.01);
      progress(
        `  ${String(Math.floor((p.done / p.total) * 100)).padStart(3)}%  ${p.done}/${p.total}  ` +
        `${fmtBytes(p.uploadedBytes)}  ` +
        (p.done < p.total ? `about ${fmtDur(eta * 1000)} left` : `in ${fmtDur(Date.now() - started)}`) +
        (p.failed ? `  ${p.failed} failed` : ''),
        p.done === p.total,
      );
    },
  });

  // The web app reads baked album files, so new photos are invisible until
  // the albums they landed in are baked again.
  const touched = [...new Set(result.files
    .filter((f) => f.outcome === 'added' || f.outcome === 'linked').map((f) => f.album))];
  let bakeError: string | undefined;
  if (!dry && api?.configured && touched.length) {
    try { for (const album of touched) await api.bake(album); }
    catch (e) { bakeError = String((e as Error)?.message ?? e).split('\n')[0]; }
  }

  // ---------------------------------------------------------------- summary
  const c = result.counts;
  out('');
  const line = (n: number, text: string) => { if (n) out(`    ${String(n).padStart(6)}  ${text}`); };
  line(c.added, dry ? 'would be added' : 'added');
  line(c.linked, dry ? 'already uploaded — would be filed in the album' : 'already uploaded — filed in the album');
  line(c.unchanged, 'already in your library');
  line(c.held, 'uploaded but not yet recorded');
  line(c.removed, 'deleted from your library since — left alone (add --restore brings them back)');
  line(c.failed, 'failed');

  if (c.held) {
    const why = result.files.find((f) => f.outcome === 'held')?.error;
    out(`\n  The database could not be reached${why ? ` (${why})` : ''}.`);
    out(`  The uploads are safe. Run "imagerepo retry" once it is back.`);
  }
  if (c.failed) {
    out('');
    for (const f of result.files.filter((f) => f.outcome === 'failed').slice(0, 5)) {
      out(`    ${basename(f.path)} — ${f.error}`);
    }
    out(`\n  "imagerepo failures" lists them all; "imagerepo retry" tries again.`);
  }
  if (bakeError) {
    out(`\n  Uploaded, but the albums could not be refreshed (${bakeError}).`);
    out(`  Run "imagerepo bake" to make the new items appear.`);
  }
  if (!dry && (c.added || c.linked) && !c.held && !bakeError && deps.siteUrl) {
    out(`\n  View them at ${deps.siteUrl}`);
  }
  out('');
  return result;
}
