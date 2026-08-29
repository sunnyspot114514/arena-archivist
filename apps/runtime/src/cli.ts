const baseUrl =
  process.env.ARENA_RUNTIME_URL ??
  `http://127.0.0.1:${process.env.ARENA_RUNTIME_PORT ?? '4317'}`;

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/json');
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new Error(
      'Arena Runtime is not running. Start it with: npm run runtime',
    );
  }
  const body = (await response.json()) as { code?: string; message?: string };
  if (!response.ok) {
    throw new Error(body.message ?? body.code ?? `HTTP ${response.status}`);
  }
  return body;
}

async function waitForRun(): Promise<unknown> {
  for (;;) {
    const status = (await request('/v1/status')) as {
      run?: { state?: string } | null;
    };
    if (status.run?.state !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);
  let result: unknown;
  switch (command) {
    case 'status':
      result = await request('/v1/status');
      break;
    case 'auth':
      result = await request('/v1/auth/open', { method: 'POST', body: '{}' });
      break;
    case 'validate':
      result = await request('/v1/session/validate', {
        method: 'POST',
        body: '{}',
      });
      break;
    case 'demo':
    case 'sync': {
      const requested = Number(args[0] ?? 10);
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 25) {
        throw new Error('Record count must be an integer from 1 through 25');
      }
      const source = command === 'demo' ? 'demo' : 'live';
      await request('/v1/sync', {
        method: 'POST',
        body: JSON.stringify({ maxRecords: requested, source }),
      });
      result = await waitForRun();
      break;
    }
    case 'pause':
      result = await request('/v1/pause', { method: 'POST', body: '{}' });
      break;
    case 'analyze':
      result = await request('/v1/analyze', { method: 'POST', body: '{}' });
      break;
    case 'export':
      result = await request('/v1/export', {
        method: 'POST',
        body: JSON.stringify({ format: 'analysis-pack' }),
      });
      break;
    default:
      throw new Error(
        'Unknown command. Use status, auth, validate, demo [1-25], sync [1-25], pause, analyze, or export.',
      );
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Command failed';
  process.stderr.write(`Arena command failed: ${message}\n`);
  process.exitCode = 1;
});
