/**
 * The naming rules are the only real logic in the build, and they are what
 * decide the public URL of every photograph. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { resolveMeta, slugify, titleize } from './build.mjs';
import { PROVIDERS, normalizePhoto, parseJson, pickProvider, pickProviders, reconcileShow } from './curate.mjs';

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

// --- Reading free models' JSON ---------------------------------------------
// Free models are chatty and fond of code fences. The parser has to cope.
{
  const want = { title: 'Night Flower', tags: ['night'] };
  const wrappings = [
    JSON.stringify(want),
    'Sure! Here is the JSON:\n```json\n' + JSON.stringify(want) + '\n```\nHope that helps.',
    '```\n' + JSON.stringify(want) + '\n```',
    'Thinking... ' + JSON.stringify(want) + ' and that is my answer. {"trailing": "junk"}',
  ];
  for (const w of wrappings) assert.deepEqual(parseJson(w), want, w.slice(0, 30));

  // Braces inside strings must not end the object early.
  assert.deepEqual(parseJson('{"caption": "a } brace, and a \\" quote"}').caption, 'a } brace, and a " quote');

  for (const bad of ['no json here', '{"unclosed": ']) {
    assert.throws(() => parseJson(bad), /JSON/, bad);
  }
  console.log('ok — 7 loose-JSON cases');
}

// --- Coercing whatever the model returned ----------------------------------
{
  const good = normalizePhoto({
    title: '  Night   Flower ', caption: 'x'.repeat(400), alt: 'An alt',
    tags: ['Night', 'NIGHT', ' river ', '', 'a'.repeat(50), ...Array(20).fill('t').map((t, i) => t + i)],
    mood: 'Quiet And Still',
  }, 'Fallback');
  assert.equal(good.title, 'Night Flower', 'whitespace collapsed');
  assert.equal(good.caption.length, 140, 'caption clamped');
  assert.equal(good.mood, 'quiet', 'mood reduced to one lowercase word');
  assert.equal(good.tags.length, 12, 'tags capped');
  assert.deepEqual(good.tags.slice(0, 2), ['night', 'river'], 'tags lowercased and de-duplicated');

  // Garbage in, renderable out — every field still has the right type.
  for (const junk of [null, {}, { title: 42, tags: 'not-an-array', mood: null }, []]) {
    const n = normalizePhoto(junk, 'Fallback');
    assert.equal(n.title, 'Fallback');
    assert.equal(n.alt, 'Fallback', 'alt falls back to the title, never empty');
    assert.equal(typeof n.caption, 'string');
    assert.ok(Array.isArray(n.tags));
    assert.equal(typeof n.mood, 'string');
  }
  console.log('ok — 9 normalisation cases');
}

// --- Picking a provider ----------------------------------------------------
{
  assert.equal(pickProvider({}), null, 'no key means no curation, not a crash');
  assert.equal(pickProvider({ GROQ_API_KEY: 'k' }).label, 'Groq');
  assert.equal(pickProvider({ OPENROUTER_API_KEY: 'k' }).label, 'OpenRouter');
  assert.equal(pickProvider({ GROQ_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }).label, 'Groq', 'first listed wins');
  assert.equal(pickProvider({ OPENROUTER_API_KEY: 'k', GALIYAARA_AI_MODEL: 'mine' }).model, 'mine');
  assert.equal(pickProvider({ GALIYAARA_AI_BASE_URL: 'https://x.dev/v1/', GALIYAARA_AI_KEY: 'k' }).base, 'https://x.dev/v1', 'trailing slash trimmed');
  assert.equal(PROVIDERS.opencodezen.vision, false, 'zen free models cannot see');
  assert.throws(() => pickProvider({ GALIYAARA_AI_PROVIDER: 'nope' }), /unknown/);
  assert.throws(() => pickProvider({ GALIYAARA_AI_PROVIDER: 'groq' }), /GROQ_API_KEY is not set/);
  console.log('ok — 9 provider-selection cases');
}

// --- Falling back between free tiers ---------------------------------------
// One free allowance will not cover a whole collection, so several keys chain.
{
  assert.deepEqual(pickProviders({}), [], 'no keys, no providers');

  const both = pickProviders({ GROQ_API_KEY: 'a', OPENROUTER_API_KEY: 'b' });
  assert.deepEqual(both.map((p) => p.label), ['Groq', 'OpenRouter'], 'tried in declared order');
  assert.deepEqual(both.map((p) => p.key), ['a', 'b'], 'each carries its own key');

  const all3 = pickProviders({ GROQ_API_KEY: 'a', OPENROUTER_API_KEY: 'b', OPENCODE_API_KEY: 'c' });
  assert.equal(all3.length, 3);
  assert.deepEqual(all3.filter((p) => p.vision).map((p) => p.label), ['Groq', 'OpenRouter'],
    'only the ones that can see get the per-photograph pass');

  // A model override belongs to the provider it was chosen for, not to a
  // fallback running on a different service.
  const over = pickProviders({ GROQ_API_KEY: 'a', OPENROUTER_API_KEY: 'b', GALIYAARA_AI_MODEL: 'mine' });
  assert.equal(over[0].model, 'mine');
  assert.equal(over[1].model, PROVIDERS.openrouter.model, 'fallback keeps its own default model');

  // Naming a provider means that one only — no silent hop to another service.
  const named = pickProviders({ GALIYAARA_AI_PROVIDER: 'openrouter', GROQ_API_KEY: 'a', OPENROUTER_API_KEY: 'b' });
  assert.deepEqual(named.map((p) => p.label), ['OpenRouter']);

  // pickProvider stays the "who goes first" answer.
  assert.equal(pickProvider({ OPENROUTER_API_KEY: 'b' }).label, 'OpenRouter');
  assert.equal(pickProvider({}), null);

  console.log('ok — 9 provider-fallback cases');
}
