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
    const bgMatch = classes.match(/\bbg-(\S+)/);
    const textMatch = classes.match(/\btext-(\S+)/);
    if (bgMatch && textMatch) {
      const bgToken = bgMatch[1];
      const textToken = textMatch[1];
      assert.notEqual(
        bgToken,
        textToken,
        `${name} has identical bg and text color token "${bgToken}" — button will be invisible`
      );
    }
  }
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
