import test from 'node:test';
import assert from 'node:assert/strict';

// Import all button style constants
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_NEUTRAL,
  BUTTON_GHOST,
  BUTTON_DANGER,
  BUTTON_PILL_BASE,
  BUTTON_ICON,
} from '../src/ui.js';

// Buttons that use text-white MUST have an explicit background color class
// to prevent invisible white text on white/transparent backgrounds.
test('buttons with text-white must have an explicit bg- class', () => {
  const namedButtons = {
    BUTTON_PRIMARY,
    BUTTON_SECONDARY,
    BUTTON_NEUTRAL,
    BUTTON_GHOST,
    BUTTON_DANGER,
    BUTTON_ICON,
  };

  for (const [name, classes] of Object.entries(namedButtons)) {
    if (classes.includes('text-white')) {
      const hasBgColor = /\bbg-(?!white\b)(?!transparent\b)\S+/.test(classes);
      assert.ok(
        hasBgColor,
        `${name} has text-white but no visible background color — text will be invisible on white containers. Classes: ${classes}`
      );
    }
  }
});

// Tailwind `text-*` covers both font size and font colour. Sizes must be
// filtered out before comparing colours, or the comparison silently reads
// `text-sm` from BUTTON_BASE and can never match a bg token.
const TEXT_SIZE_TOKENS = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
]);

export function extractColorTokens(classes) {
  const bg = [...classes.matchAll(/(?:^|\s)bg-(\S+)/g)].map((m) => m[1]);
  const text = [...classes.matchAll(/(?:^|\s)text-(\S+)/g)]
    .map((m) => m[1])
    .filter((token) => !TEXT_SIZE_TOKENS.has(token));
  return { bg, text };
}

// No button should have matching text and background color tokens
// (e.g., bg-white + text-white, or bg-surface-dim + text-surface-dim)
test('button text color must differ from its background color', () => {
  const namedButtons = {
    BUTTON_PRIMARY,
    BUTTON_SECONDARY,
    BUTTON_NEUTRAL,
    BUTTON_GHOST,
    BUTTON_DANGER,
    BUTTON_ICON,
  };

  for (const [name, classes] of Object.entries(namedButtons)) {
    const { bg, text } = extractColorTokens(classes);
    for (const textToken of text) {
      assert.equal(
        bg.includes(textToken),
        false,
        `${name} has identical bg and text color token "${textToken}" — button will be invisible. Classes: ${classes}`
      );
    }
  }
});

// Guards the comparison above: if the size filter regressed, every button's
// text token would collapse to a size like "sm" and the test would silently
// stop comparing colours at all.
test('color-token extraction ignores text sizes and finds real color tokens', () => {
  const primary = extractColorTokens(BUTTON_PRIMARY);
  assert.equal(primary.text.includes('sm'), false, 'text-sm is a size, not a color');
  assert.equal(primary.text.includes('white'), true, 'text-white must be seen as a color');
  assert.equal(primary.bg.includes('primary'), true, 'bg-primary must be seen as a color');

  // The invisible-button shape this suite exists to catch.
  const invisible = extractColorTokens('inline-flex text-sm bg-white text-white');
  assert.deepEqual(invisible.bg, ['white']);
  assert.deepEqual(invisible.text, ['white']);
});

// BUTTON_GHOST should be visible — either via border or distinct bg on hover
test('BUTTON_GHOST must be distinguishable from white backgrounds', () => {
  const hasHoverBg = BUTTON_GHOST.includes('hover:bg-');
  const hasBorder = BUTTON_GHOST.includes('border');
  assert.ok(
    hasHoverBg || hasBorder,
    'BUTTON_GHOST must include a hover:bg- or border class to be distinguishable from white containers'
  );
});
