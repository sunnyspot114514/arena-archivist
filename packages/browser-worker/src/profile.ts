import { basename, parse, resolve } from 'node:path';

const SHARED_BROWSER_PROFILE_PATTERNS = [
  /[\\/]google[\\/]chrome[\\/]user data(?:[\\/]|$)/i,
  /[\\/]microsoft[\\/]edge[\\/]user data(?:[\\/]|$)/i,
  /[\\/]brave-browser[\\/]user data(?:[\\/]|$)/i,
];

export function assertDedicatedProfileDirectory(
  profileDirectory: string,
): string {
  if (!profileDirectory.trim())
    throw new Error('A dedicated Chrome profile directory is required');
  const resolved = resolve(profileDirectory);
  if (resolved === parse(resolved).root)
    throw new Error('The profile directory cannot be a filesystem root');
  if (
    SHARED_BROWSER_PROFILE_PATTERNS.some((pattern) => pattern.test(resolved))
  ) {
    throw new Error(
      'Refusing to use a normal Chrome/Edge/Brave user-data directory',
    );
  }
  if (/^(?:default|profile \d+)$/i.test(basename(resolved))) {
    throw new Error('Refusing to use a normal browser profile name');
  }
  return resolved;
}
