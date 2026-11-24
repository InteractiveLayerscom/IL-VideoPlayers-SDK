import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneFontFamily } from '../web/scene.mjs';

// The same cases as the Android unit test (OverlayFontsTest.asksForMontserrat).
test('a scene layer gets the SDK font first only when it asks for Montserrat first', () => {
  const face = "'IL Montserrat', ";
  for (const value of ['Montserrat', 'montserrat, Inter, system-ui, sans-serif', "'Montserrat', sans-serif", ' "Montserrat" '])
    assert.equal(sceneFontFamily(value), face + value);
  for (const value of ['Inter, Montserrat', 'Montserrat Alternates', '', 'Georgia, serif'])
    assert.equal(sceneFontFamily(value), value);
  assert.equal(sceneFontFamily(null), '');
  assert.equal(sceneFontFamily(undefined), '');
  assert.equal(sceneFontFamily(12), '');
});
