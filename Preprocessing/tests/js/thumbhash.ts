// The npm encoder the web app's decoder pairs with, for tests/test_thumbhash.py.
import { readFileSync } from 'node:fs';
import { rgbaToThumbHash } from 'thumbhash';

const [w, h, file] = process.argv.slice(2);
process.stdout.write(Buffer.from(rgbaToThumbHash(Number(w), Number(h), readFileSync(file))).toString('base64'));
