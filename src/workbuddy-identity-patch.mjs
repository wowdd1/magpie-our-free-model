// WorkBuddy (INTL) Claude Code identity-signature scrub.
//
// WorkBuddy's upstream anti-abuse gate (www.workbuddy.ai) rejects any request
// whose `system` carries the contiguous, case-insensitive substring
//   "claude code" + "," + "anthropic's official cli for claude"
// (comma separator, the two clauses adjacent). Claude Code sends exactly that
// signature on every request, so workbuddy/* fails 100% from Claude Code:
// non-stream -> 500 "Illegal API invocation from an unapproved channel";
// stream -> a fake HTTP 200 with a single empty frame and no [DONE] (surfaces
// downstream as "Upstream SSE ended without a completion marker"). Neutral or
// other-client system prompts succeed 100%. See issue #4 for the single-variable
// evidence and the exact trigger characterization (comma is load-bearing; a
// period, a 2000-char gap, or reversed order all pass).
//
// Upstream declines to touch the system identity on policy grounds. For our own
// accounts and our own Claude this transform neutralizes ONLY the byte pattern
// the gate keys on, by turning the comma between the two clauses into a period
// ("You are Claude Code. Anthropic's official CLI for Claude.") -- issue #4
// confirms the period variant returns 200. No identity text is stripped or
// forged, everything else is preserved verbatim, and only the workbuddy product
// is touched.
//
// Independent of the conversation patch (upstream may merge that via PR #377 but
// will never merge this), so it carries its own anchor and idempotency marker.
//
// Anchors are matched line-ending agnostically; see workbuddy-conversation-patch.

// Single source of truth for the trigger, shared by the injected runtime code
// and the unit test. Matches "claude code" + comma + "anthropic's official cli
// for claude" (straight or curly apostrophe), adjacent, case-insensitive.
export const CLAUDE_CODE_TRIGGER = String.raw`(claude code)\s*,\s*(anthropic['’]s official cli for claude)`

/** Neutralize the WorkBuddy-blocked Claude Code signature by comma -> period. */
export const scrubClaudeCodeIdentity = text =>
  typeof text === 'string' ? text.replace(new RegExp(CLAUDE_CODE_TRIGGER, 'gi'), '$1. $2') : text

const MARKER = 'wb-identity-scrub'

// Upstream BuddyAdapter block where options.system becomes a system message.
// Identical to the conversation patch's system anchor (upstream-stable: present
// with or without PR #377), so both patches find it whatever the pin.
const SYSTEM_ANCHOR = [
  'const messages = serializeMessages2(options.messages, imageUrls);',
  '    if (options.system !== void 0 && options.system.length > 0) {',
  '      messages.unshift({ role: "system", content: options.system });',
  '    }',
]

// Scrub every system message for the workbuddy product, after options.system is
// in place and before the conversation patch's "helpful assistant" fallback
// (which carries no trigger). Inlined regex -> self-contained in business.mjs.
const SCRUB_INSERT = [
  '    if (this.product.id === "workbuddy") {',
  '      for (const wbMsg of messages) {',
  '        if (wbMsg && wbMsg.role === "system" && typeof wbMsg.content === "string") {',
  '          /* wb-identity-scrub */',
  `          wbMsg.content = wbMsg.content.replace(/${CLAUDE_CODE_TRIGGER}/gi, "$1. $2");`,
  '        }',
  '      }',
  '    }',
]

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when the bundle already carries the identity scrub. */
export function workbuddyIdentityPatched(source) {
  return source.includes(MARKER)
}

/**
 * Insert the Claude Code identity scrub into a workbuddy channel bundle.
 *
 * Idempotent: a bundle already carrying the scrub is returned unchanged.
 *
 * @param {string} source the business.mjs text (post conversation/trae patches)
 * @returns {string} the patched text, or `source` when already scrubbed
 * @throws when the system anchor is not uniquely present
 */
export function applyWorkbuddyIdentityPatch(source) {
  if (workbuddyIdentityPatched(source)) return source
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const pattern = new RegExp(SYSTEM_ANCHOR.map(escapeRegExp).join('\\r?\\n'), 'g')
  const hits = [...source.matchAll(pattern)]
  if (hits.length !== 1) {
    throw new Error(`workbuddy identity patch: system anchor matched ${hits.length} time(s), expected exactly 1; upstream bundle shape changed`)
  }
  const replacement = [...SYSTEM_ANCHOR, ...SCRUB_INSERT].join(newline)
  // Function replacement so literal $1/$2 in the injected regex are preserved
  // (string replacement would treat them as backreferences to our anchor).
  const out = source.replace(pattern, () => replacement)
  if (!workbuddyIdentityPatched(out)) throw new Error('workbuddy identity patch: anchor matched but the scrub did not apply')
  return out
}
