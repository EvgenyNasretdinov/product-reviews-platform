/**
 * A small, deliberately illustrative list of banned words.
 *
 * A real deployment would rely on a maintained block list or an external
 * moderation API/model, not a hardcoded array. This list exists only to
 * make the event pipeline demonstrable end to end; it is not, and is not
 * meant to be, a content-safety product.
 */
export const BANNED_WORDS: readonly string[] = ['damn', 'hell', 'crap', 'bullshit'];
