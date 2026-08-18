/**
 * Galiyaara — page wiring.
 *
 * Reads photos.json (written by tools/build.mjs from whatever is sitting in
 * photos/), hands it to the corridor, and keeps the flat HTML index in sync
 * with it. Adding a photograph never means editing this file.
 */
import { createGallery } from './gallery.js';
import { setupXR, xrSupport } from './xr.js';

const $ = (sel) => document.querySelector(sel);
const body = document.body;

const HIGHLIGHTS = ['manikarnika', 'banars', 'ghat', 'first-lesson'];

// ── Typewriter (the one flourish the old site had, kept, minus the library) ──
function typewriter(el, lines) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = lines[0];
    return;
  }
  let li = 0, ci = 0, erasing = false;
  (function step() {
    const line = lines[li];
    ci += erasing ? -1 : 1;
    el.textContent = line.slice(0, ci);
    let wait = erasing ? 34 : 62;
    if (!erasing && ci === line.length) { erasing = true; wait = 2100; }
    else if (erasing && ci === 0) { erasing = false; li = (li + 1) % lines.length; wait = 380; }
    setTimeout(step, wait);
  })();
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  typewriter($('#type'), [
    'Hello, World!!',
    'I click photographs.',
    'Come walk the corridor.',
  ]);

  let photos = [];
  let walks = [];
  try {
    const res = await fetch('photos.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    photos = data.photos || [];
    walks = data.walks || [];
  } catch (err) {
    console.error('Could not read photos.json — run `npm run build`.', err);
  }
  if (!photos.length) {
    $('#boot .boot-note').textContent = 'no photographs found';
    return;
  }

  buildIndex(photos);
  buildSearch(photos);

  // No WebGL — an old phone, a locked-down browser, a blocklisted GPU. The
  // index is a complete gallery on its own, so fall back to it rather than
  // leaving the visitor staring at the loading screen forever.
  let gallery = null;
  try {
    gallery = createGallery($('#stage'), photos, hooks(photos));
  } catch (err) {
    console.warn('WebGL unavailable — falling back to the flat gallery.', err);
    body.classList.add('flat');
  }
  if (gallery) {
    wire(gallery);
    buildWalks(walks, gallery);
    wireXR(gallery, photos);
  }
  requestAnimationFrame(() => body.classList.add('ready'));
}

// ── The flat index (also the no-WebGL fallback and the a11y path) ───────────
function buildIndex(photos) {
  // Titles come from filenames and captions.json, so they go in as text nodes
  // rather than markup.
  const tile = (p, i) => {
    const el = document.createElement('button');
    el.className = 'tile reveal';
    el.type = 'button';
    el.dataset.index = i;

    const img = document.createElement('img');
    Object.assign(img, { src: p.thumb, alt: p.alt || p.title, loading: 'lazy', decoding: 'async' });

    const cap = document.createElement('figcaption');
    cap.textContent = p.title;
    cap.setAttribute('aria-hidden', 'true');   // the img alt already describes it
    // Everything the search matches on, flattened once at build-of-DOM time.
    el.dataset.find = [p.title, p.caption, p.mood, ...(p.tags || [])].join(' ').toLowerCase();

    el.append(img, cap);
    return el;
  };

  const grid = $('#grid');
  photos.forEach((p, i) => grid.append(tile(p, i)));
  $('#count').textContent = String(photos.length).padStart(2, '0');

  const picks = HIGHLIGHTS
    .map((slug) => photos.findIndex((p) => p.slug === slug))
    .filter((i) => i >= 0);
  while (picks.length < 4) picks.push(picks.length);
  $('#highlights').append(...picks.map((i) => tile(photos[i], i)));
}

// ── Guided walks ────────────────────────────────────────────────────────────
function buildWalks(walks, gallery) {
  if (!walks.length) return;              // no curation yet, so no walks offered
  const ul = $('#walks');
  for (const w of walks) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'walk';
    btn.type = 'button';
    btn.innerHTML = '<strong></strong><span></span><em></em>';
    btn.querySelector('strong').textContent = w.title;
    btn.querySelector('span').textContent = w.blurb;
    btn.querySelector('em').textContent = `${w.slugs.length} frames`;
    btn.addEventListener('click', () => gallery.startTour(w));
    li.append(btn);
    ul.append(li);
  }
  $('#walks-wrap').hidden = false;
}

// ── Search ──────────────────────────────────────────────────────────────────
function buildSearch(photos) {
  const input = $('#q');
  const count = $('#q-count');
  const tiles = [...$('#grid').children];
  if (!photos.some((p) => p.tags?.length)) input.closest('.find').hidden = true;

  const run = () => {
    // Every word has to appear somewhere in the tile's text, so "night river"
    // narrows rather than widens.
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let hits = 0;
    for (const tile of tiles) {
      const ok = terms.every((t) => tile.dataset.find.includes(t));
      tile.hidden = !ok;
      if (ok) hits++;
    }
    count.textContent = terms.length ? `${hits} of ${tiles.length}` : '';
  };
  input.addEventListener('input', run);
  input.addEventListener('search', run);
}

// ── Corridor → page ─────────────────────────────────────────────────────────
function hooks(photos) {
  const now = $('#hud-now').querySelector('strong');
  return {
    onPass(photo) { now.textContent = photo ? photo.title : ''; },
    onMode(mode) { setMode(mode === 'roam'); },
    onTour(state) {
      $('#tour').hidden = !state;
      if (!state) return;
      $('#tour-title').textContent = state.title;
      $('#tour-pos').textContent = `${state.at + 1} / ${state.total}`;
      const play = $('#tour-play');
      play.innerHTML = state.playing ? 'Pause <kbd>space</kbd>' : 'Resume <kbd>space</kbd>';
      play.setAttribute('aria-label', state.playing ? 'Pause the walk' : 'Resume the walk');
    },
    onFocus(photo, i) {
      body.classList.toggle('plated', !!photo);
      if (!photo) document.dispatchEvent(new CustomEvent('galiyaara:focus', { detail: { index: -1 } }));
      $('#plate').setAttribute('aria-hidden', photo ? 'false' : 'true');
      if (!photo) return;
      $('#plate-num').textContent = `${String(i + 1).padStart(2, '0')} / ${photos.length}`;
      $('#plate-title').textContent = photo.title;
      $('#plate-caption').textContent = photo.caption || '';
      $('#plate-caption').hidden = !photo.caption;
      document.dispatchEvent(new CustomEvent('galiyaara:focus', { detail: { index: i } }));
    },
  };
}

let scrollY = 0;
function setMode(immersive) {
  body.dataset.mode = immersive ? 'immersive' : 'page';
  $('#hud').setAttribute('aria-hidden', String(!immersive));
  if (immersive) {
    scrollY = window.scrollY;
    body.style.top = `-${scrollY}px`;
    body.style.position = 'fixed';
    body.style.width = '100%';
  } else if (body.style.position === 'fixed') {
    body.style.position = body.style.top = body.style.width = '';
    window.scrollTo({ top: scrollY, behavior: 'instant' });
  }
}

// ── Page → corridor ─────────────────────────────────────────────────────────
function wire(gallery) {
  const enter = () => gallery.setMode('roam');

  document.querySelectorAll('[data-enter]').forEach((b) => b.addEventListener('click', enter));
  $('#hud-exit').addEventListener('click', () => gallery.setMode('page'));
  $('#plate-close').addEventListener('click', () => gallery.unfocus());
  $('#tour-play').addEventListener('click', () => gallery.toggleTour());
  $('#tour-stop').addEventListener('click', () => gallery.endTour());
  $('#plate-prev').addEventListener('click', () => gallery.prev());
  $('#plate-next').addEventListener('click', () => gallery.next());

  document.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (tile) gallery.jumpTo(Number(tile.dataset.index));
  });

  // Scroll drives the camera down the corridor while the page is showing.
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    gallery.setScroll(max > 0 ? window.scrollY / max : 0);
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Menu
  const toggle = $('#nav-toggle');
  toggle.addEventListener('click', () => {
    const open = body.classList.toggle('menu');
    toggle.setAttribute('aria-expanded', String(open));
  });
  $('#nav').addEventListener('click', (e) => {
    if (e.target.tagName === 'A') body.classList.remove('menu');
  });

  // Reveal
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal, .wrap > *').forEach((el, i) => {
    el.classList.add('reveal');
    el.style.transitionDelay = `${Math.min(i, 6) * 45}ms`;
    io.observe(el);
  });

  touchStick(gallery);
}

// ── Headsets ────────────────────────────────────────────────────────────────
// Progressive enhancement: the buttons only appear once navigator.xr confirms
// the mode is supported, so a phone, a laptop and a Quest all load the same
// page and only the Quest sees the extra doors.
async function wireXR(gallery, photos) {
  const { vr, ar } = await xrSupport();
  if (!vr && !ar) return;

  const xr = setupXR(gallery.xr, {
    onSession(mode) {
      document.body.dataset.xr = mode || '';
      $('#ar-hint').hidden = mode !== 'ar';
      if (mode === 'vr') gallery.setMode('roam');
    },
    onPlaced() { $('#ar-hint').hidden = true; },
  });

  if (vr) {
    const btn = $('#enter-vr');
    btn.hidden = false;
    btn.addEventListener('click', () => xr.enterVR());
  }

  if (ar) {
    const btn = $('#enter-ar');
    // Only offered while a photograph is actually open — "see it on your wall"
    // has to mean a particular photograph.
    document.addEventListener('galiyaara:focus', (e) => {
      btn.hidden = e.detail.index < 0;
      btn.dataset.index = String(e.detail.index);
    });

    btn.addEventListener('click', async () => {
      const photo = photos[Number(btn.dataset.index)];
      if (!photo) return;
      btn.disabled = true;
      btn.textContent = 'Loading the print…';
      try {
        const texture = await gallery.loadTexture(photo.large);
        await xr.enterAR({ texture, aspect: photo.w / photo.h });
      } catch (err) {
        console.warn('could not start AR', err);
      } finally {
        btn.disabled = false;
        btn.textContent = 'See it on your wall';
      }
    });
  }
}

// ── Virtual stick for touch ─────────────────────────────────────────────────
function touchStick(gallery) {
  const pad = $('#joy');
  const nub = pad.querySelector('i');
  const R = 34;
  let id = null;

  const set = (x, y) => {
    nub.style.transform = `translate(${x * R}px, ${y * R}px)`;
    gallery.setStick(x, -y);
  };

  pad.addEventListener('pointerdown', (e) => {
    id = e.pointerId;
    pad.setPointerCapture(id);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const r = pad.getBoundingClientRect();
    let x = (e.clientX - r.left - r.width / 2) / (r.width / 2);
    let y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    set(x, y);
  });
  const end = (e) => { if (e.pointerId === id) { id = null; set(0, 0); } };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
}

boot();
