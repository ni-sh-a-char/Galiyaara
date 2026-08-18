/**
 * Builds `dist/` — the deployable site.
 *
 * The only thing this does that a plain copy can't: turn whatever the
 * photographer dropped into `photos/` into web-sized derivatives plus a
 * `photos.json` manifest. The 3D gallery reads that manifest, so adding a
 * photograph is exactly "put the file in photos/ and push".
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadCuration } from './curate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'photos');
const OUT = path.join(ROOT, 'dist');

const EXT = /\.(jpe?g|png|webp|avif|tiff?)$/i;
const THUMB_W = 720;   // what the corridor hangs on the wall
const LARGE_W = 2200;  // what you get when you step up to a frame
const COVER = 'Manikarnika.jpeg'; // social preview + hero poster

/** "night flower.jpg" -> "night-flower"; also tames stray punctuation. */
export const slugify = (name) =>
  name.replace(EXT, '')
    .replace(/[._\s]+/g, '-')   // camera names like "2024-06-01 19.42.10.jpg" keep their groups
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

/** "the-three-musketeers" -> "The Three Musketeers" */
export const titleize = (slug) =>
  slug.split('-')
    .map((w, i) => (i > 0 && MINOR.has(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');

/**
 * Content hash of a source photograph. Recorded next to the derivatives so a
 * rebuild only re-encodes what actually changed — mtimes are no use here,
 * a fresh `git checkout` stamps every file with the time of the checkout.
 */
const hash = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);

async function readIndex(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}

/** Average colour, used as the frame's placeholder before its texture lands. */
function meanHex(stats) {
  const [r, g, b] = stats.channels.slice(0, 3).map((c) => Math.round(c.mean));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Where a photograph's words come from, most trusted first:
 *   1. photos/captions.json  — written by hand, always wins
 *   2. photos/curation.json  — written by Claude at build time (tools/curate.mjs)
 *   3. the filename          — always available, so the site never depends on either
 */
export function resolveMeta(slug, filename, captions, curation) {
  const hand = captions[filename] || captions[slug] || {};
  const ai = curation.photos?.[slug] || {};
  const title = hand.title || ai.title || titleize(slug);
  return {
    title,
    caption: hand.caption ?? ai.caption ?? '',
    alt: hand.alt || ai.alt || title,
    tags: hand.tags || ai.tags || [],
    mood: hand.mood || ai.mood || '',
    curated: !hand.title && !!ai.title,
  };
}

async function loadCaptions() {
  try {
    const raw = JSON.parse(await readFile(path.join(SRC, 'captions.json'), 'utf8'));
    // Accept both { "file.jpg": "Title" } and { "file.jpg": { title, caption } }
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? { title: v } : v])
    );
  } catch {
    return {};
  }
}

async function main() {
  const t0 = Date.now();
  const captions = await loadCaptions();
  const curation = await loadCuration(path.join(SRC, 'curation.json'));

  // 1. The static site, verbatim.
  await mkdir(OUT, { recursive: true });
  await cp(path.join(ROOT, 'public'), OUT, { recursive: true });

  // 2. Photo derivatives.
  await mkdir(path.join(OUT, 'photos', 'thumb'), { recursive: true });
  await mkdir(path.join(OUT, 'photos', 'large'), { recursive: true });

  const files = (await readdir(SRC)).filter((f) => EXT.test(f)).sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error(`No images found in ${SRC}`);

  const indexFile = path.join(OUT, 'photos', '.index.json');
  const prev = await readIndex(indexFile);
  const next = {};

  const seen = new Set();
  const photos = [];
  let built = 0;

  for (const file of files) {
    const src = path.join(SRC, file);
    let slug = slugify(file);
    while (seen.has(slug)) slug += '-2'; // two files, one slug: keep both
    seen.add(slug);

    const thumb = path.join(OUT, 'photos', 'thumb', `${slug}.jpg`);
    const large = path.join(OUT, 'photos', 'large', `${slug}.jpg`);
    const stamp = hash(await readFile(src));
    next[slug] = stamp;

    if (prev[slug] !== stamp || !existsSync(thumb) || !existsSync(large)) {
      // .rotate() with no argument applies the EXIF orientation, so the
      // dimensions we report always match the pixels we ship.
      const base = sharp(src).rotate();
      await base.clone().resize({ width: LARGE_W, withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true }).toFile(large);
      await base.clone().resize({ width: THUMB_W, withoutEnlargement: true })
        .jpeg({ quality: 74, mozjpeg: true }).toFile(thumb);
      built++;
    }

    const img = sharp(thumb);
    const [meta, stats] = await Promise.all([img.metadata(), img.stats()]);

    photos.push({
      slug,
      ...resolveMeta(slug, file, captions, curation),
      thumb: `photos/thumb/${slug}.jpg`,
      large: `photos/large/${slug}.jpg`,
      w: meta.width,
      h: meta.height,
      tint: meanHex(stats),
    });
  }

  // The curator's hang order, when there is one. Anything it doesn't mention
  // (a photograph added since the last curation run) keeps its alphabetical
  // place at the end rather than disappearing.
  const hang = curation.hang?.length ? curation.hang : [];
  const rank = new Map(hang.map((slug, i) => [slug, i]));
  photos.sort((a, b) => (rank.get(a.slug) ?? Infinity) - (rank.get(b.slug) ?? Infinity));

  const bySlug = new Set(photos.map((p) => p.slug));
  const walks = (curation.walks || [])
    .map((w) => ({ ...w, slugs: w.slugs.filter((s) => bySlug.has(s)) }))
    .filter((w) => w.slugs.length >= 3);

  await writeFile(path.join(OUT, 'photos.json'), JSON.stringify({ photos, walks }, null, 1));
  await writeFile(indexFile, JSON.stringify(next));

  // Derivatives of photographs that have since been deleted are dead weight.
  for (const dir of ['thumb', 'large']) {
    const kept = new Set(Object.keys(next).map((s) => `${s}.jpg`));
    for (const f of await readdir(path.join(OUT, 'photos', dir))) {
      if (!kept.has(f)) await rm(path.join(OUT, 'photos', dir, f));
    }
  }

  // 3. Social preview card, cut from a real photograph.
  const cover = existsSync(path.join(SRC, COVER)) ? path.join(SRC, COVER) : path.join(SRC, files[0]);
  await sharp(cover).rotate().resize(1200, 630, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, 'assets', 'og.jpg'));

  console.log(
    `dist/ ready — ${photos.length} photographs (${built} rendered, ${photos.length - built} cached), `
    + `${photos.filter((p) => p.curated).length} curated, ${walks.length} walks, `
    + `in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
}

// Importing this file (tools/build.test.mjs does) must not kick off a build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
