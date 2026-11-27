// A file helper for the FileGate tests. It takes `{ id, op }` requests on its
// IPC channel and answers by a script in the op's path (`from` for a rename):
//   hang     never answers
//   slow:N   sends N progress messages 1 s apart, then answers with the path
//   eio      answers { ok: false, code: 'EIO' }
//   enoent   answers { ok: false, code: 'ENOENT' }
//   anything else answers { ok: true, value: path }
process.on('message', (msg) => {
  const { id, op } = msg;
  const script = String(op.path ?? op.from ?? '');
  if (script === 'hang') return;
  if (script === 'eio') return process.send({ id, ok: false, code: 'EIO', message: 'i/o error' });
  if (script === 'enoent') return process.send({ id, ok: false, code: 'ENOENT', message: 'no such file' });
  const slow = /^slow:(\d+)$/.exec(script);
  if (slow) {
    let left = Number(slow[1]);
    const tick = () => {
      if (left === 0) return process.send({ id, ok: true, value: script });
      left -= 1;
      process.send({ id, progress: true });
      setTimeout(tick, 1_000);
    };
    return void setTimeout(tick, 1_000);
  }
  process.send({ id, ok: true, value: script });
});
// The gate let go of us: leave.
process.once('disconnect', () => process.exit(0));
