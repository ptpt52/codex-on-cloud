// Actual Go/Pion and data sockets through a full node path; no production FRP.
process.env.FORWARD_TEST_ENTRY = '/node/entry-test/';
await import('./forward-agent-native.mjs');
