/**
 * The naming rules are the only real logic in the build, and they are what
 * decide the public URL of every photograph. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// --- The headset paths -----------------------------------------------------
// None of this can be exercised without a headset, so what is checked here is
// the handful of single lines whose absence silently breaks AR or VR. Each one
// was a real bug once; a grep is a poor test but it is the only one that runs
// on a laptop, and it fails loudly if the line goes missing again.
{
  const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
  const [gallery, xr, main, html, css] = ['js/gallery.js', 'js/xr.js', 'js/main.js', 'index.html', 'css/site.css'].map(read);

  // three derives its clear alpha from this: without it the AR framebuffer is
  // cleared opaque and the passthrough camera is buried under black.
  assert.match(gallery, /new THREE\.WebGLRenderer\(\{[^}]*\balpha:\s*true/, 'the renderer must ask for alpha or AR shows nothing');

  // The camera hangs off the rig, so every headset pose is multiplied by the
  // rig's corridor position. AR has to park it at the origin or the hit-test
  // reticle and the print end up wherever the visitor last walked to.
  assert.match(xr, /rigWas\.pos\.copy\(rig\.position\)[\s\S]{0,200}rig\.position\.set\(0, 0, 0\)/, 'AR must park the rig at the origin');
  assert.match(xr, /rig\.position\.copy\(rigWas\.pos\)/, 'and give the corridor its walker back on exit');

  // requestSession needs the tap to still be warm; awaiting a 2 MP texture
  // first spends that activation and the session is refused.
  assert.doesNotMatch(main, /await gallery\.loadTexture/, 'the print must not be awaited before the session is requested');

  // #hud is display:none inside a session, so the one caption that has to be
  // readable in AR cannot live inside it.
  const hud = html.slice(html.indexOf('<div id="hud"'), html.indexOf('<aside id="plate"'));
  assert.ok(!hud.includes('id="ar-hint"'), '#ar-hint must sit outside #hud, which AR hides');
  assert.ok(html.includes('id="ar-hint"'), '...but must still exist');
  assert.match(css, /#ar-hint \{[^}]*pointer-events: none/, 'the hint must not swallow the tap that hangs the print');

  // Aiming the trigger at a frame in VR has to actually walk you up to it.
  assert.match(gallery, /if \(xrMove\?\.\(dt, frame\)\) dock\.active = false;/, 'VR locomotion must cancel a dock glide');
  assert.match(gallery, /dock\.active && renderScene === scene/, 'VR must glide to a docked frame, and AR must never dock');

  // A tap must hang a print whether or not a plane was ever detected, and
  // whether or not the 2 MP texture beat the tap.
  assert.match(xr, /if \(!pendingPrint\?\.texture\) \{ wantsPlace = true; return; \}/, 'an early tap must be latched, not swallowed');
  assert.match(xr, /if \(wantsPlace\) placePrint\(\)/, 'and honoured once the print lands');
  assert.match(xr, /onSurface \? ar\.reticle\.matrix : null/, 'no detected wall must still place the print');

  // Hit-testing must be an enhancement. Unhandled, its rejection also skipped
  // the 'select' listener below it — session alive, nothing placeable, ever.
  assert.match(xr, /async function startAR\(\) \{\s*try \{/, 'startAR must not be able to reject');
  assert.match(xr, /if \(!found\) aimFree\(\);[\s\S]{0,400}ar\.reticle\.visible = true;/,
    'the reticle must show even with no surface — an invisible ring is why a live session looked dead');
  assert.doesNotMatch(xr, /ar\.reticle\.visible = false;\s*return;/, 'zero hits must not blank the reticle');
  assert.match(xr, /print\.rotation\.order = 'YXZ'/, 'YXZ or prints off eye level hang crooked');

  // Neither headset mode available must say so rather than grow no buttons.
  assert.ok(html.includes('id="xr-note"'), 'there must be somewhere to explain a missing headset mode');
  assert.match(main, /if \(!vr && !ar\) \{[\s\S]{0,400}note\.hidden = false;/, 'unsupported must be stated, not silent');

  console.log('ok — 17 headset smoke checks');
}

// --- Where a print actually lands ------------------------------------------
// The one piece of AR geometry that can be exercised without a headset, and
// the one that decides whether the visitor sees anything at all. three is a
// devDependency and its math classes need no DOM, so this is a real test
// rather than a grep.
{
  const THREE = await import('../public/vendor/three.module.min.js');
  const { aimPrint } = await import('../public/js/xr.js');

  const face = (o) => new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
  const eye = new THREE.Vector3(0, 1.5, 0);

  // 1. A wall was detected: the print goes on the wall, not through it.
  {
    const wall = new THREE.Matrix4().setPosition(0, 1.5, -2);
    const p = aimPrint(new THREE.Group(), eye, new THREE.Vector3(0, 0, -1), wall);
    assert.ok(p.position.distanceTo(new THREE.Vector3(0, 1.5, -2)) < 0.03,
      'lands on the detected surface');
    assert.ok(p.position.z > -2, 'nudged off the wall toward the room, not into it');
  }

  // 2. No wall detected — ARCore cannot see blank plaster, and this is the
  //    case that used to leave the visitor staring at an empty room forever.
  //    The print must still hang, down the line of sight.
  {
    const dir = new THREE.Vector3(0, 0, -1);
    const p = aimPrint(new THREE.Group(), eye, dir, null);
    assert.ok(p.position.z < -1, 'hung out in front of the viewer, not at their feet');
    assert.ok(p.position.distanceTo(eye) > 1, 'far enough away to look at');
    assert.ok(p.position.distanceTo(eye) < 2, 'and not across the street');
  }

  // 3. Upright and facing the viewer, from any angle. A print tipped flat like
  //    the hit-test pose it came from is invisible edge-on.
  for (const [x, z] of [[0, -2], [2, 0], [-1.5, 1.5], [0, 3]]) {
    const where = new THREE.Vector3(x, 1.2, z);
    const p = aimPrint(new THREE.Group(), eye, new THREE.Vector3(), new THREE.Matrix4().setPosition(where));
    assert.equal(Math.abs(p.rotation.x) < 1e-9, true, `upright at ${x},${z}`);
    assert.equal(Math.abs(p.rotation.z) < 1e-9, true, `not tilted at ${x},${z}`);

    const toEye = eye.clone().sub(p.position).setY(0).normalize();
    const n = face(p).setY(0).normalize();
    assert.ok(n.dot(toEye) > 0.99, `faces the viewer at ${x},${z} (dot ${n.dot(toEye).toFixed(3)})`);
  }

  // 4. Portrait and landscape both keep their long edge at the print size.
  const long = 0.6;
  for (const aspect of [1.5, 1 / 1.5, 1]) {
    const w = aspect >= 1 ? long : long * aspect;
    const h = aspect >= 1 ? long / aspect : long;
    assert.ok(Math.abs(Math.max(w, h) - long) < 1e-9, `long edge is ${long}m at aspect ${aspect}`);
    assert.ok(Math.abs(w / h - aspect) < 1e-9, `aspect preserved at ${aspect}`);
  }

  console.log('ok — 12 print-placement cases');
}
