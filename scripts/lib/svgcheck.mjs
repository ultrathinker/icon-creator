// SVG intake checks and HTML inlining helpers.
//
// The renderer loads the SVG inside a local HTML page through a file:// URL.
// Before that happens the input must be provably self-contained: no scripts,
// no event handlers, no external or local-file references that a browser would
// try to fetch. viewBox and width/height must describe a square, because every
// export target is square.
//
// An address (href, src, url(...)) is accepted only in its plain form: empty, "#anchor" or
// a raster data: URI, with at most spaces and control characters around it. Anything else
// is refused, whatever it holds inside (a browser reads "ht<LF>tps://x" as "https://x",
// so such a spelling must not slip through as something harmless). The addresses of href
// and src are taken from the attributes of the parsed tags, never from a text scan, so no
// spelling of the markup around them can make an attribute go unread.

// Namespace prefixes are legal in XML: <s:script> with xmlns:s bound to the
// SVG namespace IS a script element, and <image z:href="..."> with z bound
// to the XLink namespace IS an external reference. The patterns therefore
// match the LOCAL NAME with any (or no) prefix - this is deliberately
// conservative: an unknown-namespace element that happens to be named
// "script" is rejected too, which is the safe side for a static checker.
const NAME = '[A-Za-z_][\\w.-]*:';

const FORBIDDEN_PATTERNS = [
  { pattern: new RegExp(`<(?:${NAME})?script(?:[\\s>]|$)`, 'i'), message: 'contains a <script> element' },
  { pattern: new RegExp(`</(?:${NAME})?script\\s*>`, 'i'), message: 'contains a </script> element' },
  { pattern: new RegExp(`<(?:${NAME})?foreignObject(?:[\\s>]|$)`, 'i'), message: 'contains a <foreignObject> element' },
  { pattern: new RegExp(`<(?:${NAME})?text(?:[\\s>]|$)`, 'i'), message: 'contains a <text> element: draw letters as paths (fonts differ between renderers)' },
  { pattern: new RegExp(`<(?:${NAME})?tspan(?:[\\s>]|$)`, 'i'), message: 'contains a <tspan> element: draw letters as paths (fonts differ between renderers)' },
  { pattern: /\son[a-z]+\s*=\s*["']/i, message: 'contains an inline event handler (on...=)' },
  { pattern: /@import/i, message: 'uses a CSS @import' },
  { pattern: /<!DOCTYPE/i, message: 'has a DOCTYPE (external entities cannot be checked; remove it)' },
  { pattern: /javascript\s*:/i, message: 'contains a javascript: URL' },
  { pattern: /image-set\s*\(/i, message: 'contains a CSS image-set(), which loads a picture by name (draw shapes, or use url(#id))' },
];

/** The attributes that hold an address, compared by local name: any case, any namespace prefix. */
const REFERENCE_ATTRIBUTES = new Set(['href', 'src']);

/**
 * Most problems one address check reports before it stops looking. The file is refused at the first of them; a file
 * holding a million bad addresses must not cost a million messages.
 */
const MAX_PROBLEMS = 20;

function localName(qualified) {
  return qualified.slice(qualified.lastIndexOf(':') + 1).toLowerCase();
}

function codePoint(base) {
  return (_, digits) => {
    try {
      return String.fromCodePoint(parseInt(digits, base));
    } catch {
      return '';
    }
  };
}

/** Decode XML numeric character references (what an XML parser would do). */
function decodeEntities(text) {
  return text.replace(/&#x([0-9a-f]+);?/gi, codePoint(16)).replace(/&#(\d+);?/g, codePoint(10));
}

/**
 * Undo CSS escapes the way a CSS parser does before it reads a name: a backslash with up to six hex digits (and one
 * white space after them), or a backslash with any other character, which stands for itself. `ur\l(` is `url(` and
 * `@\import` is `@import`.
 */
function unescapeCss(text) {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|([\s\S]))/g, (match, hex, other) =>
    hex !== undefined ? codePoint(16)(match, hex) : other,
  );
}

/**
 * Decode XML numeric entities and CSS escapes so pattern scans cannot be
 * evaded by writing `@im\70ort`, `u\rl(...)`, `&#117;rl(` and friends. The
 * decoded copy is used for CHECKING ONLY - rendering always uses the original
 * file, and any decode oddity can only make the checker stricter, never the
 * renderer more permissive. It runs AFTER the markup structure has been
 * tokenized from the raw text: an entity such as `&#60;!--` is plain text to
 * an XML parser, so it must never be able to open a comment in the scan copy
 * and hide real elements behind it.
 */
function decodeForScanning(text) {
  return unescapeCss(decodeEntities(text));
}

const RASTER_DATA_URL = /^data:[\f ]*image\/(?:png|jpe?g|gif|webp|bmp)(?:[;,]|$)/i;

/**
 * The address of a value: the whole value, with the C0 control characters and spaces at both ends cut, as a URL parser
 * cuts them. Nothing else is repaired: an address with a tab or line break inside ("ht<LF>tps://x", which a browser
 * reads as "https://x") is not a local one and is refused like any other. Only ASCII is cut: a no-break space in
 * front of "#" leaves a relative path, not an anchor. Plain loops, no regex with a repeated white-space class, so a
 * long run of spaces cannot make the cut slow.
 */
function trimAddress(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** An address as it goes into a message: cut short, control characters and separators spelled as U+ codes. */
function visible(text, limit = 80) {
  const clipped = text.length > limit ? `${text.slice(0, limit)}...` : text;
  return clipped.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * Classify one reference by its address (see trimAddress). An empty address and an `#anchor` are
 * internal. `data:` URIs are allowed for raster image types ONLY: anything else under
 * data: (SVG in any spelling, HTML, XML, unknown types) is rejected without
 * inspecting it, because its payload is never validated here and fallback
 * renderers process it outside the browser's locked-down image mode.
 */
function referenceProblem(kind, raw, address) {
  if (address === '' || address.startsWith('#')) return null;
  if (RASTER_DATA_URL.test(address)) return null;
  if (/^data:/i.test(address)) {
    return (
      `${kind} in ${raw} uses a data: URL that is not a supported raster image ` +
      '(only image/png, image/jpeg, image/gif, image/webp, image/bmp data: URIs are allowed; ' +
      'inline SVG shapes directly instead of embedding SVG)'
    );
  }
  return `non-local ${kind} in ${raw} (only "#..." anchors and raster data: URIs are allowed)`;
}

/** href and src of the parsed tags, one by one: the address is the whole attribute value, line breaks and all. */
function checkReferenceAttributes(references, errors) {
  let reported = 0;
  for (const { name, value } of references) {
    const address = trimAddress(value);
    const problem = referenceProblem(name, `${name}="${visible(address)}"`, address);
    if (problem === null) continue;
    errors.push(problem);
    reported += 1;
    if (reported >= MAX_PROBLEMS) return;
  }
}

/**
 * The first characters of the address a url() holds (see trimAddress): leading control characters and spaces are
 * skipped without counting, so padding cannot push the real start out of the window. Reading stops at a closing
 * parenthesis or a quote, so a quoted address that holds one is judged by its start, which is what decides whether
 * it is local.
 */
function addressAt(text, index, limit = 160) {
  let address = '';
  for (let i = index; i < text.length && address.length < limit; i += 1) {
    const ch = text[i];
    if (ch === ')' || ch === '"' || ch === "'") break;
    if (address === '' && ch <= ' ') continue;
    address += ch;
  }
  return address;
}

const URL_FUNCTION = /url\([\t\n\r\f ]*["']?/gi;

function checkUrlFunctions(text, errors) {
  let reported = 0;
  for (const match of text.matchAll(URL_FUNCTION)) {
    const address = addressAt(text, match.index + match[0].length);
    const problem = referenceProblem('external reference', `url(${visible(address)})`, address);
    if (problem === null) continue;
    errors.push(problem);
    reported += 1;
    if (reported >= MAX_PROBLEMS) return;
  }
}

function parseViewBox(value) {
  if (value === undefined) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
}

const QNAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?';
const TAG_NAME = new RegExp(QNAME, 'y');
const ATTRIBUTE = new RegExp(`\\s+(${QNAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
const TAG_END = /\s*(\/?)>/y;

function sticky(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/**
 * Note what one tag says about addresses, into `found`: its href and src (whatever the prefix); for <animate> and <set>,
 * a target that is itself a reference attribute (an animation could swap a harmless address for an outside one while the
 * picture is shown, and its `to`/`values` are not addresses the static check reads); and an xml:base (it changes what
 * even an "#anchor" resolves to, in the consumers that honour it). Any prefixed attribute whose local name is "base"
 * counts as one, so that a prefix bound to the XML namespace (which a lenient parser may allow) does not hide it; a
 * declaration of a prefix named "base" (xmlns:base) is not an attribute of that name.
 */
function collectReferences(element, attributes, found) {
  for (const [attribute, value] of attributes) {
    const local = localName(attribute);
    if (REFERENCE_ATTRIBUTES.has(local)) found.references.push({ name: attribute, value });
    if (local === 'base' && attribute.includes(':') && !/^xmlns:/i.test(attribute)) found.rebased = true;
  }
  if (/^(?:animate|set)$/i.test(element)) {
    for (const [attribute, value] of attributes) {
      const target = value.trim();
      if (localName(attribute) === 'attributename' && REFERENCE_ATTRIBUTES.has(localName(target)) && found.animated.length < MAX_PROBLEMS) {
        found.animated.push({ element, name: target });
      }
    }
  }
}

/**
 * Walk the RAW document as a strict, conservative XML tokenizer. It is not a
 * full parser: it accepts only well-formed tags, comments and CDATA and
 * rejects everything it does not understand (unterminated constructs, a stray
 * "<", processing instructions other than the XML declaration, other "<!"
 * declarations, a second root, text outside the root, mismatched closing
 * tags, repeated attributes). A document this walk rejects would not render
 * as an icon anyway, and refusing it keeps the checker and the renderer from
 * disagreeing about where the real root is.
 *
 * Returns { scan, root, elements, references, animated, rebased, fatal }. `scan` is the raw text minus comments and the
 * XML declaration, with CDATA unwrapped into inert text, ready for the pattern
 * scans; `root` holds the decoded attributes of the document element,
 * `elements` the local names of every element in document order, `references` the href and src
 * attributes of every tag ({ name, value }, the value decoded), `animated` the animations that
 * target one of them and `rebased` whether any tag carries an xml:base.
 */
function tokenize(raw, errors) {
  const pieces = [];
  const stack = [];
  const elements = [];
  const found = { references: [], animated: [], rebased: false };
  let root = null;
  let rootClosed = false;
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const start = i;
  const fatal = (message) => {
    errors.push(message);
    return { scan: pieces.join(''), root, elements, ...found, fatal: true };
  };

  while (i < raw.length) {
    const lt = raw.indexOf('<', i);
    const text = lt === -1 ? raw.slice(i) : raw.slice(i, lt);
    if (text !== '') {
      if (stack.length === 0 && text.trim() !== '') {
        return fatal(
          root === null
            ? 'text before the <svg> root element (is this an SVG file?)'
            : 'text after the closing </svg> of the root element',
        );
      }
      pieces.push(text);
    }
    if (lt === -1) break;
    i = lt;

    if (raw.startsWith('<!--', i)) {
      const end = raw.indexOf('-->', i + 4);
      if (end === -1) return fatal('contains an unterminated XML comment; fix the markup');
      i = end + 3;
    } else if (raw.startsWith('<![CDATA[', i)) {
      const end = raw.indexOf(']]>', i + 9);
      if (end === -1) return fatal('contains an unterminated CDATA section; fix the markup');
      const content = raw.slice(i + 9, end);
      if (stack.length === 0 && content.trim() !== '') return fatal('CDATA outside the root element');
      pieces.push(content.replace(/</g, '&lt;'));
      i = end + 3;
    } else if (raw.startsWith('<?', i)) {
      const end = raw.indexOf('?>', i + 2);
      if (end === -1) return fatal('contains an unterminated XML processing instruction; fix the markup');
      if (i !== start || !/^<\?xml\s/.test(raw.slice(i, end + 2))) {
        return fatal(
          'contains a processing instruction other than the XML declaration ' +
            '(for example xml-stylesheet can load external files); remove it',
        );
      }
      i = end + 2;
    } else if (raw.startsWith('<!', i)) {
      return fatal(
        /^<!DOCTYPE/i.test(raw.slice(i, i + 9))
          ? 'has a DOCTYPE (external entities cannot be checked; remove it)'
          : 'contains an unsupported "<!" markup declaration',
      );
    } else if (raw.startsWith('</', i)) {
      const name = sticky(TAG_NAME, raw, i + 2);
      const close = name ? sticky(TAG_END, raw, i + 2 + name[0].length) : null;
      if (!close || close[1] === '/') return fatal('contains a malformed closing tag');
      if (stack.length === 0 || stack[stack.length - 1] !== name[0]) {
        return fatal(`closing tag </${name[0]}> does not match the open element`);
      }
      stack.pop();
      if (stack.length === 0) rootClosed = true;
      const length = 2 + name[0].length + close[0].length;
      pieces.push(raw.slice(i, i + length));
      i += length;
    } else {
      const name = sticky(TAG_NAME, raw, i + 1);
      if (!name) return fatal('contains a stray "<" that does not start a valid tag');
      let cursor = i + 1 + name[0].length;
      const attributes = new Map();
      for (let match = sticky(ATTRIBUTE, raw, cursor); match; match = sticky(ATTRIBUTE, raw, cursor)) {
        if (attributes.has(match[1])) return fatal(`<${name[0]}> repeats the attribute ${match[1]}`);
        attributes.set(match[1], decodeEntities(match[2] ?? match[3]));
        cursor += match[0].length;
      }
      const end = sticky(TAG_END, raw, cursor);
      if (!end) return fatal(`<${name[0]}> is malformed (attributes must be name="value")`);
      if (stack.length === 0) {
        if (rootClosed) return fatal('contains more than one root element');
        if (name[0] !== 'svg' && !name[0].endsWith(':svg')) {
          return fatal('no <svg> root element found (is this an SVG file?)');
        }
        root = { attributes };
      }
      cursor += end[0].length;
      const element = name[0].slice(name[0].indexOf(':') + 1);
      elements.push(element);
      collectReferences(element, attributes, found);
      pieces.push(raw.slice(i, cursor));
      if (end[1] === '/') {
        if (stack.length === 0) rootClosed = true;
      } else {
        stack.push(name[0]);
      }
      i = cursor;
    }
  }
  if (root === null) return fatal('no <svg> root element found (is this an SVG file?)');
  if (stack.length > 0) errors.push('the <svg> element is never closed');
  return { scan: pieces.join(''), root, elements, ...found, fatal: false };
}

/**
 * Validate SVG source text. Returns { ok, errors, warnings, viewBox, elements }
 * (`elements`: local element names in document order).
 * `errors` are fatal (the file will not be rendered); `warnings` are noted
 * but do not stop the pipeline.
 */
export function validateSvg(text, { label = 'the SVG' } = {}) {
  const errors = [];
  const warnings = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, errors: ['the file is empty'], warnings, viewBox: null };
  }
  // Structure comes from the raw text; the pattern scans then run on a copy
  // with XML entities and CSS escapes decoded, so obfuscated spellings of
  // forbidden constructs are caught but cannot hide real markup.
  const tokens = tokenize(text, errors);
  const viewBox = parseViewBox(tokens.root?.attributes.get('viewBox'));
  if (tokens.fatal) {
    return { ok: false, errors: [...new Set(errors)], warnings, viewBox, elements: tokens.elements };
  }
  const scanText = decodeForScanning(tokens.scan);
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(scanText)) errors.push(rule.message);
  }
  checkReferenceAttributes(tokens.references, errors);
  if (tokens.rebased) {
    errors.push('contains an xml:base (or another prefixed "base" attribute), which changes how the references of the file are resolved; remove it');
  }
  for (const { element, name } of tokens.animated) {
    errors.push(`<${element}> animates the ${visible(name)} attribute: a reference must not change while the picture is shown`);
  }
  checkUrlFunctions(scanText, errors);

  if (!viewBox) {
    errors.push('the <svg> root has no readable viewBox="minX minY width height"');
  } else if (viewBox.width <= 0 || viewBox.height <= 0) {
    errors.push(`viewBox size ${viewBox.width}x${viewBox.height} is not positive`);
  } else if (viewBox.width !== viewBox.height) {
    errors.push(
      `viewBox is ${viewBox.width}x${viewBox.height}: every export target is square, ` +
        'redraw on a square canvas (for example viewBox="0 0 256 256")',
    );
  }
  const widthAttr = tokens.root.attributes.get('width')?.trim();
  const heightAttr = tokens.root.attributes.get('height')?.trim();
  for (const [name, value] of [['width', widthAttr], ['height', heightAttr]]) {
    const pixels = /^(-?\d+(?:\.\d+)?)(px)?$/i.exec(value ?? '');
    if (pixels && Number(pixels[1]) <= 0) {
      errors.push(`root ${name}="${value}" is not positive`);
    }
  }
  const dimension = (value) => /^(\d+(?:\.\d+)?)(px)?$/i.exec(value);
  const widthNumber = widthAttr ? dimension(widthAttr) : null;
  const heightNumber = heightAttr ? dimension(heightAttr) : null;
  if (widthNumber && heightNumber && Number(widthNumber[1]) !== Number(heightNumber[1])) {
    errors.push(`root width/height ${widthAttr}x${heightAttr} is not square while the viewBox is`);
  }
  if (!errors.length && /stroke-width\s*=\s*["']0?\.?[0-3](?![0-9])/i.test(scanText)) {
    warnings.push('contains very thin strokes (<= 0.3); hairlines disappear at 16 px');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings, viewBox, elements: tokens.elements };
}

/** Strip the XML prolog (kept for callers that want clean markup text). */
export function inlineSvg(text) {
  return text.replace(/<\?xml[^>]*\?>/gi, '').trim();
}
