// Actual managed helpers, 8 MiB TCP through TLS/WSS, certificate validation,
// isolated rule updates and panel restart recovery. Desktop remains a fixture.
process.env.FORWARD_TEST_TLS = '1';
await import('./forward-agent-native.mjs');
