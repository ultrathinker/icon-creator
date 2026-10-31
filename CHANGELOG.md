# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.2]

### Changed
- Housekeeping, no change in behaviour: the sample SVGs of the browser tests are fixture files now, and two comments of
  the SVG check were reworded.

## [1.0.1]

### Security
- The SVG check could miss a reference whose address held a line break: `href`, `xlink:href` and `src` values were
  found by a pattern that stopped at the first line break, so `<image href="https://example.com/a.png&#10;">` was
  never examined. The addresses are now taken from the parsed tags, one by one, and an address is accepted only as
  empty, as an `#anchor` or as a raster `data:` URI (spaces, control characters and line breaks around it are
  ignored); anything else is refused, whatever it holds inside.
- The CSS side of the same check is tightened. `url(...)` is read by the start of its address, so a quoted address
  that holds a closing parenthesis or the other kind of quote no longer slips through; every CSS escape is undone
  before the scans (`ur\l(` and `@im\port` as well as hex escapes); `image-set()` is refused; and so is an
  `<animate>` or `<set>` that targets an `href` or `src` attribute.
- An `xml:base` is refused, and so is any other prefixed attribute named `base` (a prefix bound to the XML namespace
  must not hide it): it changes what even an `#anchor` resolves to in the renderers that honour it.
- The renderer, a browser or a command-line tool, is now given a private copy of exactly the text that was checked,
  not the path of the user's file, so a file replaced between the check and the render is not what gets drawn. The
  browser that decodes a WebP, a BMP or a rare JPEG is likewise shown a private copy of the bytes that were read.
- A message about a refused address shows its control characters as `U+` codes and cuts a long address short, and a
  file holding thousands of bad addresses or animations is refused after twenty messages per check instead of
  building them all.

## [1.0.0]

### Added
- A third way in: choose from a folder of your pictures. `pack.mjs ingest` takes the pictures of a folder in as
  numbered candidates (PNG, JPEG and GIF read built in, WebP and BMP through the headless browser; the pictures are
  only read), `build` writes a finished icon pack for every candidate and `sheet` draws contact sheets with each
  candidate on light and dark at 64, 32 and 16 px. The skill reads the sheets, recommends two or three by number and
  asks which one you want. Running `ingest` again after you add pictures takes in only the new ones, numbered on.
  `build` prints a short summary per candidate and keeps the full detail in `build-<n>.json`. A link in the path of
  the picture folder or the run folder follows the same rule as every other path: outside the current folder it is
  followed once and a `Note:` line says so, inside it is refused.
- The SVG step for the candidate you pick: `svg.mjs measure` prints the shapes, colours and symmetry to draw by,
  `check` compares the drawing with the picture (mismatch figures and a difference image), and `pack` builds its set
  with `icon.svg`, `web/favicon.svg` and the scalable Linux icon.
- Question 0 has a third option, `Choose from a folder of images`; a folder path given to `/icon` starts folder mode
  directly.
- `import` takes off the pale rim a removed background can leave outside a dark outline (`--no-edge-clean` keeps it).

### Changed
- A baseline JPEG is decoded by the plugin's own code, so importing one no longer needs a browser; progressive and
  CMYK JPEGs still go through it. A JPEG that stores RGB instead of YCbCr is recognised the way libjpeg does it.
- The PNG reader limits the decompressed data to what the image's own dimensions need.
- The skill keeps the details of folder mode and the SVG step in `skills/icon-creator/references/`, read only when
  that mode is used.

Nothing leaves your machine in any mode: no network requests, no accounts, no keys.

## [0.2.2]

### Fixed
- macOS: a headless Chrome sometimes keeps running for a long time after its screenshot is complete, and the tool
  waited for the process to exit (45 s per render), which made the macOS CI job hang. The tool now waits for the
  screenshot instead: once the output file is a complete PNG of unchanged size it ends the browser and carries on.
  The total time limit and the retry on a fresh profile are kept.
- The whole browser is ended, not just the process that was started: on macOS and Linux the browser runs in its own
  process group and the group is ended; on Windows the process tree is ended. A browser still running when the tool
  exits or is interrupted (Ctrl-C, a terminate request, a closed terminal) is ended as well. This covers every command
  that starts a browser: `render`, `sheet`, `check`, `import`, `doctor` and `export`.

### Added
- Tests with a fake browser that writes a valid PNG and then keeps running with a helper process of its own: a render
  must return quickly and leave nothing running; a browser that never writes still times out and is retried; a
  half-written file is not accepted; a browser left running when the program exits is ended.

## [0.2.1]

### Fixed
- macOS: paths that go through the operating system's own links (`/var`, `/tmp`, `/etc` are links into
  `/private`) were refused, so every write under the temp folder failed. A link in a path you name is now
  followed once and the tool prints the real location it works in. A link inside the current folder (your
  project, where a repository could ship one) is still refused, and the error names the real path to pass instead.
  Links below an output folder, at the output file, at a staging file and hardlinks are refused as before.
- The same link rule now covers every input path: the SVG to render, sheet, check or export, its small variant and
  the imported image (a link outside the current folder is followed and reported, one inside is refused, and an input
  file that is itself a link is refused). Before, only output paths were checked.
- The test suite no longer exceeds its time on slow runners: tests that need a real browser render fewer sizes
  and have generous per-process limits, and the CI job allows 30 minutes.

### Changed
- README, SECURITY.md and the skill describe the link behaviour exactly, and the platforms the CI covers.

## [0.2.0]

### Added
- Use your own image: PNG, JPEG, WebP, GIF, BMP or SVG goes in, the full icon set comes out. The `import` command
  fits the image into a square, removes a solid background when it can, and prints honest warnings (small source,
  heavy padding, unreadable at 16 px). Size and pixel limits are checked from the file header before decoding.
- Question 0: draw the icon for you, or use your file. File mode asks only where to put the folder.
- Several icons at once can be made by parallel subagents (the `icon-designer` agent), one icon per subagent.
- Concurrent runs of the tool do not collide.

### Changed
- README, PRIVACY.md and SECURITY.md now say plainly that the plugin reads the one image file you name.

## [0.1.1]

### Added
- Four multiple-choice intake questions (which icon, where to put the folder, how many, approve previews first or
  make the full set right away) and an approve-first mode with a preview folder.

## [0.1.0]

### Added
- First version: SVG concepts reviewed on a contact sheet, the mandatory 16 px check, and the export of Windows `.ico`,
  macOS `.icns`, the Linux hicolor tree, web favicons and master files. Dependency-free ICO and ICNS writers.
