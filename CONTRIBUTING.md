# Contributing

Thanks for looking. This plugin is small on purpose: a skill (with two reference pages), a command, one agent file and three
dependency-free Node scripts (`icons.mjs`, `pack.mjs`, `svg.mjs`). Please keep it that way: no runtime packages, no network access, nothing that writes outside the
output folder the user names.

## Development setup

Node 18 or newer. There is nothing to install.

    node --test tests/*.test.mjs

Tests that need a real browser skip with a message when none is found (Chrome, Chromium or Edge). Use
synthetic data only: tests build their images and SVGs themselves or use the tiny files in `tests/fixtures`.

## Pull requests

- One logical change per pull request, with a test that fails without it.
- Keep `README.md`, `PRIVACY.md` and the skill text true: if behaviour changes, the words change in the same
  pull request.
- Do not add binary files other than PNG, JPEG, GIF, WebP or SVG, and keep every file under 256 KiB.
- Run `claude plugin validate .` if you have Claude Code installed.

## Releases

A release is made from the files git tracks only (a snapshot of `git ls-files`), never by packing the working folder:
ignored working folders such as `docs/` and `_docs/` must not ship.

## Reporting problems

Bugs and ideas: open an issue. Security problems: see `SECURITY.md` and do not open a public issue.
