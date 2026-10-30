# Folder mode: the details

Read with the "Folder mode" section of `SKILL.md`. The commands are `ingest`, `build` and `sheet` of
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pack.mjs"`, all inside one run folder (`<root>/candidates/`). Nothing existing is ever overwritten without `--force`, and a later round never needs it.

## What `ingest` prints

One JSON object:

- `run`: the real path of the run folder. Use it as `<run>` in every later command. When the folder or the run path
  you passed goes through a link outside the current folder, a line starting with `Note:` (on stderr) names the real
  location; a link inside the current folder is refused with the real path to pass instead.
- `counts`: the totals of `added`, `skipped`, `already`, `notTaken`, `ignored` and `subfolders`. Each of those
  lists shows at most 50 entries, so a folder of thousands of files stays readable; say the totals.
- `added`: one entry per new candidate: `candidate` (the number k), `file` (`candidate-<k>.png`), `source` (the picture
  it came from), `size` (the picture's own size), `stored` (the size kept, at most 1024 px on the longer side),
  `decodedBy`, and `note` for an animated GIF (only its first frame is used).
- `skipped`: files that did not become a candidate, each with its reason. Relay every one in plain words:
  - not a supported picture (a document, a text or HTML file, a damaged file): name it; of such a file only its
    first 4 KB were read;
  - too small (under 64 px on the longer side): it cannot make an icon master;
  - an SVG: it is already a drawing; offer file mode for it (`icons.mjs import`), which keeps it a true vector. A
    folder that holds only SVGs takes nothing in: say why and offer file mode for the one the user wants;
  - "needs a headless browser" (a WebP or BMP on a machine without Chrome, Chromium or Edge): install one of them or
    save the picture as PNG, then run `ingest` again;
  - "the same picture as ...": an identical file (same bytes) is taken once;
  - a link or not a regular file: not followed, never opened.
- `already`: pictures already in this run (same bytes), with their candidate numbers. Normal in a later round.
- `notTaken`: more new pictures than one call takes (64). Build and sheet these first, then run `ingest` again for the
  rest; they are numbered on.
- `ignored` (hidden and system files such as `Thumbs.db`) and `subfolders` (never read): mention subfolders when the
  user may have expected their pictures to count.
- `recordProblems`: a damaged record file in the run folder (it is kept as it is and the new round gets the next free
  record number), or a run folder that holds candidate files but no record because an earlier `ingest` stopped half
  way (they are kept and the new candidates are numbered after them). Tell the user once. In the second case the same
  picture can be in the run twice, under an old and a new number: when you see two identical candidates on the sheets,
  name both numbers, treat them as one, and recommend the newer number (its record names the picture).

The command ends with an error, and writes nothing, when no picture could be taken in (the reasons are in `skipped`)
or when there is nothing new ("nothing new to take in: N pictures of that folder are already in this run"). It
refuses a run folder that holds other files (name a new or empty folder) and the picture folder itself as the run
folder. If writing fails half way (a full disk), the candidates written so far are recorded and the error says
which; run `ingest` again once the cause is fixed and it continues.

## What `build` and `sheet` do

Each candidate is cropped to its subject, which then fills 96 % of the square, so the picture stays readable at 32
and 16 px; `--fill <50-100>` changes that, `--no-crop` keeps the picture's own margins, `--keep-tile` keeps an opaque
tile as drawn. A plain background (four corners, or most of the border, of one flat colour) is removed; where a dark
outline meets the removed background the pale rim outside it is cleaned too (`--no-edge-clean` keeps it). The 16 to
48 px renderings get a light sharpening (`--no-sharpen` turns it off). The crop enlarges the picture's pixels a
little; that adds no detail.

`build` writes `pack-<k>/` per candidate: the Windows `.ico`, the macOS `.icns` (the slices the master is big enough
for; a master under 1024 px has no 1024 px slice, and the JSON names what was left out), the Linux hicolor tree and
`.desktop` entry, web favicons, `web/apple-touch-icon.png` (opaque, with a margin, as iOS needs),
`web/icon-maskable-512.png` (the picture inside Android's safe zone) and the master PNG `icon-<size>.png`. Sizes above
the master are never upscaled. `sheet` writes `sheet-<n>.png`, eight candidates per sheet, each on a checkerboard and
on a dark tile, with true-size 64, 32 and 16 px renderings under them. A candidate's number
on the sheet is the `<k>` of `candidate-<k>` and `pack-<k>`; a skipped number leaves a gap, never a shift.

`build` prints a short JSON summary: `skipped` first (candidates that got no pack, with the reason), then per
candidate `pack` (its folder), `master` (the master size), `warnings` (the codes below), `omitted` (how many sizes
were left out because the master is smaller) and `svgFit` (the SVG estimate: high, medium or low), and `detail`, the
file in the run folder (`build-1.json`, then `build-2.json`, ...) that holds everything else: the measured facts,
the full warning texts, every file written and every size left out. Read it only when you need one of those.
`sheet` prints the sheet files it wrote and its own `skipped`. Quote the per-candidate warnings that matter, not
every number:

- `background-uncertain`: the background is not one flat colour (a gradient, a photo), so it was kept and the icon is
  a filled tile. A flat but noisy colour (JPEG) is often removed with `--tolerance 60` (use `--variant`, see below).
- `opaque-corners`: the corners are still opaque; the icon works as a filled tile, not as a transparent glyph.
- `tile-recropped`: the picture was an opaque tile with the motif inside; the crop went to the motif, so the icon is
  now a full square of the tile's colour (`--keep-tile` keeps the tile as drawn).
- `enlarged`: the subject filled only a small part of the picture and was enlarged a lot; the largest sizes look soft.
- `fades-on-dark` / `fades-on-light`: the icon's edge melts into a dark or a light background (contrast below 2:1).
- `tiny-master`: the master is under 256 px; the large sizes were left out and the rest look soft.
- `nothing-visible`: nothing is left after background removal: an empty icon. Say so.

A candidate under `skipped` in the build or sheet JSON (a damaged file, or one that is a link) has no pack and no
place on the sheet: name it and say why.

## How to judge the sheets

Read every new `sheet-<n>.png` yourself. Judge, in this order:

1. **16 and 32 px legibility** (the small row of each block, at true size): is the silhouette still readable, or a
   blob? This is the ranking criterion.
2. **Silhouette at 128 px** on the checkerboard (light) and on the dark tile: does it survive both? The
   `fades-on-dark` / `fades-on-light` warnings say objectively when an outline melts into one of them.
3. **The background**: a candidate with `background-uncertain` or `opaque-corners` is a filled tile, not a
   transparent logo; say so before recommending it, and do not make it the top pick unless the user wants a tile.
   Name `tile-recropped` too.

Then, before the pick question, tell the user: your top two or three by **number**, each with the picture's file
name (from the ingest JSON) and one sentence of why tied to what you saw at 16 and 32 px; where everything is (the
run folder, the `pack-<k>/` folders, the sheet files);
the warnings that matter; and that every number on the sheet carries an SVG badge with three, two or one filled dots
(how well that picture should redraw as a true vector).

## Later rounds and another look

- **More pictures.** The user adds files to the same folder (or names another folder for the same app): run `ingest`
  with the same `--run`. Only new pictures are added, numbered after the others. Then
  `build --run "<run>" --only <new numbers>` with the same `--title` (the pack name of the run is reused) and
  `sheet --run "<run>" --only <new numbers>`, which writes NEW sheet files (`sheet-2.png`, ...) and leaves the earlier
  ones as they were. Tell the user which numbers are new and which sheet shows them.
- **Another look of the same candidates** (more or less room, no sharpening, a higher tolerance): never `--force`.
  Add `--variant <label>` (for example `fill90`) with the new options to both `build` and `sheet`: that writes
  `pack-<k>-<label>/` and `sheet-<label>-<n>.png` beside the old files.
- **"Make number N the final."** Nothing to build: `pack-N/` is the finished set. Go to G6 and G7.
- **"Make number N an SVG."** `references/svg-step.md`.
- **A different app.** A new run folder (`<root>/candidates-2/` or another location); never mix two apps in one run.
