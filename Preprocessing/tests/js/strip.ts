// The CLI's stripper, for tests/test_strip.py to compare against.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripMetadata } from '../../../packages/ingest/src/strip.ts';

const [ext, input, output] = process.argv.slice(2);
writeFileSync(output, stripMetadata(readFileSync(input), ext).buffer);
