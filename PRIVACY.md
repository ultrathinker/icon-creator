# Privacy Policy

This plugin runs entirely on your machine and collects nothing.

- **Network:** it makes no network requests - no downloads, no updates, no
  telemetry, no analytics. The only URLs the renderer ever opens are local
  `file://` URLs of files you asked it to render; the SVG input itself may
  also carry internal `#fragment` references and supported raster `data:`
  URLs, which stay inside the file and are never fetched.
- **What it reads:** the SVG files you point it at, the one image file you
  name for the `import` command (a PNG, JPEG, WebP, GIF or BMP, up to 25 MB
  and 8192 x 8192 px; nothing else in its folder), in folder mode the
  pictures directly inside the folder you name for `pack.mjs ingest` (only
  that folder's own files, never its subfolders or links; names starting with
  a dot and the system files Thumbs.db, desktop.ini and .DS_Store are not
  opened; every other file there is opened to see whether it is a picture,
  and of one that is not, only its first 4 KB are read; the same limits per
  picture; your pictures are only read, never changed, moved or deleted), the
  files it has just written (to verify them), and the standard `PATH`
  variable to find a renderer. It reads nothing else - no Claude data, no chat or session
  transcripts, no environment secrets. Metadata inside an image (EXIF,
  colour profiles, comments) is not interpreted by the tool.
- **What it runs:** the bundled Node scripts, and a renderer it finds on your
  machine (Chrome, Chromium, Edge, resvg, rsvg-convert, Inkscape or
  ImageMagick). Browsers are launched headless with a throwaway profile under
  the OS temp dir, and the tool ends the browser it started (with its helper
  processes) as soon as the screenshot is complete, or when the tool is
  interrupted; command-line renderers are invoked once per render with
  the input file and an output path. No window opens and no code from the SVG
  input is executed. To decode a WebP or BMP you name (or one of the rarer
  JPEG variants the built-in decoder cannot read), the headless
  browser opens that one file through its local `file://` URL and shows it as
  a picture (an `<img>` element) that is then screenshotted, together with a
  three-line script of this plugin that only reports whether the picture
  loaded; the image is never run, and nothing in it is fetched. PNG, GIF and baseline JPEG are
  decoded by the bundled scripts without a browser. (SVGs are rendered in the browser's image mode, where
  scripting is disabled, after static checks - a strict markup walk of the
  raw file that refuses malformed markup, then pattern scans on a copy with
  XML entities and CSS escapes decoded - reject scripts and external
  references outright).
- **What it writes:** the output folder you name (for `import`, the prepared
  master PNG and its wrapper SVG, which embeds your picture as a `data:` URL
  inside that file; in folder mode the run folder you name, with a PNG copy of
  each picture of at most 1024 px, the packs, the contact sheets, the drawings
  and check images of the optional SVG step, and small JSON records that name
  the picture folder, each picture's file name and a SHA-256 of its bytes, so a
  later round takes in only new pictures, plus the names of the files that
  were skipped and why, at most 50; and `build-<n>.json` files with the
  measured facts of each pack), and a scratch subfolder of
  the operating system's temp dir (browser profile and intermediate renders).
  The tool tries to remove that scratch folder when the command finishes, on
  a best-effort basis: if a browser is still releasing files the folder can
  remain in the temp dir, holding only scratch data that is safe to delete.
  It never overwrites an existing
  file unless you pass `--force`. When you follow the bundled skill, its
  workflow also creates a small `icon-work/` scratch folder (SVG concepts
  and review sheets) inside your project, or in folder mode the run folder
  `icons/candidates/`; they only ever hold the files the skill itself writes,
  and you can delete them when you are done.
- **Synced folders:** if the folder you name is kept by a cloud service whose
  files are only placeholders on your disk, opening a file makes that service
  download it; the plugin itself sends and fetches nothing.
- **Where to report problems:** open an issue at
  https://github.com/ultrathinker/icon-creator/issues.
