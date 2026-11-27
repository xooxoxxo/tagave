// A file helper for the FileGate tests. It takes `{ id, op }` requests on its
// IPC channel and answers by a script in the op's path (`from` for a rename):
//   hang     never answers
//   stuck    never answers, and stays after the gate lets go (no exit on
//            disconnect): with the gate's `kill` a no-op, it stands in for a
//            helper stuck in the kernel until the test kills it
//   slow:N   sends N progress messages 1 s apart, then answers with the path
//   eio      answers { ok: false, code: 'EIO' }
//   enoent   answers { ok: false, code: 'ENOENT' }
//   anything else answers { ok: true, value: path }, or for readdirPage a
//   one-entry page { entries: [{ name: path, type: 'file' }], cursor: null }
let stay = false;
process.on('message', (msg) => {
  const { id, op } = msg;
  const script = String(op.path ?? op.from ?? '');
  if (script === 'hang') return;
  if (script === 'stuck') {
    stay = true;
    setInterval(() => undefined, 60_000); // alive with no channel, until killed
    return;
  }
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
  if (op.op === 'readdirPage') return process.send({ id, ok: true, value: { entries: [{ name: script, type: 'file' }], cursor: null } });
  process.send({ id, ok: true, value: script });
});
// The gate let go of us: leave.
process.once('disconnect', () => {
  if (!stay) process.exit(0);
});
