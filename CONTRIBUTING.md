# Contributing to wildeye

Use Node.js 24.14.x or 26.x (enforced by `package.json`).

```bash
npm ci
npm run seed
npm run dev
```

Before sending a pull request against `main-wildeye`, run `npm run build` and `npm test`; if you
touched a pipeline, also run `python -m pytest pipeline/tests`. `CLAUDE.md` sets the bar for tests.

- Each map layer is one module in `src/data/<layer>.js` with `init/enable/disable/update/destroy/getStats`.
  Use an existing layer as a template.
- Each data source gets a script in `pipeline/` that writes a plain file to `public/data/`. API keys
  stay on the machine that runs it.
- A new or changed source needs an entry in `DATA_SOURCES.md` with its licence and required credit.
  Leave out data whose terms don't allow redisplay.
- Record user-visible changes in `CHANGELOG.md`.

Contributions are licensed under the project's MIT licence (`LICENSE`).
