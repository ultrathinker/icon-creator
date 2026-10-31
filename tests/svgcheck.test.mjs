import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSvg } from '../scripts/lib/svgcheck.mjs';

const GOOD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#111"/><stop offset="1" stop-color="#999"/></linearGradient></defs>' +
  '<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>' +
  '<path d="M64 128 L112 176 L192 88" fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round"/>' +
  '</svg>';

test('accepts a plain square icon', () => {
  const result = validateSvg(GOOD_SVG);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.viewBox, { minX: 0, minY: 0, width: 256, height: 256 });
});

test('rejects non-SVG content', () => {
  const result = validateSvg('<html><body>nope</body></html>');
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /no <svg> root/);
});

test('rejects an unclosed svg root', () => {
  const result = validateSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('never closed')));
});

test('rejects a non-square viewBox', () => {
  const result = validateSvg(GOOD_SVG.replace('viewBox="0 0 256 256"', 'viewBox="0 0 256 128"'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('square')));
});

test('rejects a missing viewBox', () => {
  const result = validateSvg(GOOD_SVG.replace(' viewBox="0 0 256 256"', ''));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('viewBox')));
});

test('rejects scripts, handlers, foreignObject and javascript: URLs', () => {
  for (const [label, bad] of [
    ['script', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script><rect width="8" height="8"/></svg>'],
    ['uppercase script', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><SCRIPT>alert(1)</SCRIPT></svg>'],
    ['handler', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" onload="x"/></svg>'],
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><foreignObject width="8" height="8"/></svg>'],
    ['javascript url', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><a href="javascript:alert(1)"><rect width="8" height="8"/></a></svg>'],
  ]) {
    const result = validateSvg(bad);
    assert.equal(result.ok, false, `${label} should be rejected`);
  }
});

test('rejects external href, src and url() references of every kind', () => {
  for (const [label, bad] of [
    ['http href', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image href="http://evil.example/x.png" width="8" height="8"/></svg>'],
    ['relative src', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image src="neighbor.png" width="8" height="8"/></svg>'],
    ['protocol relative', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><use xlink:href="//evil.example/a#x"/></svg>'],
    ['css url', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="url(https://evil.example/g)"/></svg>'],
    ['css import', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><style>@import url(http://evil.example/s.css)</style><rect width="8" height="8"/></svg>'],
    ['doctype', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'],
  ]) {
    const result = validateSvg(bad);
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(result.errors.length > 0);
  }
});

test('accepts internal and data: references', () => {
  const result = validateSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">' +
      '<defs><circle id="c" cx="32" cy="32" r="24"/></defs>' +
      '<use href="#c" fill="url(#none)"/>' +
      '<image xlink:href="data:image/png;base64,AAAA" x="0" y="0" width="8" height="8"/>' +
      '</svg>',
  );
  assert.equal(result.ok, true);
});

test('rejects SVG embedded through data: URLs in any position', () => {
  const nestedScript =
    'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>x()</script></svg>').toString('base64');
  const nestedFileRef = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image href="file:///etc/passwd"/></svg>');
  const applicationSvg =
    'data:application/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="green"/></svg>').toString('base64');
  for (const [label, bad] of [
    ['href base64 script', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="${nestedScript}" width="64" height="64"/></svg>`],
    ['href percent-encoded file ref', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="${nestedFileRef}" width="64" height="64"/></svg>`],
    ['application/svg+xml media type', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="${applicationSvg}" width="64" height="64"/></svg>`],
    ['css url()', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="url(${nestedScript})"/></svg>`],
    ['uppercase DATA prefix with space', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="${nestedScript.replace('data:', 'DATA: ')}" width="64" height="64"/></svg>`],
    ['text/html data URL', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="data:text/html;base64,PGI+" width="64" height="64"/></svg>`],
    ['unknown data type', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="data:application/octet-stream,AAAA" width="64" height="64"/></svg>`],
  ]) {
    const result = validateSvg(bad);
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes('not a supported raster image')), label);
  }
});

test('accepts every supported raster data: media type', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp']) {
    const result = validateSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="data:${type};base64,AAAA" width="64" height="64"/></svg>`,
    );
    assert.equal(result.ok, true, type);
  }
});

test('rejects namespace-qualified forbidden elements and references', () => {
  const wrap = (payload) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:z="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="#123"/>${payload}</svg>`;
  for (const [label, payload] of [
    ['prefixed script', '<s:script>x()</s:script>'],
    ['prefixed closing script only', '</s:script>'],
    ['prefixed foreignObject', '<s:foreignObject width="8" height="8"/>'],
    ['prefixed text', '<s:text x="1" y="2">A</s:text>'],
    ['prefixed tspan', '<s:text><s:tspan x="1" y="2">A</s:tspan></s:text>'],
    ['prefixed xlink href http', '<image z:href="http://evil.example/x.png" width="8" height="8"/>'],
    ['prefixed xlink href file', '<image z:href="file:///C:/x.png" width="8" height="8"/>'],
    ['prefixed xlink href protocol-relative', '<image z:href="//evil.example/x.png" width="8" height="8"/>'],
  ]) {
    const result = validateSvg(wrap(payload));
    assert.equal(result.ok, false, `${label} should be rejected`);
  }
  // Internal anchors and raster data: URLs stay valid under a prefix.
  const internal = validateSvg(wrap('<use z:href="#shape" xmlns:z="http://www.w3.org/1999/xlink"/>'));
  assert.equal(internal.ok, true, internal.errors.join('; '));
  const raster = validateSvg(wrap('<image z:href="data:image/png;base64,AAAA" width="8" height="8"/>'));
  assert.equal(raster.ok, true, raster.errors.join('; '));
});

test('rejects CSS-escaped constructs that decode to forbidden ones', () => {
  for (const [label, bad] of [
    [
      'escaped @import',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>@im\\70ort "http://evil.example/x.css"</style><rect width="64" height="64"/></svg>',
    ],
    [
      'escaped url()',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="\\75rl(http://evil.example/g)"/></svg>',
    ],
    [
      'entity-escaped href attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image wi&#100;th="64" height="64" hr&#101;f="http://evil.example/x.png"/></svg>',
    ],
    [
      'entity-escaped script tag',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><scr&#105;pt>x()</scr&#105;pt><rect width="64" height="64"/></svg>',
    ],
  ]) {
    const result = validateSvg(bad);
    assert.equal(result.ok, false, `${label} should be rejected`);
  }
});

test('a commented-out or CDATA-quoted svg cannot hijack root validation', () => {
  // A fake square root inside a comment must not stand in for the real
  // non-square root.
  const commentHijack =
    '<!-- <svg viewBox="0 0 256 256"></svg> -->\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 256"><rect x="8" y="8" width="284" height="240" rx="44" fill="#2563eb"/></svg>';
  const viaComment = validateSvg(commentHijack);
  assert.equal(viaComment.ok, false, 'the real non-square root must be validated');
  assert.ok(viaComment.errors.some((e) => e.includes('square')));
  assert.deepEqual(viaComment.viewBox, { minX: 0, minY: 0, width: 300, height: 256 });

  // Same trick inside a CDATA section of a style block.
  const cdataHijack =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 256"><style><![CDATA[<svg viewBox="0 0 256 256"/>]]></style>' +
    '<rect x="8" y="8" width="284" height="240" rx="44" fill="#123"/></svg>';
  const viaCdata = validateSvg(cdataHijack);
  assert.equal(viaCdata.ok, false);
  assert.ok(viaCdata.errors.some((e) => e.includes('square')));

  // A real square root still validates when a comment mentions a non-square one.
  const honest =
    '<!-- draft was viewBox 0 0 300 256 -->\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect x="8" y="8" width="240" height="240" rx="56" fill="#123"/></svg>';
  assert.equal(validateSvg(honest).ok, true);

  // Unterminated comment/CDATA is rejected rather than guessed at.
  const unterminated =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><!-- never closed' +
    '<rect width="64" height="64" fill="#123"/></svg>';
  const viaUnterminated = validateSvg(unterminated);
  assert.equal(viaUnterminated.ok, false);
  assert.ok(viaUnterminated.errors.some((e) => e.includes('unterminated')));
});

const REAL_ROOT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 256"><rect x="8" y="8" width="284" height="240" rx="44" fill="#2563eb"/></svg>';
const FAKE_ROOT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"></svg>';

test('unterminated or unsupported markup cannot hide a fake root', () => {
  for (const [label, prefix, pattern] of [
    ['unterminated processing instruction', '<?review\n', /unterminated XML processing instruction/],
    ['unterminated declaration', '<!ELEMENT\n', /unsupported "<!" markup declaration/],
    ['stray less-than sign', '<\n', /stray "<"/],
    ['quoted fake root inside an attribute', '<g title="' + FAKE_ROOT + '"/>', /malformed/],
    ['xml-stylesheet instruction', '<?xml-stylesheet href="http://evil.example/x.css"?>\n', /processing instruction/],
  ]) {
    const result = validateSvg(prefix + FAKE_ROOT + '\n' + REAL_ROOT);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.match(result.errors.join(' | '), pattern, label);
  }
});

test('a second root element or text outside the root is rejected', () => {
  const two = validateSvg(FAKE_ROOT + REAL_ROOT);
  assert.equal(two.ok, false);
  assert.match(two.errors[0], /more than one root/);
  assert.equal(validateSvg('hello ' + REAL_ROOT).ok, false);
  assert.equal(validateSvg(REAL_ROOT + ' trailing').ok, false);
});

test('the XML declaration is accepted only as the first thing in the file', () => {
  const body = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"/></svg>';
  assert.equal(validateSvg('<?xml version="1.0" encoding="UTF-8"?>\n' + body).ok, true);
  assert.equal(validateSvg(String.fromCharCode(0xfeff) + '<?xml version="1.0"?>' + body).ok, true);
  assert.equal(validateSvg('<!-- c --><?xml version="1.0"?>' + body).ok, false);
});

test('a ">" inside a quoted attribute value does not truncate the root tag', () => {
  const result = validateSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" data-note="a>b" viewBox="0 0 64 64"><rect width="64" height="64"/></svg>',
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.viewBox, { minX: 0, minY: 0, width: 64, height: 64 });
});

test('entities and CDATA cannot smuggle markup past the checks', () => {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">';
  const rect = '<rect width="64" height="64"/>';
  for (const [label, doc] of [
    // "&#60;!--" is plain text to an XML parser; it must not open a comment
    // in the scan copy and hide the real element that follows.
    ['entity-opened comment hiding an external image', open + '&#60;!--<image href="http://evil.example/x.png" width="9" height="9"/>--&#62;' + rect + '</svg>'],
    ['entity-opened comment hiding a script', open + '&#60;!--<script>x()</script>--&#62;' + rect + '</svg>'],
    // CDATA content is still CSS: external imports and urls inside it count.
    ['@import inside CDATA', open + '<style><![CDATA[@import "http://evil.example/x.css";]]></style>' + rect + '</svg>'],
    ['external url() inside CDATA', open + '<style><![CDATA[rect{fill:url(http://evil.example/p.svg#a)}]]></style>' + rect + '</svg>'],
  ]) {
    assert.equal(validateSvg(doc).ok, false, `${label} should be rejected`);
  }
  // A harmless CDATA style with an internal reference still passes.
  const fine = open + '<style><![CDATA[rect{fill:url(#g)}]]></style>' + rect + '</svg>';
  assert.equal(validateSvg(fine).ok, true);
});

test('flags hairline strokes as a warning, not an error', () => {
  const thin = GOOD_SVG.replace('stroke-width="24"', 'stroke-width="0.5"');
  const result = validateSvg(thin);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('thin')));
});

test('ignores stroke-width when checking root width/height', () => {
  const result = validateSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
      '<rect width="64" height="64" stroke-width="0"/></svg>',
  );
  assert.equal(result.ok, true);
});

test('non-square explicit width/height attributes are rejected too', () => {
  const result = validateSvg(GOOD_SVG.replace('width="256" height="256"', 'width="128" height="256"'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not square')));
});

test('equal px dimensions on a square viewBox are accepted', () => {
  const withPx = GOOD_SVG.replace('width="256" height="256"', 'width="256px" height="256px"');
  const result = validateSvg(withPx);
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('unequal px dimensions are still rejected', () => {
  const withPx = GOOD_SVG.replace('width="256" height="256"', 'width="256px" height="128px"');
  const result = validateSvg(withPx);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not square')));
});

test('text and tspan elements are rejected: letters must be paths', () => {
  for (const [label, bad] of [
    [
      'text',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#123"/><text x="128" y="140" font-size="80">A</text></svg>',
    ],
    [
      'tspan',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><text><tspan x="1" y="2">A</tspan></text></svg>',
    ],
    [
      'uppercase TEXT',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><TEXT x="1" y="2">A</TEXT></svg>',
    ],
  ]) {
    const result = validateSvg(bad);
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes('draw letters as paths')), label);
  }
});

// ---- addresses are read the way a browser reads them --------------------------------------------------------

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">';
const inSvg = (inner) => `${SVG_OPEN}${inner}</svg>`;
const OUTSIDE = 'http://evil.example/x.png';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

test('a line break, tab or separator inside an address cannot hide it from the reference check', () => {
  for (const [label, bad] of [
    ['trailing LF', `<image href="${OUTSIDE}\n" width="8" height="8"/>`],
    ['leading LF', `<image href="\n${OUTSIDE}" width="8" height="8"/>`],
    ['LF inside the scheme', '<image href="ht\ntp://evil.example/x.png" width="8" height="8"/>'],
    ['CRLF', `<image href="${OUTSIDE}\r\n" width="8" height="8"/>`],
    ['lone CR', `<image href="${OUTSIDE}\r" width="8" height="8"/>`],
    ['tab inside the scheme', '<image href="ht\ttp://evil.example/x.png" width="8" height="8"/>'],
    ['&#10; at the end', `<image href="${OUTSIDE}&#10;" width="8" height="8"/>`],
    ['&#xA; at the start', `<image href="&#xA;${OUTSIDE}" width="8" height="8"/>`],
    ['&#13; inside the address', '<image href="http:&#13;//evil.example/x.png" width="8" height="8"/>'],
    ['line separator at the end', `<image href="${OUTSIDE}${LINE_SEPARATOR}" width="8" height="8"/>`],
    ['paragraph separator at the start', `<image href="${PARAGRAPH_SEPARATOR}${OUTSIDE}" width="8" height="8"/>`],
    ['xlink:href', `<image xlink:href="${OUTSIDE}\n" width="8" height="8"/>`],
    ['single-quoted value', `<image href='${OUTSIDE}\n' width="8" height="8"/>`],
    ['src', `<image src="${OUTSIDE}\n" width="8" height="8"/>`],
    ['javascript: split by a line break', '<a href="java&#10;script:alert(1)"><rect width="8" height="8"/></a>'],
    ['file: path split by a line break', '<image href="fi\nle:///C:/secret.png" width="8" height="8"/>'],
    ['thousands of line breaks in front', `<image href="${'\n'.repeat(6000)}${OUTSIDE}" width="8" height="8"/>`],
    ['thousands of spaces in front', `<image href="${' '.repeat(6000)}${OUTSIDE}" width="8" height="8"/>`],
  ]) {
    const result = validateSvg(inSvg(bad));
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes('non-local')), label);
  }
});

test('a wrapped base64 picture and anchors with stray white space are still accepted', () => {
  const wrapped =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA\nAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4\n   //8/w38GIAXDIBKE0DHxgljNBAAO\r\n9TXL0Y4OHwAAAABJRU5ErkJggg==';
  for (const [label, good] of [
    ['wrapped base64 data: URL', `<image xlink:href="${wrapped}" width="8" height="8"/>`],
    ['line break after #', '<use href="#\nshape"/>'],
    ['spaces around the anchor', '<use href="  #shape  "/>'],
    ['empty href', '<use href=""/>'],
    ['url() with quotes and spaces', '<defs><linearGradient id="g"/></defs><rect width="8" height="8" fill="url( \'#g\' )"/>'],
    ['url() with line breaks around the anchor', '<defs><linearGradient id="g"/></defs><rect width="8" height="8" fill="url(\n#g\n)"/>'],
    ['url() with a double-quoted anchor in a style element', '<defs><linearGradient id="g"/></defs><style>rect{fill:url("#g")}</style><rect width="8" height="8"/>'],
  ]) {
    const result = validateSvg(inSvg(good));
    assert.equal(result.ok, true, `${label}: ${result.errors.join('; ')}`);
  }
});

test('only ASCII white space is dropped around an address: a no-break space does not make an anchor', () => {
  for (const [label, bad] of [
    ['no-break space before #', `<use href="${NO_BREAK_SPACE}#a"/>`],
    ['no-break space before # in url()', `<rect width="8" height="8" fill="url(${NO_BREAK_SPACE}#a)"/>`],
  ]) {
    assert.equal(validateSvg(inSvg(bad)).ok, false, `${label} should be rejected`);
  }
});

test('url() is read the way CSS reads it: quotes, parentheses, white space and escapes in the address', () => {
  for (const [label, bad] of [
    ['closing parenthesis inside a quoted address', `<style>rect{fill:url("http://evil.example/a)b.png")}</style>`],
    ['closing parenthesis inside a single-quoted address', `<rect width="8" height="8" fill="url('http://evil.example/a)b.png')"/>`],
    ['quote of the other kind inside the address', `<style>rect{fill:url("http://evil.example/a'b.png")}</style>`],
    ['upper-case URL(', `<style>rect{fill:URL(http://evil.example/g)}</style>`],
    ['line break after url(', `<style>rect{fill:url(\nhttp://evil.example/g)}</style>`],
    ['line break inside the scheme', `<style>rect{fill:url("ht\ntp://evil.example/g")}</style>`],
    ['thousands of spaces before the address', `<style>rect{fill:url(${' '.repeat(6000)}http://evil.example/g)}</style>`],
    ['thousands of line breaks before the address', `<style>rect{fill:url('${'\n'.repeat(6000)}http://evil.example/g')}</style>`],
    ['escaped letter in url (u\\rl)', `<style>rect{fill:u\\rl(http://evil.example/g)}</style>`],
    ['escaped letter in url (ur\\l)', `<rect width="8" height="8" fill="ur\\l(http://evil.example/g)"/>`],
    ['escaped letter in @import', `<style>@im\\port "http://evil.example/x.css";</style><rect width="8" height="8"/>`],
    ['escaped @', `<style>\\@import "http://evil.example/x.css";</style><rect width="8" height="8"/>`],
    ['hex escape with a trailing space', `<style>rect{fill:\\75 rl(http://evil.example/g)}</style>`],
    ['image-set() with a string address', `<rect width="8" height="8" style="mask-image:image-set('http://evil.example/x.png' 1x)"/>`],
    ['prefixed image-set()', `<rect width="8" height="8" style="-webkit-mask-image:-webkit-image-set('http://evil.example/x.png' 1x)"/>`],
    ['image-set() in a style element', `<style>rect{mask-image:image-set("http://evil.example/x.png" 1x)}</style><rect width="8" height="8"/>`],
  ]) {
    const result = validateSvg(inSvg(bad));
    assert.equal(result.ok, false, `${label} should be rejected`);
  }
});

test('an animation cannot point a reference at an outside address', () => {
  for (const [label, bad] of [
    ['set href', `<image href="#a" width="8" height="8"><set attributeName="href" to="${OUTSIDE}"/></image>`],
    ['animate xlink:href', `<image href="#a" width="8" height="8"><animate attributeName="xlink:href" values="#a;${OUTSIDE}" dur="1s"/></image>`],
    ['upper-case attribute name', `<image href="#a" width="8" height="8"><set attributeName="HREF" to="${OUTSIDE}"/></image>`],
    ['src', `<image href="#a" width="8" height="8"><set attributeName="src" to="${OUTSIDE}"/></image>`],
    ['white space around the attribute name', `<image href="#a" width="8" height="8"><set attributeName=" href " to="${OUTSIDE}"/></image>`],
    ['prefixed element', `<image href="#a" width="8" height="8"><s:set xmlns:s="http://www.w3.org/2000/svg" attributeName="href" to="${OUTSIDE}"/></image>`],
  ]) {
    const result = validateSvg(inSvg(bad));
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes('animat')), label);
  }
  const harmless = validateSvg(inSvg('<rect width="8" height="8"><animate attributeName="opacity" values="0;1" dur="1s"/></rect>'));
  assert.equal(harmless.ok, true, harmless.errors.join('; '));
});

test('error messages show control characters of an address as U+ codes, never raw', () => {
  const escape = String.fromCharCode(0x1b);
  const result = validateSvg(inSvg(`<image href="${OUTSIDE}\n${escape}[31m${LINE_SEPARATOR}" width="8" height="8"/>`));
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  assert.match(text, /non-local/);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f]/);
  assert.ok(!text.includes(LINE_SEPARATOR));
  assert.match(text, /U\+000A/);
  assert.match(text, /U\+001B/);
  assert.match(text, /U\+2028/);
});

test('a very long address is shortened in the message', () => {
  const result = validateSvg(inSvg(`<image href="http://evil.example/${'a'.repeat(5000)}" width="8" height="8"/>`));
  assert.equal(result.ok, false);
  assert.ok(result.errors.every((e) => e.length < 400), 'no message echoes the whole address');
});

const SEPARATORS = [
  '\t', '\n', '\r', '\f', '\v', ' ',
  String.fromCharCode(0x01), String.fromCharCode(0x1f), NO_BREAK_SPACE, LINE_SEPARATOR, PARAGRAPH_SEPARATOR,
  String.fromCharCode(0x200b), String.fromCharCode(0xfeff),
];

test('no separator character, put at any place of an outside address, hides it from the reference or url() check', () => {
  for (const separator of SEPARATORS) {
    for (let at = 0; at <= OUTSIDE.length; at += 1) {
      const address = OUTSIDE.slice(0, at) + separator + OUTSIDE.slice(at);
      for (const [label, markup] of [
        ['href', `<image href="${address}" width="8" height="8"/>`],
        ['xlink:href', `<image xlink:href="${address}" width="8" height="8"/>`],
        ['src', `<image src="${address}" width="8" height="8"/>`],
        ['url() in a style element', `<style>rect{fill:url(${address})}</style><rect width="8" height="8"/>`],
        ['quoted url() in an attribute', `<rect width="8" height="8" fill="url('${address}')"/>`],
      ]) {
        const result = validateSvg(inSvg(markup));
        assert.equal(result.ok, false, `${label} with U+${separator.charCodeAt(0).toString(16)} at ${at} should be rejected`);
      }
    }
  }
});

test('an anchor or a raster data: address is accepted with spaces, control characters and line breaks around it', () => {
  for (const [label, good] of [
    ['anchor with spaces and line breaks around it', '<defs><circle id="c" r="3"/></defs><use href=" \n\t#c\r\n "/>'],
    ['anchor with a control character in front', `<defs><circle id="c" r="3"/></defs><use href="${String.fromCharCode(1)}#c"/>`],
    ['data: address with white space around it', '<image href="\n  data:image/png;base64,AAAA\n" width="8" height="8"/>'],
    ['url() with spaces inside the quotes', '<defs><linearGradient id="g"/></defs><rect width="8" height="8" fill="url(\' #g \')"/>'],
    ['url() with a line break inside the quotes', '<defs><linearGradient id="g"/></defs><style>rect{fill:url("\n#g")}</style><rect width="8" height="8"/>'],
    ['empty url() in quotes', `<rect width="8" height="8" fill="url('')"/>`],
    ['empty url()', '<rect width="8" height="8" fill="url()"/>'],
    ['url() of a raster data: address with a space in front', '<style>rect{fill:url( "  data:image/png;base64,AAAA")}</style><rect width="8" height="8"/>'],
  ]) {
    const result = validateSvg(inSvg(good));
    assert.equal(result.ok, true, `${label}: ${result.errors.join('; ')}`);
  }
});

test('a file holding very many bad addresses is refused with a short list of messages, quickly', () => {
  const started = Date.now();
  const repeated = validateSvg(inSvg(`<style>${'url('.repeat(200000)}</style>`));
  const distinctUrls = validateSvg(
    inSvg(`<style>${Array.from({ length: 5000 }, (_, i) => `a{fill:url(http://evil.example/${i})}`).join('')}</style>`),
  );
  const distinctHrefs = validateSvg(inSvg(Array.from({ length: 5000 }, (_, i) => `<image href="http://evil.example/${i}.png"/>`).join('')));
  for (const [label, result] of [['repeated url(', repeated], ['distinct url()', distinctUrls], ['distinct href', distinctHrefs]]) {
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.length <= 40, `${label}: ${result.errors.length} messages`);
  }
  assert.ok(Date.now() - started < 8000, 'the three refusals took far too long');
});

test('an xml:base is refused: it changes what even an anchor resolves to', () => {
  const root = (attributes, inner) => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes} viewBox="0 0 64 64">${inner}</svg>`;
  for (const [label, bad] of [
    ['on the root', root('xml:base="http://evil.example/dir/"', '<use href="#a"/>')],
    ['on a child', root('', '<g xml:base="http://evil.example/dir/"><use href="#a"/></g>')],
    ['empty value', root('', '<g xml:base=""><use href="#a"/></g>')],
    ['upper-case spelling', root('', '<g XML:BASE="http://evil.example/"><use href="#a"/></g>')],
  ]) {
    const result = validateSvg(bad);
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes('xml:base')), label);
  }
  assert.equal(validateSvg(root('xml:space="preserve"', '<use href="#a"/>')).ok, true, 'other xml: attributes stay fine');
});

test('a prefix bound to the XML namespace cannot hide an xml:base: every prefixed "base" attribute is refused', () => {
  const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
  const root = (declarations, inner) => `<svg xmlns="http://www.w3.org/2000/svg" ${declarations} viewBox="0 0 64 64">${inner}</svg>`;
  for (const [label, bad] of [
    ['alias prefix', root(`xmlns:x="${XML_NAMESPACE}"`, '<g x:base="http://127.0.0.1:9/"><use href="#shape"/></g>')],
    ['upper-case alias prefix', root(`xmlns:X="${XML_NAMESPACE}"`, '<g X:base="http://127.0.0.1:9/"><use href="#shape"/></g>')],
    ['alias on the root', `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="${XML_NAMESPACE}" x:base="http://127.0.0.1:9/" viewBox="0 0 64 64"><use href="#shape"/></svg>`],
    ['prefix that is not even declared', root('', '<g q:base="http://127.0.0.1:9/"><use href="#shape"/></g>')],
  ]) {
    const result = validateSvg(bad);
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes('xml:base')), label);
  }
  for (const [label, good] of [
    ['a prefixed attribute that only ends in "base"', root('', '<g foo:database="1" foo:basement="2"><use href="#shape"/></g>')],
    ['an unprefixed attribute named base', root('', '<g base="1"><use href="#shape"/></g>')],
    ['xml:lang', root('', '<g xml:lang="en"><use href="#shape"/></g>')],
    ['a declaration of a prefix named base', root('xmlns:base="urn:example"', '<use href="#shape"/>')],
    ['an attribute of a prefix named base', root('xmlns:base="urn:example"', '<g base:label="x"><use href="#shape"/></g>')],
  ]) {
    const result = validateSvg(good);
    assert.equal(result.ok, true, `${label}: ${result.errors.join('; ')}`);
  }
});

test('a file holding very many animations of href is refused with a short list of messages', () => {
  // Each target is spelled with a prefix of its own, so no two messages are alike and the final de-duplication cannot hide the count.
  const items = Array.from({ length: 5000 }, (_, i) => `<set attributeName="p${i}:href" to="http://127.0.0.1:9/x"/>`).join('');
  const started = Date.now();
  const result = validateSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${items}</svg>`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length <= 40, `${result.errors.length} messages`);
  assert.ok(Date.now() - started < 5000, 'the refusal took far too long');
});
