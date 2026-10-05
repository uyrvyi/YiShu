# Administrative Regions

- Source: https://github.com/modood/Administrative-divisions-of-China
- Pinned commit: `c49d495b40ac73eb1a66f6eeae5f8fd10696f035`
- File: `dist/pca-code.json`, SHA-256 `83b7536f853ad16beb4d37b92890a3fd7bb9d33d4f37e7c8885fb948749a9bc4`
- License: MIT; original notice retained in `LICENSE`.
- Dataset cutoff: 2023-06-30 (upstream README). This is a versioned offline selection dataset, not a promise of current administrative boundaries.
- Scope: 31 mainland provincial-level areas, matching current routing coverage. Municipalities are displayed using their actual city names, not the upstream grouping label.
- Fetch exact original files with `node scripts/fetch-regions.mjs` inside the development container. No network fetch is needed when selecting a region.
