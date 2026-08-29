import { describe, expect, it } from 'vitest';

import { resolveBrowserLaunchTarget } from '../src/browser-launch';

describe('Windows default browser resolution', () => {
  it('maps the registered Edge default to Playwright official channel', async () => {
    const edge =
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const target = await resolveBrowserLaunchTarget({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      queryRegistry: async (_key, valueName) =>
        valueName === 'ProgId' ? 'MSEdgeHTM' : null,
      fileExists: async (path) => path === edge,
    });

    expect(target).toEqual({
      browserName: 'Microsoft Edge',
      channel: 'msedge',
      executablePath: edge,
      profileKey: 'edge',
      source: 'windows-default',
    });
  });

  it('falls back to another official browser when the registered binary is missing', async () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const target = await resolveBrowserLaunchTarget({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      queryRegistry: async () => 'MSEdgeHTM',
      fileExists: async (path) => path === chrome,
    });

    expect(target).toEqual({
      browserName: 'Google Chrome',
      channel: 'chrome',
      executablePath: chrome,
      profileKey: 'chrome',
      source: 'windows-fallback',
    });
  });

  it('maps the registered Chrome default to Playwright official channel', async () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const target = await resolveBrowserLaunchTarget({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      queryRegistry: async () => 'ChromeHTML',
      fileExists: async (path) => path === chrome,
    });

    expect(target).toEqual({
      browserName: 'Google Chrome',
      channel: 'chrome',
      executablePath: chrome,
      profileKey: 'chrome',
      source: 'windows-default',
    });
  });

  it('falls back to the official Edge channel when the default is unsupported', async () => {
    const edge =
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const target = await resolveBrowserLaunchTarget({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      queryRegistry: async () => 'FirefoxURL',
      fileExists: async (path) => path === edge,
    });

    expect(target).toEqual({
      browserName: 'Microsoft Edge',
      channel: 'msedge',
      executablePath: edge,
      profileKey: 'edge',
      source: 'windows-fallback',
    });
  });
});
