/**
 * The Curator — the AI pass, which runs at build time and never at runtime.
 *
 * This is a static site on GitHub Pages. Calling a model from the browser would
 * mean shipping an API key to every visitor, so nothing here happens in the
 * browser: a model looks at each photograph once, when it is first added, and
 * writes it up. The result is committed to photos/curation.json, so visitors get
 * finished words instantly, forks inherit the curation for free, and a
 * photograph is never looked at twice.
 *
 * Two passes:
 *   1. Per photograph — title, caption, alt text, tags, mood. Needs vision.
 *   2. Over the whole collection — the order the photographs hang in, and a
 *      handful of guided walks through them. Text only.
 *
 * Runs on free models through any OpenAI-compatible provider (Groq, OpenRouter,
 * OpenCode Zen, or your own base URL) — no SDK, just fetch. Free models don't
 * do strict schemas or reliable tool calls, so we ask for JSON, parse it
 * leniently, and normalise whatever comes back. Everything downstream treats
 * the model's output as untrusted input: see normalizePhoto() and
 * reconcileShow().
 *
 * With no key this exits quietly and the build falls back to filename titles,
 * so a fork with no key still builds and deploys.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'photos');
const CURATION = path.join(SRC, 'curation.json');

const CONCURRENCY = 2;     // free tiers rate-limit hard; two at a time is polite
const LOOK_PX = 384;       // image tokens scale with area, and free tiers are metered on tokens;
const WALKS = 5;
const REQ_TIMEOUT = 90000; // a hung socket must not stall a CI job forever
const MAX_BACKOFF = 60;    // seconds we are willing to sit out a 429

const hash = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Providers --------------------------------------------------------------

/**
 * Free tiers, in the order we look for a key. Every one of these speaks the
 * OpenAI /chat/completions shape, so there is one client for all of them.
 * Free model IDs churn — override with GALIYAARA_AI_MODEL.
 */
export const PROVIDERS = {
  groq: {
    label: 'Groq',
    env: 'GROQ_API_KEY',
    base: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.6-27b',
    vision: true,
    keys: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    base: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-31b-it:free',
    vision: true,
    keys: 'https://openrouter.ai/keys',
    headers: { 'X-Title': 'Galiyaara' },
  },
  opencodezen: {
    label: 'OpenCode Zen',
    env: 'OPENCODE_API_KEY',
    base: 'https://opencode.ai/zen/v1',
    model: 'nemotron-3-ultra-free',
    vision: false,   // its free models are coding models — they cannot see
    keys: 'https://opencode.ai/zen',
  },
};

/**
 * Every free provider with a key, in the order we will try them. One free tier
 * cannot describe a hundred photographs in a single allowance window, so when
 * the first runs dry we move to the next rather than stopping for the day.
 *
 * GALIYAARA_AI_MODEL only overrides the *first* provider's model — it would be
 * meaningless applied to a fallback running on a different service.
 */
export function pickProviders(env = process.env) {
  const named = env.GALIYAARA_AI_PROVIDER;

  if (named === 'custom' || (!named && env.GALIYAARA_AI_BASE_URL && env.GALIYAARA_AI_KEY)) {
    if (!env.GALIYAARA_AI_BASE_URL || !env.GALIYAARA_AI_KEY) {
      throw new Error('custom provider needs both GALIYAARA_AI_BASE_URL and GALIYAARA_AI_KEY');
    }
    return [{
      label: 'custom', vision: true, key: env.GALIYAARA_AI_KEY,
      base: env.GALIYAARA_AI_BASE_URL.replace(/\/$/, ''),
      model: env.GALIYAARA_AI_MODEL || 'unset',
    }];
  }

  // Naming one provider means that one only — no silent fallback to another
  // service when you asked for a specific one.
  if (named) {
    const p = PROVIDERS[named];
    if (!p) throw new Error(`unknown GALIYAARA_AI_PROVIDER "${named}" — one of: ${Object.keys(PROVIDERS).join(', ')}, custom`);
    if (!env[p.env]) throw new Error(`GALIYAARA_AI_PROVIDER=${named} but ${p.env} is not set`);
    return [{ ...p, key: env[p.env], model: env.GALIYAARA_AI_MODEL || p.model }];
  }

  const found = Object.values(PROVIDERS).filter((p) => env[p.env]);
  return found.map((p, i) => ({
    ...p,
    key: env[p.env],
    model: (i === 0 && env.GALIYAARA_AI_MODEL) || p.model,
  }));
}

/** The provider we would start with, or null if no key is set anywhere. */
export const pickProvider = (env = process.env) => pickProviders(env)[0] || null;

/** The free tier's allowance is spent. Not a failure — just "come back later". */
export class OutOfQuota extends Error {}

/**
 * One OpenAI-compatible chat call, with the patience a free tier demands.
 * 429 is the normal case here, not an exception — honour Retry-After when it is
 * offered and back off when it is not.
 */
async function chat(provider, messages, { maxTokens = 1200, tries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${provider.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.key}`,
          ...(provider.headers || {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.6,
        }),
        signal: AbortSignal.timeout(REQ_TIMEOUT),
      });
    } catch (err) {
      if (attempt >= tries - 1) throw err;
      await sleep(2000 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const body = await res.json();
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error(`empty response (finish_reason: ${body.choices?.[0]?.finish_reason})`);
      return text;
    }

    const after = Number(res.headers.get('retry-after'));

    // A Retry-After measured in minutes or hours is not a burst limit — it is
    // the daily quota saying come back tomorrow. Sleeping through that would
    // hang CI for hours (it did), so stop and keep what we already have.
    if (res.status === 429 && Number.isFinite(after) && after > MAX_BACKOFF) {
      // Providers name the limit they are enforcing (per-minute, per-day,
      // tokens vs requests) in the body. Pass it through — without it you
      // cannot tell "wait a minute" from "wait until tomorrow".
      const why = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim();
      throw new OutOfQuota(
        `${provider.label} rate-limited — asked for ${Math.round(after / 60)} min`
        + (why ? `. ${why}` : '')
      );
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= tries - 1) {
      throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 240)}`);
    }
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt);
  }
}

// --- Making the model's output safe -----------------------------------------

/**
 * Free models wrap JSON in prose, in code fences, or both. Take the first
 * balanced object in the text rather than trusting the whole string.
 */
export function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('no JSON object in response');

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error('unbalanced JSON in response');
}

const str = (v, max) => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Coerce whatever the model returned into the shape the site renders. With no
 * schema enforcement on free models, this is where that guarantee is made —
 * nothing downstream should ever have to check a type.
 */
export function normalizePhoto(raw, fallbackTitle) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const title = str(r.title, 60) || fallbackTitle;
  const tags = (Array.isArray(r.tags) ? r.tags : [])
    .map((t) => str(t, 24).toLowerCase())
    .filter(Boolean);
  return {
    title,
    caption: str(r.caption, 140),
    alt: str(r.alt, 200) || title,
    tags: [...new Set(tags)].slice(0, 12),
    mood: str(r.mood, 20).toLowerCase().split(' ')[0] || '',
  };
}

/**
 * Take what the model returned and make it safe to hang a gallery from.
 * A hallucinated slug must not create a phantom frame, and — much worse — a
 * photograph the model forgot must not silently vanish from the corridor.
 */
export function reconcileShow(show, slugs) {
  const valid = new Set(slugs);
  const hang = [...new Set((show?.hang || []).filter((s) => valid.has(s)))];
  for (const slug of slugs) if (!hang.includes(slug)) hang.push(slug);

  const walks = (show?.walks || [])
    .map((w) => ({
      id: str(w?.id, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: str(w?.title, 48),
      blurb: str(w?.blurb, 130),
      slugs: [...new Set((Array.isArray(w?.slugs) ? w.slugs : []).filter((s) => valid.has(s)))].slice(0, 14),
    }))
    .filter((w) => w.id && w.title && w.slugs.length >= 3);

  return { hang, walks };
}

// --- The voice --------------------------------------------------------------

const EYE = `You are the curator of Galiyaara, a photography gallery built as a
corridor you walk down. The photographs are street and documentary work from
India — Banaras ghats, night streets, animals, strangers who held still for one
frame. You are writing the wall text.

Voice: spare, concrete, unsentimental. A good caption notices one true thing and
stops. Never explain the photograph back to the viewer, never use "captures",
"stunning", "beautifully", "evokes", "a testament to", and never open with "A"
or "This". No exclamation marks. Nothing about the photographer's skill.

If the photograph shows people, describe them by what they are doing, not by
guessing who they are.`;

// --- Pass 1: one photograph -------------------------------------------------

const PHOTO_JSON = `Reply with one JSON object and nothing else — no preamble, no code fence.

{
  "title": "1-4 words, Title Case, the name on the brass plaque under the frame",
  "caption": "one sentence under 100 characters that notices a single true thing",
  "alt": "plain factual description for a screen reader, under 160 characters, no mood words",
  "tags": ["6 to 10 lowercase words someone might search: subjects, place, time of day, light, colour, mood, activity"],
  "mood": "one lowercase word"
}`;

async function describe(provider, file, filename, fallbackTitle) {
  // The model sees a small copy — the description does not get better at 2200px,
  // and free tiers cap request size.
  const jpeg = await sharp(file).rotate()
    .resize({ width: LOOK_PX, height: LOOK_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 }).toBuffer();

  const text = await chat(provider, [
    { role: 'system', content: `${EYE}\n\n${PHOTO_JSON}` },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
        {
          type: 'text',
          text: `Write the wall text for this photograph. The photographer filed it as "${filename}" — a hint about intent, not something to repeat back if it is meaningless.`,
        },
      ],
    },
  ], { maxTokens: 500 });   // the JSON is short; do not pay for headroom nobody uses

  return normalizePhoto(parseJson(text), fallbackTitle);
}

// --- Pass 2: the whole collection -------------------------------------------

async function hangShow(provider, entries) {
  const list = entries
    .map((e) => `${e.slug} | ${e.title} | ${e.mood} | ${(e.tags || []).join(', ')}`)
    .join('\n');

  const text = await chat(provider, [
    {
      role: 'system',
      content: `${EYE}\n\nYou are now hanging the show. Reply with one JSON object and nothing else — no preamble, no code fence.`,
    },
    {
      role: 'user',
      content: `Here is the whole collection, one per line as "slug | title | mood | tags":

${list}

Two jobs.

1. "hang": every slug above, exactly once, in the order they should hang along the
   corridor. A visitor walks past them in this order — one on the left wall, then one
   on the right — so neighbours are seen together. Build runs of related work and let
   the show turn between them rather than jumping at random. Open on something that
   makes someone want to keep walking; end on something that feels like an ending.
   Invent no slugs.

2. "walks": ${WALKS} guided routes through the collection, for a visitor who would rather
   not wander. Each needs a real argument to it, not just a tag bucket. Slugs may
   repeat between walks.

Reply exactly:

{
  "hang": ["slug", "slug"],
  "walks": [
    { "id": "lowercase-hyphenated", "title": "2-5 words", "blurb": "one sentence under 110 characters", "slugs": ["slug"] }
  ]
}`,
    },
  ], { maxTokens: 8000 });

  return parseJson(text);
}

// --- Plumbing ---------------------------------------------------------------

/** Run `fn` over `items`, `n` at a time. */
async function pool(n, items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * Whether the collection-level pass needs redoing. Keyed on what pass 2 is
 * actually shown, so re-running it is skipped unless that input changed.
 */
export const hangKeyOf = (entries) =>
  hash(Buffer.from(entries.map((e) => `${e.slug}:${e.mood}:${(e.tags || []).join(',')}`).sort().join('|')));

const save = (curation) => writeFile(CURATION, JSON.stringify(curation, null, 1) + '\n');

export async function loadCuration(file = CURATION) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { version: 1, photos: {}, hang: [], walks: [], hangKey: null };
  }
}

async function main() {
  const force = process.argv.includes('--force');
  const chain = pickProviders();
  console.log(chain.length === 1
    ? `curating via ${chain[0].label} — ${chain[0].model}`
    : `curating via ${chain.map((p) => `${p.label} (${p.model})`).join(' → then ')}`);

  const curation = await loadCuration();
  curation.photos ||= {};

  const EXT = /\.(jpe?g|png|webp|avif|tiff?)$/i;
  const files = (await readdir(SRC)).filter((f) => EXT.test(f)).sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error(`No images in ${SRC}`);

  // build.mjs owns slugging and titling; import them rather than keep a second
  // copy in sync.
  const { slugify, titleize } = await import('./build.mjs');
  const seen = new Set();
  const all = [];
  for (const file of files) {
    let slug = slugify(file);
    while (seen.has(slug)) slug += '-2';
    seen.add(slug);
    all.push({ file, slug, stamp: hash(await readFile(path.join(SRC, file))) });
  }

  // Photographs that have never been looked at, or that changed on disk.
  const todo = all.filter((p) => force || curation.photos[p.slug]?.stamp !== p.stamp);
  const stale = Object.keys(curation.photos).filter((s) => !seen.has(s));
  for (const s of stale) delete curation.photos[s];

  if (!todo.length && !stale.length && !force) {
    const entries = all.map((p) => ({ slug: p.slug, ...curation.photos[p.slug] }));
    if (curation.hangKey === hangKeyOf(entries)) {
      console.log(`curation up to date — ${all.length} photographs, nothing to look at`);
      return;
    }
  }

  // Each provider gets a pass at whatever is still undescribed. When one runs
  // dry we hand the remainder to the next rather than stopping for the day.
  const seers = chain.filter((p) => p.vision);
  if (todo.length && !seers.length) {
    console.warn(`  !  none of the keys set can see images (${chain.map((p) => p.label).join(', ')}).`);
    console.warn('     Add GROQ_API_KEY or OPENROUTER_API_KEY for the per-photograph pass.');
  }

  let done = 0;
  let exhausted = 0;
  const failures = [];

  for (const provider of seers) {
    const left = todo.filter((p) => curation.photos[p.slug]?.stamp !== p.stamp);
    if (!left.length) break;

    let dry = false;
    console.log(`looking at ${left.length} photograph${left.length === 1 ? '' : 's'} via ${provider.label}…`);

    await pool(CONCURRENCY, left, async (p) => {
      if (dry) return;                    // no point queueing more of the same
      try {
        const meta = await describe(provider, path.join(SRC, p.file), p.file, titleize(p.slug));
        curation.photos[p.slug] = { stamp: p.stamp, ...meta };
        // Save as we go. A free tier will not get through a hundred
        // photographs in one window, and an interrupted run must not throw
        // away the ones it managed — the next run resumes from here.
        await save(curation);
        console.log(`  ${(++done).toString().padStart(3)}/${todo.length}  ${p.slug} — "${meta.title}"`);
      } catch (err) {
        if (err instanceof OutOfQuota) {
          if (!dry) console.warn(`  …  ${err.message}`);
          dry = true;
          return;
        }
        // One bad photograph must not lose the other 102. It simply stays
        // uncurated and falls back to its filename title.
        failures.push({ provider, message: err.message });
        console.warn(`  !  ${p.slug}: ${err.message}`);
      }
    });

    if (!dry) break;                      // finished without hitting a wall
    exhausted++;
  }

  const outstanding = todo.filter((p) => curation.photos[p.slug]?.stamp !== p.stamp).length;
  const walled = exhausted > 0 && outstanding > 0;
  if (walled) {
    console.log(`  ${done} curated this run, ${outstanding} still to do — every key is rate-limited for now.`);
    console.log('     The allowances reset; the nightly run picks up from here.');
  }

  // Nothing succeeded and nobody was rate-limited: that is a broken key, a
  // retired model id, or an outage. Fail loudly rather than quietly deploying
  // an uncurated site forever.
  if (todo.length && !done && !exhausted && failures.length) {
    const { provider, message } = failures[0];
    throw new Error(
      `all ${failures.length} request(s) failed. First error, from ${provider.label}:\n`
      + `    ${message}\n`
      + `  Check ${provider.env || 'GALIYAARA_AI_KEY'}, and that "${provider.model}" is a model `
      + 'your account can use (free model IDs change — set GALIYAARA_AI_MODEL to override).'
    );
  }

  const entries = all
    .filter((p) => curation.photos[p.slug])
    .map((p) => ({ slug: p.slug, ...curation.photos[p.slug] }));
  const key = hangKeyOf(entries);

  // No point re-hanging a show that is still half-written.
  if (entries.length && !walled && (force || key !== curation.hangKey)) {
    // The hang pass is text-only, so any provider will do — including one whose
    // free models cannot see.
    const hanger = chain[Math.min(exhausted, chain.length - 1)];
    console.log(`hanging the show — ${entries.length} photographs via ${hanger.label}…`);
    try {
      const show = reconcileShow(await hangShow(hanger, entries), entries.map((e) => e.slug));
      curation.hang = show.hang;
      curation.walks = show.walks;
      curation.hangKey = key;
      console.log(`  order set, ${show.walks.length} walk${show.walks.length === 1 ? '' : 's'}`
        + (show.walks.length ? `: ${show.walks.map((w) => w.title).join(' · ')}` : ''));
    } catch (err) {
      // Losing the hang order is survivable — the build falls back to
      // alphabetical and simply offers no walks.
      console.warn(`  !  could not hang the show: ${err.message}`);
    }
  }

  await save(curation);
  console.log(`wrote ${path.relative(ROOT, CURATION)} — commit it so nobody looks at these twice`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let provider = null;
  try {
    provider = pickProvider();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!provider) {
    const list = Object.values(PROVIDERS).map((p) => `${p.env}  — ${p.label}, free: ${p.keys}`).join('\n    ');
    console.log('no AI key set — skipping curation; the build falls back to filename titles.');
    console.log(`  set any one of:\n    ${list}`);
    process.exit(0);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
