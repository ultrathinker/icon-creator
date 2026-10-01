# Icon Creator (Claude Code plugin)

[![ci](https://github.com/ultrathinker/icon-creator/actions/workflows/ci.yml/badge.svg)](https://github.com/ultrathinker/icon-creator/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Describe your app in one sentence, or bring an image you already have; get a
reviewed, ready-to-wire icon set for Windows, macOS, Linux and the web. The
plugin's skill either has Claude draw SVG concepts or prepares your own image
file (a PNG from an image generator, a JPEG, a WebP...), renders it with the
browser you already have, looks at it at real sizes (down to 16 px), and then a
deterministic script exports every file your project needs. Nothing is
downloaded and no packages are installed: the whole toolchain is Node 18+
standard library plus a local renderer.

    /icon a timer app for focus sessions
    /icon C:\art\my-logo.png

## Install

In Claude Code:

    /plugin marketplace add ultrathinker/icon-creator
    /plugin install icon-creator@icon-creator

Then restart the session (or run `/reload-plugins`) and ask for an icon, or run `/icon-creator:icon`.
You need Node 18 or newer and one of Chrome, Chromium or Edge; see "Requirements and limits" below.

## What lands in your output folder

| Target | Files |
|---|---|
| Windows | `windows/<name>.ico` - PNG entries at 16, 24, 32, 48, 64, 128, 256 |
| macOS | `macos/<name>.icns` - PNG entries 16-1024 px including all retina chunks |
| Linux | `linux/hicolor/<N>x<N>/apps/<name>.png` (11 sizes), `linux/scalable/apps/<name>.svg`, `linux/<name>.desktop` |
| Web | `web/favicon.ico` (16/32/48), `web/favicon.svg`, `web/apple-touch-icon.png` (180), `web/icon-192.png`, `web/icon-512.png`, `web/site.webmanifest`, `web/head.html` |
| Master | `icon.svg` (editable source) and `icon-1024.png` (transparent) |

A dedicated simplified variant can be supplied for the 16-32 px sizes, so a
detailed 256 px icon and a readable 16 px icon can coexist.

When the set is built from your own raster image (PNG, JPEG, WebP, GIF, BMP;
an SVG file keeps every vector file) there is no honest vector
source, so `icon.svg`, `web/favicon.svg` and `linux/scalable/apps/<name>.svg`
are **not** written (the export says so) and `head.html` does not link a
favicon.svg. Everything else is produced as above.

## Two ways in: draw it or bring it

The first question, asked alone, is **"Should I draw the icon for you or use
your own image file?"** (typing a file path as the answer counts as choosing
the file). It is skipped when your command or message already contains a path
to an image file or a description of an icon.

- **Use my image file:** one more question (where to put the folder), then
  exactly one icon and the full set right away - no "how many", no approval
  step. The skill still looks at the prepared result on a light and a dark
  background, runs the 16 px check, and tells you what it saw and any warning.
  See "Your own image" below.
- **Draw one for me:** the four questions and the design loop below. When you
  ask for two or more icons, a fifth question follows: make them **one by one**
  in the conversation (the default: simpler, fewer tokens) or **in parallel, one
  subagent per icon** (faster, more tokens). See "Several icons at once" below.

## How the design loop works (draw mode)

1. **Four questions** (one multiple-choice prompt): which icon (from the current project, a random one, or your own
   description), where to put the folder, how many different icons, and whether to approve previews first or get
   the full set right away. Everything else gets sensible defaults, stated out loud.
2. **Concepts:** as many different SVGs as you asked for, drawn against a checklist of eight rules (one motif,
   fill over line, squint contrast, container with padding, 2-3 colours, flat
   shading, no text, square viewBox with no external references).
3. **Contact sheet:** all concepts at 256/64/32/16 px on white and near-black,
   rendered by headless Chrome/Edge - Claude actually looks at the PNG and
   judges.
4. **Refine:** at most three rounds on the winner.
5. **The 16 px test:** a check sheet at 48/32/16 px plus printed measurements
   (corner transparency, ink coverage, ink box). Simplify or add a small
   variant until it reads.
6. **Export:** the command above, plus wiring instructions for your project
   type (.NET `<ApplicationIcon>`, `Info.plist`, Electron/Tauri config,
   `.desktop`, HTML head).

## Several icons at once

For two to eight different icons the skill can start one Claude Code subagent per
icon (the plugin ships the agent `icon-designer`, limited to Read, Write, Edit,
Bash, Glob and Grep). The main conversation first picks N clearly different
motifs so the agents cannot converge on one idea, then starts all agents in one
message. Each agent works only inside its own folders: `icons/icon-work/<k>/`
(SVG, sheets, checks) and, when the full set is wanted, `icons/<name>-<k>/`. With
"show me the icons first" each agent stops at a 512 px preview; the main
conversation copies the previews into `icons/preview/`, builds one combined
contact sheet and waits for your approval. Afterwards the main conversation
reads every agent's report and opens its result images itself before telling
you what was made, per icon. The restriction to an agent's own folder is an
instruction, not a sandbox. The tool itself is safe to run concurrently: every
command has its own scratch folder and browser profile.

## Your own image

    node scripts/icons.mjs import my-logo.png --out icons/icon-work --name my-app

`import` accepts PNG, JPEG, WebP, GIF (first frame), BMP or SVG - the format is
detected from the file's content, never from its extension.

- **A raster file (PNG, JPEG, WebP, GIF, BMP)** becomes a prepared master in the
  folder you name: `<name>-master.png` (a square, transparent PNG, 1024 px or
  smaller if your image is smaller; never enlarged) and `<name>-master.svg`, a
  wrapper that embeds the PNG so that `check`, `sheet`, `render` and `export` work
  on it unchanged. A non-square picture is centred on a transparent square, never
  stretched or cropped; a bigger one is shrunk with an area filter. The set built
  from it has no vector files (see above).
- **An SVG file** is validated by the normal SVG rules and copied unchanged to one
  file, `<name>-master.svg`: no PNG, no background handling, no raster warnings.
  It is a real vector source, so the export writes every file, including
  `icon.svg`, `web/favicon.svg` and the scalable Linux icon, and a hand-drawn
  small variant is possible.

- **Background** (`--background auto|keep|remove`, default `auto`): `auto`
  keeps a picture whose corners are already transparent, removes a background
  when the four corners are opaque and nearly the same colour, and otherwise
  keeps it and warns. `remove` flood-fills from the image edges with a colour
  tolerance (`--tolerance`, default 32 of 255 per channel) and cleans the
  anti-aliased edge, so light areas enclosed inside the motif survive. `keep`
  leaves the picture alone.
- **Measured facts** are printed: source size and format, corner alpha before
  and after, the percentage made transparent, padding, and the 16 px result.
- **Warnings** are printed and relayed: a source shorter than 512 px (big sizes
  will be soft), heavy padding (judged by area, so a long thin motif counts),
  artwork touching the edge, background removal that ate most of the picture,
  opaque corners (every export target needs transparent corners, so the export
  refuses such a master), and a 16 px result that is mush.
- **Corrupt or truncated files are refused**, not turned into a blank or
  garbled master: PNG chunks are checked against their CRC, GIF data must
  produce every pixel, and JPEG, WebP and BMP files must be complete by their
  own structure (end marker, declared size, pixel rows); the browser must also
  report that it decoded the picture. A JPEG with damaged colour data inside an
  otherwise complete file is decoded by the browser as best it can and is not
  detectable without a full decoder - look at the result.

Honest limits of the raster route: it cannot get a hand-drawn small variant
(when 16 px fails the options are to accept it, supply a simpler image, or let
the icon be drawn as SVG instead); sizes above the source's own resolution are
enlarged and look soft; background removal is a flood fill for plain
backgrounds, not an AI matte, and will not rescue a photo or a gradient
background; EXIF and colour-profile metadata is not interpreted by the tool
(the browser that decodes JPEG/WebP/BMP may still apply an embedded colour
profile); an animated GIF contributes only its first frame.

## The script behind the skill

    node scripts/icons.mjs doctor   # what renderer exists, proven with a live render
    node scripts/icons.mjs import my-logo.png --out icon-work --name my-app
    node scripts/icons.mjs render icon.svg --size 32 --out x.png
    node scripts/icons.mjs sheet a.svg b.svg --out sheet.png
    node scripts/icons.mjs check icon.svg --out check.png
    node scripts/icons.mjs export icon.svg --out icons --name my-app

Rendering uses a headless Chromium-family browser (Chrome, Chromium, Edge)
found in standard install locations or on PATH; if none exists it falls back
to `resvg`, `rsvg-convert`, `inkscape` or `magick`. Contact sheets and
small-size checks are composed locally from those per-size renders, so every
renderer serves every command. Every render is verified
(pixel size and corner alpha) before it is used, and each size is rendered
from the vector source - never downscaled from a big raster. The ICO and ICNS
containers are written by this repository's own code from the published
format specifications and verified by its own parsers plus a test suite.

## Requirements and limits

- **Node 18 or newer** and one renderer: Chrome, Chromium, Edge, resvg,
  rsvg-convert, Inkscape or ImageMagick. No npm packages, ever.
- Browsers are launched headless with a throwaway profile under the OS temp
  dir; command-line renderers are invoked directly with the input and output
  paths. No window ever opens.
- SVG input (drawn by Claude or supplied by you) must be self-contained: square viewBox,
  no scripts, no external or file references, `data:` URLs limited to raster
  image types (png/jpeg/gif/webp/bmp - embedded SVG is rejected), and no
  `<text>` elements (the tool checks and refuses, on a copy with XML entities
  and CSS escapes decoded, so obfuscated spellings do not slip through).
  Malformed markup (unterminated comments, stray `<`, processing
  instructions other than the XML declaration, a second root) is refused, and
  so is a render that comes out completely blank.
  Letters must be drawn as paths. Every render must come out with transparent
  corners - full-bleed square icons are rejected with a fix hint, because the
  containers expect a transparent background.
- Raster input goes through `import` only. PNG and GIF are decoded by this
  repository's own code; JPEG, WebP and BMP are decoded by the headless browser
  (so those three need Chrome, Chromium or Edge). Limits: 25 MB per file and
  8192 x 8192 px, checked from the file header before anything is decoded. The
  file must be a regular file reached through real directories (links and
  junctions are refused). Nothing inside the image is executed or fetched.
- The tool writes only inside the output folder you name (plus its own
  subfolder of the OS temp dir for scratch), never follows symbolic links or
  junctions below the output root, and never overwrites an existing file
  without `--force` (all write commands accept it). `export` additionally
  refuses to write into a non-empty folder without `--force`, and the
  `render`/`sheet`/`check` output path must not pass through a symbolic link
  (give the real path instead).
- `.icns` output is built to the published Apple format but was not
  hand-verified inside Xcode on macOS here; `.ico` and the PNG tree were
  verified with independent tooling (Pillow) on Windows.
- **Platforms:** developed and verified by running on Windows 11 (Chrome 154
  and Edge). macOS and Linux renderer discovery and path handling are covered
  by unit tests against simulated file systems but were not run on those
  platforms here.
- The plugin never makes network requests, never reads environment variables
  beyond the standard program lookup `PATH`, and has no telemetry. The only
  files it reads are the SVGs and the one image file you name, plus what it
  generated itself. See [PRIVACY.md](PRIVACY.md).

## Development

    node --test "tests/*.test.mjs"   # 180 tests: containers, discovery, export, SVG intake, image import, real renders

(The glob keeps the run scoped to this folder's tests even if other
`*.test.mjs` files exist elsewhere in the tree.)

Real-render tests skip with a message when no renderer is available. The test
suite is the reason you can trust the binary writers: they are round-tripped
through the parsers on every run.

## License

MIT - see [LICENSE](LICENSE). The license is provisional pending the owner's
confirmation before publication.
