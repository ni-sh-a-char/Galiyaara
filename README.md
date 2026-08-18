# Galiyaara · गलियारा

A walk-through gallery of photographs by [**ni_sh_a.char**](https://www.instagram.com/ni_sh_a.char/).

*Galiyaara* means corridor. The site is one — a moonlit stone arcade rendered live in the
browser, with the photographs hung between the arches. You can scroll past it, or step
inside and walk it.

**Live:** https://ni-sh-a-char.github.io/Galiyaara/

---

## Adding a photograph

Put the file in [`photos/`](photos/) and push. That is the whole procedure.

```bash
cp ~/Pictures/new-shot.jpg photos/
git add photos/new-shot.jpg
git commit -m "add new-shot"
git push
```

Within a minute or two GitHub Actions has resized it, measured it, sampled its colour,
hung it on the next free stretch of wall and redeployed the site. Nothing in the code
mentions any individual photograph.

**Titles** come from the filename — `night flower.jpg` becomes *Night Flower*. To override
one, or to give a photograph a caption, add it to [`photos/captions.json`](photos/captions.json):

```json
{
  "night flower.jpg": "Raat Ki Rani",
  "banars.jpg": { "title": "Banaras", "caption": "Older than history." }
}
```

Deleting a photograph works the same way: remove the file, push, and it is off the wall.

Accepted formats: `.jpg` `.jpeg` `.png` `.webp` `.avif` `.tif` `.tiff`.
Upload the biggest version you have — the build makes its own web-sized copies and never
ships the original.

---

## Running it locally

```bash
npm install
npm start          # builds, then serves on http://localhost:5173
```

Or `npm run build` on its own to produce `dist/` without serving. The first build
re-encodes every photograph (about a minute for 100); after that only changed files are
touched, so rebuilds take a few seconds.

```bash
npm test           # checks the filename → slug → title rules
```

---

## How it fits together

```
photos/                  every photograph, at whatever size you shot it
photos/captions.json     optional title/caption overrides
public/                  the site, served as-is
  index.html
  css/site.css
  js/main.js             page wiring: index grid, HUD, modes
  js/gallery.js          the corridor — geometry, lighting, camera, streaming
  vendor/                three.js, vendored (no CDN at runtime)
  assets/portrait.jpg
tools/build.mjs          photos/ + public/ → dist/
tools/build.test.mjs
.github/workflows/       build + deploy to GitHub Pages on every push to main
dist/                    build output, git-ignored
```

**The build** ([`tools/build.mjs`](tools/build.mjs)) copies `public/` verbatim, then for every
photograph writes a 720px wall texture and a 2200px close-up, and records its dimensions,
average colour and title in `dist/photos.json`. A content hash per file means unchanged
photographs are never re-encoded.

**The corridor** ([`public/js/gallery.js`](public/js/gallery.js)) reads that manifest and builds
the scene from it — so its length is however many photographs exist. Design notes:

- **The photographs are unlit.** They use `MeshBasicMaterial` with tone mapping off, so what
  you see on the wall is the file's own colour, not a relit approximation of it. Everything
  that looks like light coming off a frame — the wash on the plaster, the pool on the floor,
  the shaft from the lamp — is additive geometry tinted with that photograph's average colour.
  The only real lights in the scene are the moon and a sky-derived environment map.
- **Textures stream.** A frame starts as a flat rectangle in its own average colour, pulls in
  its 720px texture within 72 m, swaps to the 2200px one when you step up to it, and is
  released past 120 m. Walking the full corridor never holds more than a dozen textures.
- **Arches are instanced**, dust wraps around the camera rather than filling the corridor, and
  there is no post-processing pass. It runs on a phone.

**The page** sits over the same canvas. Scrolling pulls the camera down the corridor;
*Enter the corridor* hides the page and hands you `WASD` + drag-look (plus a thumbstick on
touch); clicking a frame docks the camera in front of it. The `#portfolio` grid is a flat,
keyboard-navigable index of every photograph — it doubles as the accessible path for anyone
who can't or doesn't want to use the 3D view, and clicking a tile sets you down in front of
that frame inside the corridor.

---

## Deployment

Pushing to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which
builds `dist/` and publishes it to GitHub Pages. One-time setup: **Settings → Pages →
Source → GitHub Actions**.

---

## Credits

Photographs © ni_sh_a.char. [three.js](https://threejs.org) (MIT) is vendored in
`public/vendor/`; type is Cormorant Garamond, Inter and Tiro Devanagari Hindi.

The photographs previously lived in a separate `Galiyaara-Resources` repository and the 3D
gallery was an embedded third-party viewer. Both are gone: everything now lives here, and
the corridor is the site's own.
