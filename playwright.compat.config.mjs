import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.mjs';

const launch = name => process.env[name] ? { executablePath: process.env[name] } : {};
export default defineConfig({
  ...base,
  testMatch: ['compatibility.spec.mjs', 'reverse-forward.spec.mjs', 'direct-panel.spec.mjs', 'relay-switch.spec.mjs', 'browser-preferences.spec.mjs', 'forward-hints.spec.mjs', 'service-rtc.spec.mjs', 'service-files.spec.mjs', 'latency.spec.mjs'],
  outputDir: 'test-results/compatibility',
  use: { ...base.use, launchOptions: {}, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, launchOptions: launch('CHROME_PATH') } },
    { name: 'chromium-phone', use: { ...devices['Pixel 7'], browserName: 'chromium', launchOptions: launch('CHROME_PATH') } },
    { name: 'chromium-tablet', use: { browserName: 'chromium', viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true, launchOptions: launch('CHROME_PATH') } },
    // The isolated WebRTC fixture binds loopback, which Firefox excludes by
    // default. This changes only the test browser, not deployed ICE policy.
    { name: 'firefox-desktop', use: { browserName: 'firefox', viewport: { width: 1440, height: 900 }, launchOptions: { ...launch('FIREFOX_PATH'), firefoxUserPrefs: { 'media.peerconnection.ice.loopback': true } } } },
    { name: 'webkit-desktop', use: { browserName: 'webkit', viewport: { width: 1440, height: 900 }, launchOptions: launch('WEBKIT_PATH') } },
    { name: 'webkit-phone', use: { ...devices['iPhone 13'], browserName: 'webkit', launchOptions: launch('WEBKIT_PATH') } },
    { name: 'webkit-tablet', use: { ...devices['iPad Pro 11'], browserName: 'webkit', launchOptions: launch('WEBKIT_PATH') } },
  ],
});
