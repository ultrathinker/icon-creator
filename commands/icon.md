---
description: Design a complete app icon set (Windows, macOS, Linux, web) from a description, build it from your own image file, or choose the best of a folder of your pictures
argument-hint: [optional: describe the icon, e.g. "a timer app for focus sessions", or give the path to your own image file or to a folder of pictures]
---

Create an application icon set with the `icon-creator` skill.

What the user gave, if anything (empty means: ask question 0 first):

$ARGUMENTS

Follow the `icon-creator` skill end to end. Start with its `doctor` check, then
its question 0, asked alone: "Should I draw the icon for you, use your own image
file, or choose from a folder of your images?" with the options `Draw one for
me`, `Use my image file` and `Choose from a folder of images`. Skip question 0
when the text above is already a path to an existing image file (file mode), a
path to an existing folder (folder mode) or a description of an icon (draw
mode).

- **File mode** (own image): ask only where to put the folder, run `import` to
  prepare the master (for a raster file background handling is automatic and
  reported; an SVG file is only validated and copied), look at the result on a
  light and a dark background, run the mandatory 16 px check, and export exactly
  one icon with the full set right away - no question about how many icons and
  no approval step. Tell the user what was measured and relay every warning. For
  a raster file (PNG, JPEG, WebP, GIF, BMP) say which vector files are not
  written because the master is a raster image; an SVG file keeps all of them.
- **Folder mode** (a folder of pictures): ask only where to put the folder, run
  `pack.mjs ingest` to take every picture in as a numbered candidate (relay every
  skipped file with its reason), `build` a finished pack for every candidate and
  `sheet` the contact sheets, look at every sheet yourself, recommend your top
  two or three by number with the reason, and let the user pick one. Its pack is
  the finished set. Redraw it as an SVG only when the user asks for it.
- **Draw mode:** the four intake questions in one `AskUserQuestion` call (which
  icon - skipped when a description was given -, where to put the folder, how
  many different icons, approve first or make the full set right away). When
  two or more icons were asked for, a fifth question in a second call: make them
  one by one in this conversation (recommended) or in parallel with one subagent
  per icon (`icon-designer`, faster, more tokens). Then the SVG concepts by the
  skill's checklist, a contact sheet, the mandatory 16 px check, and the export
  (after approval when the user asked for it). After parallel work you check
  every subagent's result yourself.

Finish with the file list plus the wiring instructions for the user's project
type.
