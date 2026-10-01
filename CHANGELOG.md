# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
