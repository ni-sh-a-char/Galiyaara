/**
 * The Curator — the AI pass, which runs at build time and never at runtime.
 *
 * This is a static site on GitHub Pages. Calling Claude from the browser would
 * mean shipping an API key to every visitor, so nothing here happens in the
 * browser: Claude looks at each photograph once, when it is first added, and
 * writes it up. The result is committed to photos/curation.json, so visitors
 * get finished words instantly, forks inherit the curation for free, and a
 * photograph is never paid for twice.
 *
 * Two passes:
 *   1. Per photograph — title, caption, alt text, tags, mood.
 *   2. Over the whole collection — the order the photographs hang in, and a
 *      handful of guided walks through them.
 *
 * Both are cached by the source file's content hash. With no API key this exits
 * quietly and the build falls back to filename titles, so a fork with no key
 * still builds and deploys.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'photos');
const CURATION = path.join(SRC, 'curation.json');

const MODEL = 'claude-opus-5';
const CONCURRENCY = 4;
const LOOK_PX = 512;   // what Claude is shown; plenty to describe by, cheap to send
const WALKS = 5;

const hash = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);

// --- Pass 1: one photograph -------------------------------------------------

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

const PHOTO_TOOL = {
  name: 'record_photograph',
  description: 'Record the wall text and index metadata for one photograph.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '1-4 words. Title Case. The name on the brass plaque under the frame. Concrete over poetic.',
      },
      caption: {
        type: 'string',
        description: 'One sentence, under 100 characters, no trailing period unless it is a full sentence. Notices one true thing.',
      },
      alt: {
        type: 'string',
        description: 'Plain factual description for a screen reader, under 160 characters. What is in the frame, no interpretation, no mood words.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '6 to 10 lowercase single words or short phrases someone might search: subjects, place, time of day, light, colour, mood, activity.',
      },
      mood: {
        type: 'string',
        description: 'One lowercase word for the overall feeling.',
      },
    },
    required: ['title', 'caption', 'alt', 'tags', 'mood'],
    additionalProperties: false,
  },
};

async function describe(client, file, filename) {
  // Claude sees a small copy — the description doesn't get better at 2200px,
  // and the request gets a lot more expensive.
  const jpeg = await sharp(file).rotate()
    .resize({ width: LOOK_PX, height: LOOK_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 }).toBuffer();

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: EYE,
    output_config: { effort: 'low' },
    tools: [PHOTO_TOOL],
    tool_choice: { type: 'tool', name: 'record_photograph' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        {
          type: 'text',
          text: `Write the wall text for this photograph. The photographer filed it as "${filename}" — treat that as a hint about intent, not as something to repeat back if it is meaningless.`,
        },
      ],
    }],
  });

  const call = res.content.find((b) => b.type === 'tool_use');
  if (!call) throw new Error(`no tool_use in response (stop_reason: ${res.stop_reason})`);
  return call.input;
}

// --- Pass 2: the whole collection -------------------------------------------

const HANG_TOOL = {
  name: 'hang_the_show',
  description: 'Decide the order the photographs hang in, and the guided walks through them.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      hang: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every slug exactly once, in the order they should hang along the corridor. Adjacent photographs should talk to each other.',
      },
      walks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'lowercase-hyphenated identifier' },
            title: { type: 'string', description: '2-5 words naming the walk' },
            blurb: { type: 'string', description: 'One sentence, under 110 characters, saying what this walk is.' },
            slugs: { type: 'array', items: { type: 'string' }, description: '5 to 12 slugs, in the order to walk them.' },
          },
          required: ['id', 'title', 'blurb', 'slugs'],
          additionalProperties: false,
        },
      },
    },
    required: ['hang', 'walks'],
    additionalProperties: false,
  },
};

async function hangShow(client, entries) {
  const list = entries
    .map((e) => `${e.slug} | ${e.title} | ${e.mood} | ${e.tags.join(', ')}`)
    .join('\n');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: `${EYE}\n\nYou are now hanging the show.`,
    output_config: { effort: 'high' },
    tools: [HANG_TOOL],
    tool_choice: { type: 'tool', name: 'hang_the_show' },
    messages: [{
      role: 'user',
      content: `Here is the whole collection, one per line as "slug | title | mood | tags":

${list}

Two jobs.

1. Sequence every photograph into the corridor. A visitor walks past them in this
   order, one on the left wall then one on the right, so neighbours are seen
   together. Build runs of related work and let the show turn between them rather
   than jumping at random. Open on something that makes someone want to keep
   walking, and end on something that feels like an ending. Use every slug exactly
   once and invent none.

2. Write ${WALKS} guided walks — themed routes through the collection that a visitor
   can take instead of wandering. Each should have a real argument to it, not just
   a tag bucket. Slugs may repeat across different walks.`,
    }],
  });

  const call = res.content.find((b) => b.type === 'tool_use');
  if (!call) throw new Error(`no tool_use in response (stop_reason: ${res.stop_reason})`);
  return call.input;
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
  hash(Buffer.from(entries.map((e) => `${e.slug}:${e.mood}:${e.tags.join(',')}`).sort().join('|')));

/**
 * Take what the model returned and make it safe to hang a gallery from.
 * A hallucinated slug must not create a phantom frame, and — much worse — a
 * photograph the model forgot must not silently vanish from the corridor.
 */
export function reconcileShow(show, slugs) {
  const valid = new Set(slugs);
  const hang = [...new Set((show.hang || []).filter((s) => valid.has(s)))];
  for (const slug of slugs) if (!hang.includes(slug)) hang.push(slug);

  const walks = (show.walks || [])
    .map((w) => ({ ...w, slugs: [...new Set((w.slugs || []).filter((s) => valid.has(s)))] }))
    .filter((w) => w.id && w.title && w.slugs.length >= 3);

  return { hang, walks };
}

export async function loadCuration(file = CURATION) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { version: 1, photos: {}, hang: [], walks: [], hangKey: null };
  }
}

async function main() {
  const force = process.argv.includes('--force');
  const client = new Anthropic({ maxRetries: 4 });

  const curation = await loadCuration();
  curation.photos ||= {};

  const EXT = /\.(jpe?g|png|webp|avif|tiff?)$/i;
  const files = (await readdir(SRC)).filter((f) => EXT.test(f)).sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error(`No images in ${SRC}`);

  // build.mjs owns slugging; import it rather than keep a second copy in sync.
  const { slugify } = await import('./build.mjs');
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

  console.log(`looking at ${todo.length} photograph${todo.length === 1 ? '' : 's'}…`);
  let done = 0;
  await pool(CONCURRENCY, todo, async (p) => {
    try {
      const meta = await describe(client, path.join(SRC, p.file), p.file);
      curation.photos[p.slug] = { stamp: p.stamp, ...meta };
      console.log(`  ${(++done).toString().padStart(3)}/${todo.length}  ${p.slug} — "${meta.title}"`);
    } catch (err) {
      // One bad photograph must not lose the other 102. It simply stays
      // uncurated and falls back to its filename title.
      console.warn(`  !  ${p.slug}: ${err.message}`);
    }
  });

  const entries = all
    .filter((p) => curation.photos[p.slug])
    .map((p) => ({ slug: p.slug, ...curation.photos[p.slug] }));
  const key = hangKeyOf(entries);

  if (entries.length && (force || key !== curation.hangKey)) {
    console.log(`hanging the show — ${entries.length} photographs…`);
    try {
      const show = reconcileShow(await hangShow(client, entries), entries.map((e) => e.slug));
      curation.hang = show.hang;
      curation.walks = show.walks;
      curation.hangKey = key;
      console.log(`  order set, ${curation.walks.length} walks: ${curation.walks.map((w) => w.title).join(' · ')}`);
    } catch (err) {
      console.warn(`  !  could not hang the show: ${err.message}`);
    }
  }

  await writeFile(CURATION, JSON.stringify(curation, null, 1) + '\n');
  console.log(`wrote ${path.relative(ROOT, CURATION)} — commit it so nobody pays to look at these twice`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('no ANTHROPIC_API_KEY — skipping curation; the build will fall back to filename titles');
    process.exit(0);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
