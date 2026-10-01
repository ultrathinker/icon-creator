# Privacy Policy

This plugin runs entirely on your machine and collects nothing.

- **Network:** it makes no network requests - no downloads, no updates, no
  telemetry, no analytics. The only URLs the renderer ever opens are local
  `file://` URLs of files you asked it to render; the SVG input itself may
  also carry internal `#fragment` references and supported raster `data:`
  URLs, which stay inside the file and are never fetched.
- **What it reads:** the SVG files you point it at, the one image file you
  name for the `import` command (a PNG, JPEG, WebP, GIF or BMP, up to 25 MB
  and 8192 x 8192 px; nothing else in its folder), the files it has just
  written (to verify them), and the standard `PATH` variable to find a
  renderer. It reads nothing else - no Claude data, no chat or session
  transcripts, no environment secrets. Metadata inside an image (EXIF,
  colour profiles, comments) is not interpreted by the tool.
- **What it runs:** the bundled Node scripts, and a renderer it finds on your
  machine (Chrome, Chromium, Edge, resvg, rsvg-convert, Inkscape or
  ImageMagick). Browsers are launched headless with a throwaway profile under
  the OS temp dir, and the tool ends the browser it started (with its helper
  processes) as soon as the screenshot is complete, or when the tool is
  interrupted; command-line renderers are invoked once per render with
  the input file and an output path. No window opens and no code from the SVG
  input is executed. To decode a JPEG, WebP or BMP you name, the headless
  browser opens that one file through its local `file://` URL and shows it as
  a picture (an `<img>` element) that is then screenshotted, together with a
  three-line script of this plugin that only reports whether the picture
  loaded; the image is never run, and nothing in it is fetched. PNG and GIF are decoded by the
  bundled scripts without a browser. (SVGs are rendered in the browser's image mode, where
  scripting is disabled, after static checks - a strict markup walk of the
  raw file that refuses malformed markup, then pattern scans on a copy with
  XML entities and CSS escapes decoded - reject scripts and external
  references outright).
- **What it writes:** the output folder you name (for `import`, the prepared
  master PNG and its wrapper SVG, which embeds your picture as a `data:` URL
  inside that file), and a scratch subfolder of
  the operating system's temp dir (browser profile and intermediate renders).
  The tool tries to remove that scratch folder when the command finishes, on
  a best-effort basis: if a browser is still releasing files the folder can
  remain in the temp dir, holding only scratch data that is safe to delete.
  It never overwrites an existing
  file unless you pass `--force`. When you follow the bundled skill, its
  workflow also creates a small `icon-work/` scratch folder (SVG concepts
  and review sheets) inside your project; it only ever holds the files the
  skill itself writes, and you can delete it when you are done.
- **Where to report problems:** open an issue at
  https://github.com/ultrathinker/icon-creator/issues.
