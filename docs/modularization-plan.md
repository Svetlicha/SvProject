# Modularization Plan

## Stage 1 - Done

- Split desktop HTML into `index.html`, `assets/desktop.css`, `assets/desktop.js`.
- Split mobile HTML into `mobile.html`, `assets/mobile.css`, `assets/mobile.js`.
- Add `assets/section-loader.js` as a safe helper for later lazy-loading.
- Add `sections/manifest.json` as the section map.

## Stage 2 - Next

For each section:

1. Move the section HTML from the week template into `sections/<section>.html`.
2. Move section-specific functions into `sections/<section>.js`.
3. Register the section with the loader.
4. Load the section when its quick-access/mobile nav button is pressed.
5. Verify save/load/export/import still work.

Do this one section at a time. The current code has many cross-section DOM references, so a big-bang extraction would be risky.