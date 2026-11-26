// A probe child that hangs like one stuck on a dead share: it opens the
// first known path (a FIFO no one writes) for reading, which blocks in the
// kernel, and never answers.
import { openSync } from 'node:fs';
import { join } from 'node:path';

process.once('message', (msg) => {
  openSync(join(msg.dir, msg.known[0]), 'r');
});
