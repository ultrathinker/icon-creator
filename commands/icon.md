---
description: Design a complete app icon set (Windows, macOS, Linux, web) from a description, or build it from your own image file
argument-hint: [optional: describe the icon, e.g. "a timer app for focus sessions", or give the path to your own image file]
---

Create an application icon set with the `icon-creator` skill.

What the user gave, if anything (empty means: ask question 0 first):

$ARGUMENTS

Follow the `icon-creator` skill end to end. Start with its `doctor` check, then
its question 0, asked alone: "Should I draw the icon for you or use your own
image file?" with the options `Draw one for me` and `Use my image file`. Skip
question 0 when the text above is already a path to an existing image file
(file mode) or a description of an icon (draw mode).

- **File mode** (own image): ask only where to put the folder, run `import` to
  prepare the master (for a raster file background handling is automatic and
  reported; an SVG file is only validated and copied), look at the result on a
  light and a dark background, run the mandatory 16 px check, and export exactly
  one icon with the full set right away - no question about how many icons and
  no approval step. Tell the user what was measured and relay every warning. For
  a raster file (PNG, JPEG, WebP, GIF, BMP) say which vector files are not
  written because the master is a raster image; an SVG file keeps all of them.
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
