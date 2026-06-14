# Lens marketing site

Static landing page served at https://lens.maliming.net.

## Layout

```
website/
├── index.html            single-page landing site, no build step
├── assets/               8 screenshots copied from ../docs/screenshots/
│   ├── logo.png          favicon + nav brand mark
│   ├── hero.png          hero shot (above the fold, loaded eagerly)
│   ├── search.png
│   ├── resume.png
│   ├── usage.png
│   ├── workspace.png
│   ├── multi-source.png
│   └── dark.png          dark-theme showcase
└── README.md             this file
```

Everything is plain HTML + inline CSS + ~15 lines of inline JS (IntersectionObserver for scroll-reveal). No bundler, no JavaScript framework. Drop it on any static host (Cloudflare Pages, Netlify, GitHub Pages, Vercel, plain S3) and it works.

## Performance budget

- **Above the fold**: index.html (~22 KB) + logo.png (16 KB) + hero.png (380 KB, `fetchpriority="high"`) ≈ 420 KB
- **Below the fold**: 6 more screenshots (~1.4 MB combined) all marked `loading="lazy"` — only fetched when the user scrolls

So the LCP-critical payload is ~420 KB; everything else streams in on demand.

## Why no build step

Marketing copy + 4 zigzag feature rows + a download CTA doesn't need React. The whole page renders in one HTTP request after the HTML + hero image load.

## Updating

When the app's screenshots change, re-copy all 8:

```bash
cp ../build/icon.png ./assets/logo.png
cp ../docs/screenshots/*.png ./assets/
```

When the tagline / feature copy changes, edit `index.html` directly. The CSS variables for light/dark + accent colors are at the top of the `<style>` block.
