// The ledger forgets its uploads when the library has been purged.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, syncEpoch } from '../src/ledger.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('\nlibrary epoch\n');

const state = openLedger(join(mkdtempSync(join(tmpdir(), 'imagerepo-epoch-')), 'state.db'));
const remember = () => {
  state.upsert({ path: '/p/a.jpg', album: 'trip', albumTitle: 'Trip', kind: 'photo', size: 1, mtime: 1 });
  state.setHash('/p/a.jpg', 'a'.repeat(32));
  state.saveRun('a'.repeat(32), 'original', 1, { ext: 'jpg' });
};
remember();

check('an older Worker without an epoch changes nothing', !syncEpoch(state, null) && state.files().length === 1);
check('the starting epoch matches a ledger that never saw one', !syncEpoch(state, 'initial') && state.files().length === 1);
check('a new epoch resets the ledger', syncEpoch(state, 'e1') && state.files().length === 0 && state.runs().size === 0);
remember();
check('the same epoch again keeps what was added since', !syncEpoch(state, 'e1') && state.files().length === 1);
check('a second purge resets again', syncEpoch(state, 'e2') && state.files().length === 0);
state.close();

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
