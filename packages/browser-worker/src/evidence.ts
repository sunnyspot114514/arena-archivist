import { createHash } from 'node:crypto';

import type { RawPageSnapshot } from '../../gray-swan-adapter/src/types.js';
import type { SanitizedEvidence } from './types.js';

export const EVIDENCE_SANITIZATION_VERSION = '1';

function redactSensitiveAttributes(html: string): string {
  let result = html.replace(
    /(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi,
    '$1/* arena-archivist: script content omitted */$2',
  );
  // Editable-control values can contain a password, OTP, pasted key, or draft. They are never
  // part of the archive evidence surface.
  result = result.replace(/<input\b[^>]*>/gi, (tag) =>
    tag.replace(/(\svalue\s*=\s*)(["'])[^"']*\2/gi, '$1$2[REDACTED]$2'),
  );
  // Keep ordinary metadata, but redact token-bearing meta values.
  result = result.replace(/<meta\b[^>]*>/gi, (tag) =>
    /(?:token|secret|cookie|session|authorization|csrf|credential)/i.test(tag)
      ? tag.replace(/(\scontent\s*=\s*)(["'])[^"']*\2/gi, '$1$2[REDACTED]$2')
      : tag,
  );
  result = result.replace(
    /(\s(?:data-)?(?:access[-_:]?token|refresh[-_:]?token|auth(?:orization)?|cookie|session|csrf|secret)\s*=\s*)(["'])[^"']*\2/gi,
    '$1$2[REDACTED]$2',
  );
  return result;
}

function redactVisibleSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:access_token|refresh_token|session_token)\s*[=:]\s*\S+/gi,
      (match) => {
        const separator = match.includes('=') ? '=' : ':';
        return `${match.split(/[=:]/, 1)[0]}${separator}[REDACTED]`;
      },
    );
}

function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) {
      if (
        /(?:token|secret|cookie|session|authorization|csrf|credential|api[-_]?key|code)/i.test(
          key,
        )
      ) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    if (
      /(?:access_token|refresh_token|session|authorization|api[-_]?key)=/i.test(
        url.hash,
      )
    ) {
      url.hash = '#[REDACTED]';
    }
    return url.href;
  } catch {
    return value;
  }
}

export function sanitizeSnapshot(snapshot: RawPageSnapshot): RawPageSnapshot {
  return {
    url: redactSensitiveUrl(snapshot.url),
    title: snapshot.title,
    html: redactSensitiveAttributes(snapshot.html),
    visibleText: redactVisibleSecrets(snapshot.visibleText),
    capturedAt: snapshot.capturedAt,
    ...(snapshot.responseStatus === undefined
      ? {}
      : { responseStatus: snapshot.responseStatus }),
  };
}

export function createSanitizedEvidence(
  snapshot: RawPageSnapshot,
): SanitizedEvidence {
  const sanitized = sanitizeSnapshot(snapshot);
  const digest = createHash('sha256')
    .update(sanitized.url)
    .update('\0')
    .update(sanitized.title)
    .update('\0')
    .update(sanitized.html)
    .update('\0')
    .update(sanitized.visibleText)
    .digest('hex');
  return {
    snapshot: sanitized,
    contentHash: `sha256:${digest}`,
    sanitizationVersion: EVIDENCE_SANITIZATION_VERSION,
  };
}
