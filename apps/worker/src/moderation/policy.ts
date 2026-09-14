import { BANNED_WORDS } from './banned-words.js';
import type { ModerationInput, ModerationPolicy, Verdict } from './policy.types.js';

const URL_PATTERN = /https?:\/\/\S+/gi;
const REPEATED_CHAR_PATTERN = /(.)\1{4,}/;
const CAPS_MIN_LENGTH = 40;
const CAPS_UPPERCASE_RATIO = 0.6;
const MAX_PLAIN_URLS = 2;
const MAX_URL_TOKEN_RATIO = 0.2;

function containsBannedWord(text: string): boolean {
  return BANNED_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

function hasTooManyLinks(body: string): boolean {
  const urls = body.match(URL_PATTERN) ?? [];
  if (urls.length === 0) return false;

  const tokens = body.trim().split(/\s+/).filter(Boolean);
  const ratio = tokens.length === 0 ? 0 : urls.length / tokens.length;

  return urls.length > MAX_PLAIN_URLS || ratio > MAX_URL_TOKEN_RATIO;
}

// Ignores short texts and measures letters only, so acronym-heavy but
// otherwise ordinary reviews (e.g. mentioning USB-C or MBP) are not
// mistaken for shouting.
function isShouting(body: string): boolean {
  if (body.length <= CAPS_MIN_LENGTH) return false;

  const letters = body.match(/[A-Za-z]/g) ?? [];
  if (letters.length === 0) return false;

  const uppercaseCount = letters.filter((letter) => letter >= 'A' && letter <= 'Z').length;
  return uppercaseCount / letters.length > CAPS_UPPERCASE_RATIO;
}

function hasRepeatedCharacterRun(body: string): boolean {
  return REPEATED_CHAR_PATTERN.test(body);
}

function isDuplicateOfPrevious(body: string, previousBodies: readonly string[]): boolean {
  return previousBodies.includes(body);
}

class DefaultModerationPolicy implements ModerationPolicy {
  classify(input: ModerationInput): Verdict {
    const titleAndBody = `${input.title} ${input.body}`;

    // Reject-level rules: decisive and never downgraded by verifiedPurchase.
    if (containsBannedWord(titleAndBody)) {
      return { decision: 'REJECTED', reason: 'Review contains banned language.' };
    }

    if (hasTooManyLinks(input.body)) {
      return { decision: 'REJECTED', reason: 'Review is mostly links.' };
    }

    // Flag-level rules: borderline signals that a verified purchase can
    // downgrade to an approval, but that never rescue a rejection above.
    let flagReason: string | null = null;
    if (isShouting(input.body)) {
      flagReason = 'Review appears to be shouting (excessive uppercase).';
    } else if (hasRepeatedCharacterRun(input.body)) {
      flagReason = 'Review contains unusually long repeated character runs.';
    } else if (isDuplicateOfPrevious(input.body, input.authorPreviousBodies)) {
      flagReason = 'Review duplicates a previous review from this author.';
    }

    if (flagReason === null) {
      return { decision: 'APPROVED', reason: null };
    }

    if (input.verifiedPurchase) {
      return { decision: 'APPROVED', reason: null };
    }

    return { decision: 'FLAGGED', reason: flagReason };
  }
}

export const defaultPolicy: ModerationPolicy = new DefaultModerationPolicy();
