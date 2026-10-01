# Security Policy

## Reporting a vulnerability

Please report security issues through GitHub Private Vulnerability Reporting: open the
**Security** tab of this repository and choose **Report a vulnerability**. Do not open a
public issue for a suspected vulnerability.

## Supported versions

Only the latest release is supported.

## Scope

This plugin runs entirely on your machine, makes no network requests, and needs no
accounts or services. Its scripts read the SVG files you name and the one image file
you give to `import` (a regular file that is not itself a link, at most 25 MB and
8192 x 8192 px checked from the header before decoding, format detected from content,
metadata ignored; links in the directories you name are followed once and reported, a link inside the
current folder is refused), render them with a
locally installed browser or command-line renderer, and write into the output folder you
choose (plus a scratch subfolder of the OS temp dir it tries to remove afterwards, on a best-effort basis). Relevant
reports are about handling SVG or image input unsafely (decoder bugs in the bundled PNG
and GIF readers, a crafted image that escapes the size caps; the tool statically rejects
scripts,
event handlers and external references, and renders SVG in the browser's script-free
image mode), writing outside the named output folder, unsafe renderer launch arguments,
or running anything beyond the renderer you already have.
