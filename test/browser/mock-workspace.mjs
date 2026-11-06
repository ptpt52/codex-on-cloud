import { test as base, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

// Tests using relative URLs own a gateway too. Parallel workers must never
// share the demo's desktop ownership, sessions or display state.
export const test = base.extend({
  mockWorkspace: async ({}, use) => {
    const app = await fixture({ password: 'demo_password_for_tests', rfb: true });
    try { await use(app); } finally { await app.close(); }
  },
  baseURL: async ({ mockWorkspace }, use) => use(mockWorkspace.config.origin),
});
export { expect };
