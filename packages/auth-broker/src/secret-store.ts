import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type SecretStoreKind = 'windows_dpapi' | 'memory';

export interface SecretStore {
  readonly kind: SecretStoreKind;
  has(connectionId: string): Promise<boolean>;
  read(connectionId: string): Promise<string | null>;
  write(connectionId: string, secret: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

function assertConnectionId(connectionId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(connectionId)) {
    throw new Error('Invalid credential connection ID');
  }
}

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plainText = [Console]::In.ReadToEnd()
$plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
$entropy = [Text.Encoding]::UTF8.GetBytes('ArenaArchivist:v1')
$cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
  $plainBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($cipherBytes))
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$cipherBytes = [Convert]::FromBase64String($encoded)
$entropy = [Text.Encoding]::UTF8.GetBytes('ArenaArchivist:v1')
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipherBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
`;

async function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error('Windows credential encryption timed out'));
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024 && !settled) {
        settled = true;
        child.kill();
        clearTimeout(timeout);
        rejectPromise(
          new Error('Windows credential encryption returned too much data'),
        );
      }
    });
    child.stderr.resume();
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new Error('Windows credential encryption is unavailable'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error('Windows credential encryption failed'));
        return;
      }
      resolvePromise(stdout);
    });
    child.stdin.end(input, 'utf8');
  });
}

export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  readonly #values = new Map<string, string>();

  async has(connectionId: string): Promise<boolean> {
    assertConnectionId(connectionId);
    return this.#values.has(connectionId);
  }

  async read(connectionId: string): Promise<string | null> {
    assertConnectionId(connectionId);
    return this.#values.get(connectionId) ?? null;
  }

  async write(connectionId: string, secret: string): Promise<void> {
    assertConnectionId(connectionId);
    this.#values.set(connectionId, secret);
  }

  async delete(connectionId: string): Promise<void> {
    assertConnectionId(connectionId);
    this.#values.delete(connectionId);
  }
}

export class WindowsDpapiSecretStore implements SecretStore {
  readonly kind = 'windows_dpapi' as const;
  readonly #directory: string;

  constructor(directory: string) {
    if (process.platform !== 'win32') {
      throw new Error('Windows DPAPI credential storage requires Windows');
    }
    this.#directory = resolve(directory);
  }

  async has(connectionId: string): Promise<boolean> {
    try {
      await readFile(this.#path(connectionId), 'utf8');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error('Unable to inspect the encrypted credential store');
    }
  }

  async read(connectionId: string): Promise<string | null> {
    let encoded: string;
    try {
      encoded = await readFile(this.#path(connectionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Unable to read the encrypted credential store');
    }
    return runPowerShell(UNPROTECT_SCRIPT, encoded.trim());
  }

  async write(connectionId: string, secret: string): Promise<void> {
    const path = this.#path(connectionId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const encoded = await runPowerShell(PROTECT_SCRIPT, secret);
    await mkdir(this.#directory, { recursive: true });
    await writeFile(temporary, encoded, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await rename(temporary, path);
    } catch (error) {
      if (
        !['EEXIST', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        await rm(temporary, { force: true });
        throw new Error('Unable to save the encrypted credential');
      }
      await rm(path, { force: true });
      await rename(temporary, path);
    }
  }

  async delete(connectionId: string): Promise<void> {
    await rm(this.#path(connectionId), { force: true });
  }

  #path(connectionId: string): string {
    assertConnectionId(connectionId);
    return resolve(this.#directory, `${connectionId}.dpapi`);
  }
}

export function createLocalSecretStore(directory: string): SecretStore {
  return process.platform === 'win32'
    ? new WindowsDpapiSecretStore(directory)
    : new MemorySecretStore();
}
