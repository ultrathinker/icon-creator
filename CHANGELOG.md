# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
