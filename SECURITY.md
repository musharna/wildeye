# Security

wildeye is a static site. The hosted build on GitHub Pages is HTML, JavaScript and data files; there is no server-side code and no API key in the browser. Basemap tiles (Esri, OpenStreetMap) and terrain (Re:Earth) are fetched keyless.

## Reporting a vulnerability

Please do not open a public issue for anything exploitable. Contact the maintainer through the [GitHub profile](https://github.com/musharna), or open an issue asking for a private channel without the details. Include steps to reproduce and the impact.

## Keys

The scripts in `pipeline/` download data from sources that need an account (for example Movebank, GBIF, NEON, Copernicus Marine). Their credentials live in `~/.config/wildeye/env` (mode 600) on the machine that runs the pipelines. They are never committed and never reach the browser. `.env` files are gitignored, and the dev server refuses to serve them.

## Local dev server

`npm run dev` binds to `localhost` and accepts only local host names. `HOST=0.0.0.0 npm run dev` opens it to your network; it serves the same static app, with no proxies or keys behind it.
