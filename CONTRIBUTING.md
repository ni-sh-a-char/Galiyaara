# Contributing to Galiyaara

This is one photographer's portfolio *and* a reusable 3D gallery. That split decides what
belongs here and what belongs in your fork.

## Wanted here

- **The corridor** — rendering, lighting, camera feel, mobile controls, texture streaming.
- **Performance** — anything measurable: fewer draw calls, faster first frame, smaller
  payload, better behaviour on low-end hardware. Say what you measured and on what.
- **Accessibility** — keyboard paths, focus order, screen-reader labelling, reduced-motion,
  the flat index. Bugs here are always in scope.
- **The build** — faster or more correct derivative generation, better filename handling,
  more input formats.
- **The curator** — better prompts, cheaper passes, better guards on the model's output. If
  you change a prompt, paste a few before/after captions in the PR: prompt changes are not
  reviewable as a diff alone.
- **Browser bugs** — with browser, OS, GPU and, if you can get it, the console output.
- **Docs** — if something in the README turned out to be wrong or unclear when you tried it.

## Belongs in your fork instead

- Changes to **this photographer's** copy, About text, Instagram links or photographs.
- Adding, removing or reordering photographs in `photos/`.
- Restyling the site toward a different personal brand.

Forking for your own photographs is the intended use — the README has a
[Make it yours](README.md#make-it-yours) section. If you build one, open an issue and say so.

## Things this project deliberately does not have

Please don't open a PR adding these without discussing it first; each was a decision, not an
oversight.

- **A build framework or bundler.** The site is hand-authored HTML, CSS and ES modules. The
  only build step exists because photographs need resizing.
- **A CDN.** three.js is vendored on purpose, so no third party's outage can break the site.
- **Any AI call at runtime.** The site is static and has no server, so a browser-side model
  call would mean shipping an API key to every visitor. The whole AI pass runs at build time
  and its output is committed (see [The curator](README.md#the-curator)). A PR that moves it
  into the browser will be closed regardless of how the key is hidden.
- **A hard dependency on the AI.** Every AI-derived field has a non-AI fallback, and the site
  must build, deploy and work with no `ANTHROPIC_API_KEY` at all. Keep it that way — most
  forks will not set one.
- **Post-processing (bloom, DOF, colour grading).** It blurs and recolours the photographs,
  which defeats the point of a photography site. The glow is additive geometry instead.
- **A config file for the site's text.** `index.html` is authored by hand so the page has real
  content before JavaScript runs. Four or five edits is a fair price for that.
- **New runtime dependencies.** If a few lines will do it, write the few lines.

## Working on it

```bash
npm install
npm start        # http://localhost:5173
npm test         # filename rules, metadata precedence, untrusted-curation guards
```

`npm run curate` needs an `ANTHROPIC_API_KEY` and costs about a cent per photograph. You do
not need it to work on anything else — without a key it skips itself, and `photos/curation.json`
is already committed. **Don't commit a re-curation you didn't mean to**: check
`git status photos/curation.json` before pushing.

Before opening a PR:

- `npm test` passes, and `npm run build` completes cleanly.
- You've actually loaded the page and walked the corridor — most of what can break here is
  visual and no test will catch it. Screenshots or a short capture in the PR help a lot.
- Style matches what's already there: no semicolon crusades, no reformatting passes, no
  abstractions introduced for a single caller.
- One concern per PR.

## Reporting a bug

Include the browser, OS and GPU, what you expected, what happened, and whether it reproduces
on the [live site](https://ni-sh-a-char.github.io/Galiyaara/). For rendering bugs a screenshot
is worth more than any description.

## Licensing what you contribute

Code contributions are taken under the [MIT licence](LICENSE). **Do not add photographs to
this repository** — `photos/` holds one photographer's copyrighted work under
[its own licence](photos/LICENSE), and a pull request adding images to it will be closed.

## Conduct

Be decent. See the [Code of Conduct](CODE_OF_CONDUCT.md).
