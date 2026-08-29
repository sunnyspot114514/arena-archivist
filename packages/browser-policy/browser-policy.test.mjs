import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserGuardian,
  MemoryPolicyAuditSink,
  PolicyDeniedError,
} from './index.ts';

function guardian(overrides = {}) {
  return new BrowserGuardian({
    collectOrigins: ['https://app.grayswan.ai'],
    staticOrigins: ['https://static.grayswan.ai'],
    authOrigins: ['https://app.grayswan.ai', 'https://accounts.google.com'],
    graphQlEndpoints: [
      { origin: 'https://app.grayswan.ai', pathname: '/graphql' },
    ],
    ...overrides,
  });
}

test('semantic policy exposes only the six read-only actions', () => {
  const policy = guardian();
  assert.equal(
    policy.assertSemantic({ action: 'read_visible_record' }).allowed,
    true,
  );
  for (const action of [
    'send_message',
    'fill_attack_prompt',
    'submit_break',
    'delete_chat',
    'click',
  ]) {
    assert.throws(() => policy.assertSemantic({ action }), PolicyDeniedError);
  }
});

test('AUTH_MODE is human-only and uses an exact auth-origin allowlist', () => {
  const policy = guardian({ mode: 'AUTH_MODE' });
  assert.equal(
    policy.assertDom({
      action: 'fill',
      actor: 'human',
      pageUrl: 'https://accounts.google.com/signin',
    }).allowed,
    true,
  );
  assert.throws(
    () =>
      policy.assertDom({
        action: 'fill',
        actor: 'worker',
        pageUrl: 'https://accounts.google.com/signin',
      }),
    PolicyDeniedError,
  );
  assert.throws(
    () =>
      policy.assertNetwork({
        method: 'GET',
        actor: 'human',
        url: 'https://evil.example/signin',
      }),
    PolicyDeniedError,
  );
});

test('DOM policy denies raw writes, Enter, unknown clicks, dangerous labels, and external destinations', () => {
  const policy = guardian();
  const pageUrl = 'https://app.grayswan.ai/arena/history';

  for (const request of [
    { action: 'fill', pageUrl },
    { action: 'press', key: 'Enter', pageUrl },
    { action: 'upload', pageUrl },
    { action: 'evaluate', pageUrl },
    { action: 'click', pageUrl, intent: 'read_visible_record' },
    {
      action: 'click',
      pageUrl,
      intent: 'read_visible_record',
      target: { role: 'button', accessibleName: 'Submit Break' },
    },
    {
      action: 'click',
      pageUrl,
      intent: 'read_visible_record',
      target: {
        role: 'link',
        accessibleName: 'Record',
        href: 'https://evil.example/record',
      },
    },
  ]) {
    assert.equal(policy.evaluateDom(request).allowed, false);
  }

  assert.equal(
    policy.assertDom({
      action: 'click',
      pageUrl,
      intent: 'navigate_pagination',
      target: {
        role: 'link',
        accessibleName: 'Next page',
        href: 'https://app.grayswan.ai/arena/history?page=2',
      },
    }).allowed,
    true,
  );
});

test('network policy permits safe reads and denies unknown origins, uploads, and writes', () => {
  const policy = guardian();
  assert.equal(
    policy.assertNetwork({
      method: 'GET',
      url: 'https://app.grayswan.ai/api/history',
    }).allowed,
    true,
  );
  assert.equal(
    policy.assertNetwork({
      method: 'GET',
      url: 'https://static.grayswan.ai/app.css',
    }).allowed,
    true,
  );
  for (const request of [
    { method: 'GET', url: 'https://evil.example/collect' },
    { method: 'POST', url: 'https://app.grayswan.ai/api/submit', body: '{}' },
    { method: 'DELETE', url: 'https://app.grayswan.ai/api/chat/1' },
    { method: 'GET', url: 'https://app.grayswan.ai/api/delete/1' },
    {
      method: 'GET',
      url: 'https://app.grayswan.ai/api/history',
      headers: { 'x-http-method-override': 'DELETE' },
    },
    {
      method: 'POST',
      url: 'https://app.grayswan.ai/api/file',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    },
  ]) {
    assert.equal(policy.evaluateNetwork(request).allowed, false);
  }
});

test('GraphQL POST is allowed only when every operation is proven read-only', () => {
  const policy = guardian();
  assert.equal(
    policy.assertNetwork({
      method: 'POST',
      url: 'https://app.grayswan.ai/graphql',
      body: JSON.stringify({ query: 'query Archive { previousChats { id } }' }),
    }).allowed,
    true,
  );
  assert.equal(
    policy.assertNetwork({
      method: 'POST',
      url: 'https://app.grayswan.ai/graphql',
      body: {
        query: 'query Archive { record(note: "mutation is only text") { id } }',
      },
    }).allowed,
    true,
  );
  for (const body of [
    { query: 'mutation Submit { submitBreak { id } }' },
    { query: 'subscription Events { event { id } }' },
    { extensions: { persistedQuery: { sha256Hash: 'a'.repeat(64) } } },
    'not-json',
  ]) {
    assert.equal(
      policy.evaluateNetwork({
        method: 'POST',
        url: 'https://app.grayswan.ai/graphql',
        body,
      }).allowed,
      false,
    );
  }
  assert.equal(
    policy.evaluateNetwork({
      method: 'GET',
      url: `https://app.grayswan.ai/%67raphql?query=${encodeURIComponent(
        'mutation Submit { submitBreak { id } }',
      )}`,
    }).allowed,
    false,
  );
});

test('an audit write failure converts an otherwise allowed action into a denial', () => {
  const policy = guardian({
    auditSink: {
      write() {
        throw new Error('audit disk unavailable');
      },
    },
  });
  const decision = policy.evaluateSemantic({ action: 'read_visible_record' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'POLICY_AUDIT_FAILED');
});

test('audit records contain policy summaries but never request bodies', () => {
  const audit = new MemoryPolicyAuditSink();
  const policy = guardian({ auditSink: audit });
  const secret = 'never-log-this-body';
  policy.evaluateNetwork({
    method: 'POST',
    url: 'https://app.grayswan.ai/api/submit',
    body: secret,
  });
  assert.equal(audit.decisions.length, 1);
  assert.equal(JSON.stringify(audit.decisions).includes(secret), false);
});
