---
name: icon-creator
description: Turn a plain-language app description, or the user's own image file (PNG, JPEG, WebP, GIF, BMP, SVG), into a finished, cross-platform icon set - design or prepare the master, review it at real sizes with headless-browser renders, and export Windows .ico, macOS .icns, the Linux hicolor tree, web favicons and master files.
---

# Icon creator

You turn an application icon into the complete set: either you design it as
SVG (draw mode), or you prepare an image file the user brings (file mode, for
example a PNG made by an image generator). You render it with the user's own
browser, look at the result at working sizes, then export Windows `.ico`,
macOS `.icns`, Linux `hicolor` tree + `.desktop` snippet, web favicons +
manifest, and the master `icon-1024.png` (plus `icon.svg` when the master is a
vector drawing).

The tool is `node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs"`. It needs Node 18+
and a renderer (Chrome, Chromium or Edge; or resvg / rsvg-convert / inkscape /
magick). It never downloads anything and writes only the output you name plus
its own temporary scratch folder (see the last section).

## Workflow

**Paths and links.** This applies to every path you pass - the SVG or image you
read as well as the folder or file you write. A path may go through a symbolic link or junction
that is outside the current folder (macOS `/var`, `/tmp`, a linked project
folder, a Windows junction): the tool follows it once and prints a line starting
with `Note:` that names the real location - when you see one, tell the user where
the files really are (an input file's note names its folder). A file that is
itself a link is refused as an input. If a command is refused because a link lies INSIDE the
current folder, the error names the real path it points to: show that to the user
and run the command again with that path; do not look for a way around the
refusal.

### 1. Check the machine

Run `doctor` first. If it reports no renderer at all, stop and tell the user
exactly what to install (a browser is the best option); do not improvise.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" doctor

### 2. Question 0: draw the icon, or use the user's own image file?

Ask this ONE question alone, in its own `AskUserQuestion` call, before anything
else (the tool adds a free-text "Other" choice by itself):

**Should I draw the icon for you or use your own image file?** (header `Mode`).
Options: `Draw one for me` and `Use my image file`. Put into the question text:
"To use your own image, choose Other and type the path to the file."

What the answer means:

- `Use my image file` -> **file mode** (next section).
- Text typed into "Other" that is a path to an existing image file -> file
  mode, with that path. If it looks like a path (a drive letter, a slash or
  backslash, or an image extension) but no such file exists, say so and ask for
  the path again; do not guess.
- `Draw one for me`, or text typed into "Other" that is a description of an
  icon -> **draw mode** (the section after next); a typed description answers
  the "Which icon" question there.

**Skip question 0** when the command argument or the user's message already
decides it: it contains a path to an existing image file (PNG, JPEG, WebP, GIF,
BMP or SVG; check that it exists) -> file mode; it contains a description of an
icon -> draw mode.

## File mode: the user's own image

Exactly ONE icon, and the full set right away. Do not ask how many icons and do
not ask for approval first. You still look at the prepared result yourself and
run the mandatory 16 px check.

**F1. Get the path.** Use the path from question 0, the command argument or the
user's message; otherwise ask for it in a plain message. Never open anything
else: the only file you read for the user is this one image.

**F2. Ask ONLY the location question** in one `AskUserQuestion` call:
**Where should the folder with the icon set go?** (header `Location`). Options:
`Current folder` (a folder named `icons` is created here) and `A different
folder` (you then ask for the path in a plain message). Put into the question
text: "Or choose Other and type the path right here." `<root>` is `icons/` inside
the chosen folder (or the typed path itself when the user gave a path). The
layout is the same as in draw mode: `<root>/icon-work/` for the prepared master,
review sheets and check images, and the finished set in `<root>/<name>/`.

`<name>` (letters, digits, `-`, `_` only) is the app name when you know it (from
the user's words or the project folder), otherwise the image file's base name,
lower-cased, with every other character turned into `-`. Say which you chose.
`<title>` is the display name, for example `My App`.

**F3. Import: prepare the master.** Paths in the commands below are relative to
`<root>`; use the real path. Create `icon-work/` first.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" import "C:\art\my-logo.png" --out icon-work --name my-app

The tool detects the format from the file's content (PNG, JPEG, WebP, GIF first
frame, BMP or SVG; the extension is ignored), refuses directories, a file that
is itself a link, files over 25 MB and images over 8192 x 8192 px, and writes
`icon-work/my-app-master.png` (a square transparent PNG, 1024 px or smaller if
the image is smaller, never enlarged, a non-square picture centred without
stretching or cropping) and `icon-work/my-app-master.svg` (a wrapper around that
PNG: this is the file you give to `check`, `sheet`, `render` and `export`).

**If the file is an SVG, everything about the raster master is different.**
`import` validates it by the normal SVG rules and copies it unchanged to ONE
file, `icon-work/my-app-master.svg` (no PNG, no background handling, none of the
warning codes below). It is a real vector source, so the set is exported like a
drawn icon: ALL files are written, including `icon.svg`, `web/favicon.svg` and
`linux/scalable/apps/<name>.svg`, and a hand-drawn small variant is possible
(see F5). If the validator rejects it, show the user its error list and offer
to redraw it in draw mode or to use another file. In F4 to F7 below, the
statements about a raster master apply only to PNG, JPEG, WebP, GIF and BMP
sources.

Options (only when needed): `--background auto|keep|remove` (default `auto`:
a picture whose corners are already transparent is kept; four opaque corners of
nearly one colour mean a plain background that is removed by a flood fill from
the edges, which keeps light areas enclosed inside the motif; anything else is
kept with a warning) and `--tolerance 0-120` (how different from the background
colour a pixel may be and still count as background, default 32), plus `--force`
to replace an earlier import.

Read ALL of the printed output. It states measured facts (format, size, whether
it was padded, corner alpha before and after, the percentage made transparent,
the 16 px figures) and a list of warnings. Relay every warning to the user in
plain words in your final message. The warning codes mean:

- `low-resolution`: the source is under 512 px, so the large sizes are enlarged
  and soft; small sizes are fine.
- `heavy-padding`: the artwork's box covers under a quarter of the canvas area
  (less than half of the width and height together; a long thin motif counts);
  suggest cropping the image to the artwork.
- `touches-edge`: no margin around the artwork; macOS and Android launchers may
  crop or shrink it.
- `removal-heavy`: background removal made over three quarters of the picture
  transparent; check that a light motif was not eaten.
- `background-uncertain`: opaque, non-uniform corners (a photo or gradient);
  the background was kept.
- `opaque-corners`: the corners are still opaque; the export will refuse such a
  master until the background is removed or another image is used.
- `mush-16`: see the 16 px test below.

**F4. Look at it.** One sheet shows the master at 256/64/32/16 px on a white and
on a near-black background; read the PNG:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" sheet icon-work/my-app-master.svg --out icon-work/sheet-1.png

Check on BOTH backgrounds: the background is gone and no light or dark halo
rings the motif; the motif is not cut or eaten (including pale parts); enclosed
areas that should be see-through are not accidentally solid. If the removal is
wrong, run `import` again with a different `--background` or `--tolerance` and
`--force`, then look again - at most three rounds, and say which round you
stopped at. Do not edit the picture any other way.

**F5. The 16 px test (mandatory, never skip).**

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" check icon-work/my-app-master.svg --out icon-work/check-1.png

Read `check-1.png` (48/32/16 px on both backgrounds) and weigh the printed
measurements together with the import warnings. A raster image cannot get a
hand-drawn small variant, so there is no `--small` step for a raster source (an
SVG source can: draw `icon-work/small.svg` as in D5 and re-check with
`--small`). If the 16 px row reads, go on to F6 and say what you saw. If it is
mush (a `mush-16` warning, an invisible motif, or you cannot make out the
motif), do NOT export yet: tell the user plainly and offer exactly these
options in one `AskUserQuestion` call (header `16 px`): `Accept it as it is`, `I
will supply a simpler image` (they give a new file; go back to F3 with it),
`Draw one for me instead` (switch to draw mode with the same location and
name). Follow the answer.

**F6. Export the set** into its own folder under `<root>`:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" export icon-work/my-app-master.svg --out my-app --name my-app --title "My App"

Optional `--only windows,macos` (subset of master/windows/macos/linux/web) and
`--force`. The command prints every file it wrote - reuse that list verbatim in
your summary. When the master is a raster (PNG, JPEG, WebP, GIF, BMP source),
the export does NOT write `icon.svg`, `web/favicon.svg` or
`linux/scalable/apps/<name>.svg` (a vector file made of an embedded picture
would be a lie) and `head.html` does not link a favicon.svg; it prints which
files were skipped, and you must say so in your summary. For an SVG source it
writes every file and skips nothing. If the export refuses with an "opaque background" message, the corners
are still opaque: explain, and offer a background removal or another image
(back to F3).

Every command that writes a file refuses to replace an existing one unless you
pass `--force`: use new names (`sheet-2.png`, `check-2.png`) or add `--force`.

**F7. Summary.** Finish with the section "Tell the user what exists and how to
wire it" below, and include: what the tool measured and any warning (in plain
words), what you saw on the light and the dark background and at 16 px, for a
raster source that no vector files exist for this set and which were skipped,
and where `icon-work/` is (it holds the prepared master and the review images;
the user may delete it).

## Draw mode: you design the icon

### D1. Ask the four intake questions (and a fifth when N is 2 or more)

Ask the user these four questions in ONE `AskUserQuestion` call (the tool
adds a free-text "Other" choice to every question by itself). Skip a question
the user already answered in their request or in the command argument, and ask
only the rest. Use exactly these questions and options:

1. **Which icon should I create?** (header `Icon`). Options: `From this
   project` (design it from the project in the current folder) and `Random icon`
   (you pick the subject). Put into the question text: "To describe the icon
   yourself, choose Other and type the description."
2. **Where should the folder with the icon set go?** (header `Location`).
   Options: `Current folder` (a folder named `icons` is created here) and `A
   different folder` (you then ask for the path in a plain message). Put into
   the question text: "Or choose Other and type the path right here."
3. **How many different icons should I create?** (header `How many`). Options:
   `1`, `2`, `3`, `4`. Put into the question text: "For any other number,
   choose Other and type it." Accept up to 8; for a bigger number ask the user
   to pick fewer.
4. **Show the icons for approval first?** (header `Approval`). Options: `Make
   the full set right away (Recommended)` and `Show me the icons first`
   (previews only; the full set is built after the user approves).

**The fifth question - only when the answer to "How many" is 2 or more.** Ask it
in a SECOND `AskUserQuestion` call, after the four answers are in (one call can
hold at most four questions, and this one depends on an answer):

5. **How should I make the different icons?** (header `Method`). Options:
   `One by one in this conversation (Recommended)` - description: "Simpler and
   cheaper in tokens: I design the icons myself, one after another." and `In
   parallel, one subagent per icon` - description: "Faster, but uses more tokens:
   one helper per icon works at the same time, and I check every result myself."

Skip it when N is 1, or when the user already said how ("in parallel", "with
subagents", "one by one") - then simply follow what they said. "One by one"
means the normal workflow below (D2 to D6). "In parallel" means the "Parallel
mode" section after D6 instead of D2 to D6. File mode never asks this: it always
makes exactly one icon.

What the answers mean:

- **From this project:** read the README and the manifest or project file of the
  current folder (package.json, a `.csproj`, pyproject.toml, Cargo.toml and so
  on) and the folder name; write down in one line what the app is and who uses
  it, and say so. If the folder is not a recognisable project, say that and ask
  the user to describe the icon.
- **Random icon:** choose one simple, nameable subject yourself (an animal, an
  object, a shape pairing), say what you chose, and use `random-icon` as the
  name.
- **The user's own description:** use it as written.
- **Location:** `<root>` is `icons/` inside the chosen folder (or the typed path
  itself when the user gave a path). Everything this workflow writes lives under
  `<root>`:
  `<root>/icon-work/` (editable SVG sources, contact sheets, check images),
  `<root>/preview/` (only when the user wants to approve first) and one
  folder per finished set, `<root>/<name>/` when one icon was asked for or
  `<root>/<name>-1/`, `<root>/<name>-2/` and so on for several. (In parallel
  mode the scratch folders are `<root>/icon-work/<k>/`, one per icon.)
- **Number:** N different icons means N concepts with different motifs, not N
  recolours of one idea.

Everything else (palette, container shape, monogram or not) you decide
yourself: state the choices in one line ("defaulting to a rounded-square
container, indigo base, no text") and do not ask.

### D2. Draw the concepts as SVG files

(One by one, in this conversation. If the user chose parallel mode, skip D2 to D6
and follow "Parallel mode" after D6.)

Draw N concepts (N from the "How many" question; with N = 1 draw the one icon). Write each to
`<root>/icon-work/` (create it) as `concept-a.svg`, `concept-b.svg`, ... Each
concept is one standalone `.svg` file that follows every rule below - the tool
rejects files that break the hard ones. Paths in the commands below are
relative to `<root>`; use the real path.

**Hard rules (enforced by the tool, so obey them on the first try):**

- Square canvas: `viewBox="0 0 256 256"` (any square size works).
- Self-contained: no external references at all. Gradients and `url(#...)`
  inside the file are fine; `href`/`src`/`url()` pointing at files or web
  addresses, every non-raster `data:` URL (SVG embedded through data: is
  never inspected - only png/jpeg/gif/webp/bmp data: images are allowed),
  `<script>`, event handlers, `<foreignObject>` and DOCTYPEs are rejected.
- Draw letters as paths. `<text>` and `<tspan>` are rejected: a renderer
  without the right font produces garbage. At most one bold monogram, and
  only if it reads at 16 px.

**Design rules (your checklist - every concept must pass all eight):**

1. **One shape, one idea.** A single motif a stranger can name in one word.
2. **Fill over line.** Solid forms; any stroke at least 12 units wide at a
   256 viewBox (5%). Hairlines vanish at 16 px.
3. **Silhouette contrast.** Squint: the motif must stay obvious against the
   container. Light motif on dark container or the reverse.
4. **A container that fills the frame** - rounded square or circle with
   6-12 units of padding per side at 256 - and the motif covering roughly
   60-70% of the container.
5. **Two colours, three at most:** one dominant colour plus one accent.
6. **Flat or subtly dimensional.** One soft gradient is plenty; no shadows,
   no glow, no photo effects, no fake 3D.
7. **Reads at 16 px** - verified below, not assumed.
8. **No text except one bold monogram.**

A safe skeleton to start from (replace the placeholder rect with a motif
150-160 units wide, centred in the container, in high contrast to it):

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3730A3"/>
      <stop offset="1" stop-color="#0EA5E9"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="236" height="236" rx="52" fill="url(#bg)"/>
</svg>
```

### D3. Look at the concepts side by side

Pass exactly the concept files you created - two concepts, two arguments;
three concepts, three (with one concept, pass the one file):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" sheet icon-work/concept-a.svg icon-work/concept-b.svg --out icon-work/sheet-1.png

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" sheet icon-work/concept-a.svg icon-work/concept-b.svg icon-work/concept-c.svg --out icon-work/sheet-1.png

Read the PNG. The sheet shows every concept (columns, in your argument order)
at 256, 64, 32 and 16 px, first on a white background, then on near-black.
Judge with the checklist and drop or redraw a concept that clearly fails it.
Do not merge concepts into a Frankenstein.

**If the user chose "Show me the icons first":** make one 512 px preview PNG per
concept and stop there. The preview folder holds only these pictures:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" render icon-work/concept-a.svg --size 512 --out preview/icon-1.png

(`icon-2.png`, `icon-3.png`, ... for the others; create `preview/` first). Tell
the user the full path of the preview folder and ask which of the pictures to
build into a full set (one, several or all) and whether anything should change.
Wait for the answer. Then continue with steps D4 to D6 and the final summary for the approved concepts
only, applying the requested changes first.

**If the user chose the full set right away:** do steps D4 to D6 and the final summary for every
concept without waiting.

### D4. Refine each icon you build (at most three rounds)

Edit the SVG, then either re-run `sheet` on it alone or `render` at 256 to look
closer:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" render icon-work/concept-a.svg --size 256 --out icon-work/look.png

Stop as soon as the icon passes the checklist at 256 px - or after three
refinement rounds, whichever comes first. Say which round you stopped at.

### D5. The 16 px test (mandatory, never skip)

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" check icon-work/concept-a.svg --out icon-work/check-1.png

Read `check-1.png` (48/32/16 px on both backgrounds) and weigh the printed
measurements (corner transparency, visible ink, ink box). If the 16 px row
is mush:

- first simplify the motif (fewer parts, thicker strokes, larger shape);
- if simplifying would ruin the 256 px design, draw a dedicated small
  variant (bolder, fewer details, same palette) as `icon-work/small.svg`
  and re-check with
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" check icon-work/concept-a.svg --small icon-work/small.svg --out icon-work/check-2.png`.

The small variant replaces the master only at 16-32 px during export; that is
normal and expected for detailed icons. Iterate the check until the 16 px row
reads, but again at most three rounds.

### D6. Export the set

Export each finished icon into its own folder under `<root>` (the folder
layout is in D1). The `--name` becomes every file name (letters, digits,
`-`, `_` only); use the app name, or `random-icon` for a random icon.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" export icon-work/concept-a.svg --out my-app --name my-app --title "My App"

With several icons use `--out my-app-1`, `--out my-app-2` and so on. Optional
flags: `--small icon-work/small.svg` (use the small variant for 16-32 px),
`--only windows,macos` (subset of master/windows/macos/linux/web), `--force`
(overwrite). The command prints every file it wrote - reuse that list verbatim
in your summary.

Every command that writes a file refuses to replace an existing one unless
you pass `--force`, and `export` also refuses to write into a non-empty
folder without it - so if a step needs to redo an output, either use a new
file name (preferable: `sheet-2.png`, `check-2.png`) or add `--force`.

### Parallel mode: one subagent per icon

Only when the user chose `In parallel, one subagent per icon` (draw mode, N of 2
to 8). Nothing is shared between icons: icon k works in `<root>/icon-work/<k>/`
(`k` = 1 to N) and its set goes to `<root>/<name>-<k>/`. Use the same `<name>`
for every icon (the app name, or `random-icon`) and `--out <root>/<name>-<k>`.

**P1. Decide the motifs yourself first.** Write N clearly different motifs, one
line each (for example "a hot-air balloon", "a lighthouse", "a paper plane"), so
the subagents cannot converge on the same idea. For "From this project" read the
project first (as in D1) and derive N different motifs from it; for "Random
icon" choose N unrelated subjects. Tell the user the list. Create
`<root>/icon-work/` and one folder per icon, `<root>/icon-work/<k>/`.

**P2. Start ONE subagent per icon, all in the same message**, so they run in
parallel (N calls of Claude Code's Agent tool in a single response). The agent
type is `icon-creator:icon-designer` (this plugin's agent). Each prompt must
contain, in plain words:

- the app description and style choices (container shape, palette hint) you
  decided in D1;
- THAT agent's motif and its number `k`, and the sentence "other agents draw
  different motifs; do not change yours";
- `root`, `name`, `title`, and the mode: `preview` when the user chose "Show me
  the icons first", otherwise `full`;
- the real path of the tool script (the expanded value of
  `${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs`), because the agent may not see the
  variable expanded;
- the rule that it writes ONLY inside `<root>/icon-work/<k>/` and, in `full`
  mode, `<root>/<name>-<k>/`.

The agent already knows the hard rules, the eight design rules, the exact tool
commands and the report format; repeat none of that unless you want to change it.

**P3. In approval mode** (`preview`): each agent draws its SVG, runs the 16 px
check and renders `<root>/icon-work/<k>/preview.png` (512 px), then stops. When
all have returned: copy the previews to `<root>/preview/icon-<k>.png` (create
`preview/`; plain file copies with `cp` or `Copy-Item`), build ONE combined
contact sheet of all concepts and read it:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs" sheet icon-work/1/concept.svg icon-work/2/concept.svg --out icon-work/sheet-1.png

(one argument per icon, in order). Tell the user the full path of the preview
folder and ask which pictures to build into a full set (one, several or all) and
whether anything should change. Wait for the answer. Then start one NEW
subagent per approved icon, again all in one message, with mode `full`, the
existing `<root>/icon-work/<k>/concept.svg` as the starting point and the
requested changes.

**P4. In full-set mode** (`full`): each agent also exports its set to
`<root>/<name>-<k>/` and reports the files the export printed.

**P5. Check what came back yourself - never trust a report alone.** After the
subagents return, for every icon: read its report, then open its images with
the Read tool (`<root>/icon-work/<k>/check-1.png`, and `icon-1024.png` or
`preview.png`), look at the printed numbers in the report, and confirm that the
files the report lists exist (list the folders). If a report and the image
disagree, or an icon is missing or fails the 16 px test, say so plainly and fix
that icon yourself one by one (D2 to D6 for that single icon) instead of
shipping it. Then tell the user, per icon: the motif, the folder, the files, the
warnings or `Notes:` the check printed, and what you saw. End with the wiring
instructions below.

## Tell the user what exists and how to wire it (both modes)

List the files that were actually written and the full path of `<root>`, then
give the wiring line(s) for the user's project type (ask if you cannot tell).
`<set>` is the exported folder, for example `icons/my-app`:

- **.NET / Avalonia / MAUI (csproj):** `<ApplicationIcon><set>\windows\my-app.ico</ApplicationIcon>`
  (MAUI also accepts an SVG via `<MauiIcon Include="<set>\icon.svg" />`).
- **macOS (Xcode):** add `<set>/macos/my-app.icns` to the bundle Resources and
  set `CFBundleIconFile` to `my-app.icns` in `Info.plist`.
- **Linux:** copy `<set>/linux/hicolor/` to `~/.local/share/icons/` (or
  `/usr/share/icons/`) and `<set>/linux/my-app.desktop` to
  `~/.local/share/applications/`; the file's comments explain the rest.
- **Electron:** `win.icon` -> `<set>/windows/my-app.ico`, `linux.icon` ->
  one of the hicolor PNGs, `mac.icon` -> `<set>/macos/my-app.icns`.
- **Tauri:** `bundle.icon` in `tauri.conf.json` takes PNG, ICNS and ICO files
  only: list `<set>/linux/hicolor/32x32/apps/my-app.png`,
  `<set>/linux/hicolor/128x128/apps/my-app.png`,
  `<set>/linux/hicolor/256x256/apps/my-app.png` (Tauri's 128x128@2x),
  `<set>/macos/my-app.icns` and `<set>/windows/my-app.ico`. The scalable SVG
  (`linux/scalable/apps/my-app.svg`, absent for a raster source) belongs to a
  Linux icon-theme install, not to this list.
- **Qt:** ship the SVG in a resource file and `QIcon(":/my-app.svg")`.
- **Python GUI (tkinter/PySide/wx):** `iconphoto`/`setWindowIcon` with
  `<set>/icon-1024.png` (or `<set>/web/icon-512.png`).
- **Web:** paste `<set>/web/head.html` into the page `<head>` and copy the
  `web/` folder to the site root.

A set built from the user's own raster image has no `icon.svg`, no
`web/favicon.svg` and no `linux/scalable/apps/<name>.svg`. Where a line above
names one of those files, use the PNGs instead: `<set>/icon-1024.png` for
MAUI (`<MauiIcon Include="<set>\icon-1024.png" />`) and Qt (`QIcon` from the
PNG); the Tauri line above already uses PNGs, and the web `head.html` already
omits the SVG link.

Keep the `icon-work/` folder - it holds the editable SVG sources (draw mode) or
the prepared master and review images (file mode) the user may want later - and
say the user can delete it (and `preview/`).

## What this tool will never do

No network requests, no telemetry, and it never overwrites an existing file
without `--force`. It reads no user files beyond the SVGs you point it at and
the one image file the user named for `import` (a regular file that is not
itself a link, at most 25 MB and 8192 x 8192 px, format detected from the content,
metadata not interpreted, nothing in it executed or fetched; for JPEG, WebP
and BMP the headless browser opens that one file as a picture to decode it);
it does read back what it generated itself (rendered PNGs and the temporary
files used to verify them). It writes the output folder you name plus a
scratch subfolder of the OS temp dir (temporary HTML, a throwaway browser
profile, intermediate PNGs). Commands may run at the same time (parallel mode
starts one subagent per icon): every command has its own scratch folder and
writes only where it was told. That scratch folder is removed when the command
finishes; the removal is best effort, so a browser that still holds a file
can leave the folder behind in the temp dir, where it is safe to delete.
