/**
 * The naming rules are the only real logic in the build, and they are what
 * decide the public URL of every photograph. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { slugify, titleize } from './build.mjs';

const cases = [
  ['night flower.jpg', 'night-flower', 'Night Flower'],
  ['The_Three_Musketeers.jpeg', 'the-three-musketeers', 'The Three Musketeers'],
  ['civilization...?.jpg', 'civilization', 'Civilization'],
  ['bye bye.jpg', 'bye-bye', 'Bye Bye'],
  ['Face_It.jpeg', 'face-it', 'Face It'],          // not "Face IT"
  ['gods_work.jpg', 'gods-work', 'Gods Work'],
  ['  spaced   out .PNG', 'spaced-out', 'Spaced Out'],
  ['2024-06-01 19.42.10.jpg', '2024-06-01-19-42-10', '2024 06 01 19 42 10'],
];

for (const [file, slug, title] of cases) {
  assert.equal(slugify(file), slug, file);
  assert.equal(titleize(slug), title, file);
}

// Slugs are URLs: no spaces, no punctuation, never empty for a real filename.
for (const [file] of cases) assert.match(slugify(file), /^[a-z0-9][a-z0-9-]*$/);

console.log(`ok — ${cases.length} filename cases`);
