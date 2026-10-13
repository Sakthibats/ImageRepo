#!/usr/bin/env node
// The CLI is TypeScript run directly, with no build step. Node cannot import
// .ts on its own, so this launcher registers tsx's loader first.
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
