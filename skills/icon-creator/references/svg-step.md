# Folder mode: redraw the chosen candidate as an SVG

Only when the user asks for it, for ONE candidate, after the pick (G6 of `SKILL.md`). Never start it on your own and
never ask a question to start it.

The pack of a candidate is made of pixels. When the user wants it as a true vector (`icon.svg`, a favicon that stays
sharp at any size, and the whole set rebuilt from the drawing), you draw it. Say plainly what it is: **a redrawn copy,
not the picture traced.** You measure the picture, draw flat shapes by those numbers and compare your drawing with
it. The result is cleaner (a solid outline, exact curves, symmetric) and differs from the picture by a few pixels along
the edges; soft shadows, glows and gradients are not reproduced. The candidate file and `pack-<k>/` are never
changed: the vector pack is a new folder.

**The sheet's badge** ("SVG" with three, two or one filled dots), `svgFit` in the build summary and `facts.svgFit` in
the build's detail file `build-<n>.json` (`level`, `score`, `reasons`) say how well a candidate should redraw: flat
colours, few of them and a dark outline score high; soft shading, glow and gradients score low. It is an estimate,
measured from the picture, not a promise. Name the level and the reasons first; when
the user picks a low one, say once that it will likely not come out faithful, and go on if they still want it.

The script is `node "${CLAUDE_PLUGIN_ROOT}/scripts/svg.mjs"`. Pass the same `--fill`, `--no-crop`, `--keep-tile`,
`--tolerance` or `--no-edge-clean` the pack of that candidate was built with, so the master is the same picture (by
default none).

1. **`doctor`** first. Drawing and checking need a renderer: Chrome, Edge or Chromium (or resvg, rsvg-convert,
   inkscape, magick). If none is found the command says what to install: pass that on and stop.

       node "${CLAUDE_PLUGIN_ROOT}/scripts/svg.mjs" doctor

2. **Measure.** It prints the numbers to draw by: `viewBox` (draw on exactly this grid, the master's own pixels, y
   down), the shape's box, the flat colours (letter, hex, area share, box, centre), the mirror symmetry and scanlines:
   for nine rows and nine columns the runs of colour along them (`T` transparent, a letter is a palette colour). Ask
   for the lines you need with `--rows` and `--cols` (stripe edges, the width of an outline, where an eye starts).
   Measure more rather than guess, and look at the master image itself too (`pack-<k>/icon-<size>.png`).

       node "${CLAUDE_PLUGIN_ROOT}/scripts/svg.mjs" measure --run "<run>" --number 3 --rows 300,520 --cols 512

3. **Write the drawing** into the run folder as `svg-<k>-draft-<m>.svg` (a new `<m>` each time; never overwrite). A
   square `viewBox`, shapes and paths only (rect, circle, ellipse, path, polygon, line, g, defs, use, clipPath), flat
   fills from the palette, strokes for outlines, `<use>` or a mirrored group for symmetric halves. The checker refuses
   `<script>`, `<text>` (draw letters as paths), `<image>`, `<foreignObject>`, event handlers, `@import`, a DOCTYPE and
   any link outside the file. Keep it small (a few KB); a drawing that needs hundreds of paths has not understood the
   shapes.

4. **Check** draws it with the renderer and compares it with the master: `mismatchPercent`, how much is only in the
   master, only in the drawing, or a different colour, `verdict` (`close` up to 2 %, `near` up to 6 %, else `off`; a
   difference within a pixel or two of an edge of the master is only anti-aliasing and is counted apart as
   `softEdgePercent`) and `worstBlocks` (where, and what is wrong there). It writes `svg-<k>-check.png` (then
   `svg-<k>-check-2.png`, ...): master, drawing and the difference side by side (red: only in the master, blue: only
   in the drawing, orange: a colour differs). **Read that picture**, fix the worst blocks, write the next draft, check
   again. At most three rounds; stop sooner at `close`.

       node "${CLAUDE_PLUGIN_ROOT}/scripts/svg.mjs" check --run "<run>" --number 3 --svg "<run>/svg-3-draft-1.svg"

5. **Pack**, when the verdict is `close` or `near` and you judge the picture right (say what still differs), or the
   user accepts it. It builds `pack-<k>-svg/`: the whole set rendered from the vector at 1024 px (`.ico`, `.icns` with
   every slice, the Linux hicolor tree, web icons) plus `icon.svg`, `web/favicon.svg` and
   `linux/hicolor/scalable/apps/<name>.svg`, and a `head.html` that links the favicon. A second pack for the same
   candidate is `pack-<k>-svg-2`.

       node "${CLAUDE_PLUGIN_ROOT}/scripts/svg.mjs" pack --run "<run>" --number 3 --svg "<run>/svg-3-draft-2.svg" --name my-app --title "My App"

6. **Tell the user** where the pack is, which round the drawing is, the final mismatch and what the drawing leaves out
   (shadows, glow, fine detail), and that the raster pack is still there. If after three rounds it is still `off`,
   say so plainly, show what is wrong and keep the raster pack as the answer; do not build a pack from a drawing you
   would not use yourself. Then the wiring section of `SKILL.md`, with `<set>` = `<run>/pack-<k>-svg`.
