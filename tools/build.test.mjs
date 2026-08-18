/**
 * The naming rules are the only real logic in the build, and they are what
 * decide the public URL of every photograph. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { resolveMeta, slugify, titleize } from './build.mjs';
import { reconcileShow } from './curate.mjs';

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

// --- Where a photograph's words come from ----------------------------------
// The photographer must always be able to override the AI, and the site must
// still work when there is no AI output at all.
{
  const ai = {
    photos: {
      'night-flower': { title: 'Raat Ki Rani', caption: 'AI caption', alt: 'AI alt', tags: ['night'], mood: 'quiet' },
    },
  };
  const hand = { 'night flower.jpg': { title: 'By Hand', caption: 'Hand caption' } };

  // 1. Hand-written wins over the curator, field by field.
  const a = resolveMeta('night-flower', 'night flower.jpg', hand, ai);
  assert.equal(a.title, 'By Hand');
  assert.equal(a.caption, 'Hand caption');
  assert.equal(a.alt, 'AI alt', 'a field the photographer left alone still comes from the curator');
  assert.equal(a.curated, false, 'not counted as curated once a human has titled it');

  // 2. Curator fills in when there is no hand-written entry.
  const b = resolveMeta('night-flower', 'night flower.jpg', {}, ai);
  assert.deepEqual([b.title, b.caption, b.alt, b.mood, b.curated], ['Raat Ki Rani', 'AI caption', 'AI alt', 'quiet', true]);

  // 3. No curation at all: the filename still yields a usable title and alt.
  const c = resolveMeta('night-flower', 'night flower.jpg', {}, {});
  assert.deepEqual([c.title, c.caption, c.alt, c.tags, c.curated], ['Night Flower', '', 'Night Flower', [], false]);

  // 4. An empty caption written by hand suppresses the AI one rather than
  //    falling through to it.
  const d = resolveMeta('night-flower', 'night flower.jpg', { 'night-flower': { caption: '' } }, ai);
  assert.equal(d.caption, '');

  console.log('ok — 4 metadata precedence cases');
}

// --- Surviving a bad answer from the model ---------------------------------
// The curator is an LLM, so treat its output as untrusted input.
{
  const slugs = ['a', 'b', 'c', 'd', 'e'];
  const out = reconcileShow({
    hang: ['c', 'ghost', 'a', 'c'],          // invented slug, duplicate, and 'b','d','e' missing
    walks: [
      { id: 'w1', title: 'Real', blurb: 'x', slugs: ['a', 'b', 'ghost', 'c'] },
      { id: 'w2', title: 'Too short', blurb: 'x', slugs: ['a', 'ghost'] },
      { title: 'No id', blurb: 'x', slugs: ['a', 'b', 'c'] },
    ],
  }, slugs);

  assert.deepEqual(out.hang, ['c', 'a', 'b', 'd', 'e'], 'invented slugs dropped, forgotten ones appended, order otherwise kept');
  assert.equal(out.hang.length, slugs.length, 'no photograph may vanish from the corridor');
  assert.equal(out.walks.length, 1, 'walks that are too short or unidentified are dropped');
  assert.deepEqual(out.walks[0].slugs, ['a', 'b', 'c']);

  // Total garbage still yields a hangable show rather than an empty gallery.
  const empty = reconcileShow({}, slugs);
  assert.deepEqual(empty.hang, slugs);
  assert.deepEqual(empty.walks, []);

  console.log('ok — 6 untrusted-curation cases');
}
