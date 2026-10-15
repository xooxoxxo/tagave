#!/usr/bin/env node
/**
 * `liner-doctor`: the pre-0.9 name of `tagave-doctor`, kept as an alias until
 * 0.10. It says so on stderr (stdout stays the command's own output, which
 * scripts parse), then runs the same CLI.
 */
console.error('liner-doctor is now tagave-doctor; the old name stops working in tagave 0.10.');
await import('./cli.js');
