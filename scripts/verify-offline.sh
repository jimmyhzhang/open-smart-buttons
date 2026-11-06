#!/bin/sh
# macOS verification with external outbound connections denied for the test process tree.
set -eu
cd "$(dirname "$0")/.."
policy='(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))'
/usr/bin/sandbox-exec -p "$policy" node --input-type=module <<'NODE'
import { connect } from 'node:net';
const socket = connect(443, '192.0.2.1');
socket.setTimeout(1500, () => {
  socket.destroy();
  process.exitCode = 1;
});
socket.on('error', (error) => {
  if (!['EPERM', 'EACCES'].includes(error.code)) process.exitCode = 1;
  else console.log('Verified non-loopback connections are denied');
});
NODE
exec /usr/bin/sandbox-exec -p "$policy" npm run verify
