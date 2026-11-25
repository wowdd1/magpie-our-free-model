import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  applyWorkbuddyIdentityPatch,
  workbuddyIdentityPatched,
  scrubClaudeCodeIdentity,
} from '../src/workbuddy-identity-patch.mjs';

// The exact BuddyAdapter system anchor, mirroring the upstream text so a shape
// change fails loudly.
const SYSTEM = `const messages = serializeMessages2(options.messages, imageUrls);
    if (options.system !== void 0 && options.system.length > 0) {
      messages.unshift({ role: "system", content: options.system });
    }`
const bundle = () => `async prepareCall() {\n    ${SYSTEM}\n  }\n`

// Two Claude Code identity constants taken verbatim from the issue (the real
// strings the Claude Code binary ships).
const CC = "You are Claude Code, Anthropic's official CLI for Claude."
const CC_SDK = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."

test('scrub neutralizes the blocked signature by comma -> period, text otherwise verbatim', () => {
  assert.equal(scrubClaudeCodeIdentity(CC), "You are Claude Code. Anthropic's official CLI for Claude.");
  // Only the load-bearing comma (between the two clauses) flips; the trailing
  // clause and its own comma survive.
  assert.equal(
    scrubClaudeCodeIdentity(CC_SDK),
    "You are Claude Code. Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  );
});

test('scrub is case-insensitive and handles the curly apostrophe', () => {
  assert.equal(
    scrubClaudeCodeIdentity("you are claude code, anthropic's official cli for claude"),
    "you are claude code. anthropic's official cli for claude",
  );
  assert.equal(
    scrubClaudeCodeIdentity('Claude Code, Anthropic’s official CLI for Claude'),
    'Claude Code. Anthropic’s official CLI for Claude',
  );
});

test('scrub leaves non-triggering system prompts untouched', () => {
  for (const safe of [
    'You are a helpful assistant.',
    'You are pi, a coding agent.',
    "You are Claude Code. Anthropic's official CLI for Claude.", // already a period
    "You are Claude Code, the official CLI for Claude.", // missing Anthropic's
  ]) {
    assert.equal(scrubClaudeCodeIdentity(safe), safe);
  }
  assert.equal(scrubClaudeCodeIdentity(undefined), undefined);
});

test('the injected runtime regex matches the exported scrub (single source of truth)', () => {
  const patched = applyWorkbuddyIdentityPatch(bundle());
  // Pull the injected replace() call out of the bundle and run it, proving the
  // code the gateway actually executes behaves like scrubClaudeCodeIdentity.
  const m = patched.match(/wbMsg\.content\.replace\((\/.*\/gi), "\$1\. \$2"\)/);
  assert.ok(m, 'injected replace() not found in patched bundle');
  const injected = new Function('text', `return text.replace(${m[1]}, "$1. $2")`);
  assert.equal(injected(CC), scrubClaudeCodeIdentity(CC));
  assert.equal(injected(CC_SDK), scrubClaudeCodeIdentity(CC_SDK));
});

test('patch inserts the scrub right after the system anchor and is idempotent', () => {
  const once = applyWorkbuddyIdentityPatch(bundle());
  assert.equal(workbuddyIdentityPatched(once), true);
  assert.ok(once.includes(`${SYSTEM}\n    if (this.product.id === "workbuddy") {`), 'scrub block misplaced relative to anchor');
  assert.equal(applyWorkbuddyIdentityPatch(once), once);
});

test('patch matches line-ending agnostic (autocrlf checkouts)', () => {
  const out = applyWorkbuddyIdentityPatch(bundle().replaceAll('\n', '\r\n'));
  assert.equal(workbuddyIdentityPatched(out), true);
  assert.ok(out.includes('\r\n'), 'inserted lines must reuse the CRLF style');
});

test('patch refuses a bundle whose anchor shape changed', () => {
  assert.throws(() => applyWorkbuddyIdentityPatch('nothing to anchor on'), /system anchor matched 0 time\(s\)/);
  assert.throws(() => applyWorkbuddyIdentityPatch(`${bundle()}\n${bundle()}`), /system anchor matched 2 time\(s\)/);
});

test('the vendored business.mjs carries the scrub after vendoring, idempotently', () => {
  const vendored = fs.readFileSync(new URL('../vendor/ofm/packages/standalone/channels/business.mjs', import.meta.url), 'utf8');
  assert.equal(workbuddyIdentityPatched(vendored), true, 'vendored bundle is missing the identity scrub; re-run scripts/vendor-ofm.mjs');
  assert.equal(applyWorkbuddyIdentityPatch(vendored), vendored, 'identity patch is not idempotent on the vendored bundle');
});
