// SVG intake checks and HTML inlining helpers.
//
// The renderer loads the SVG inside a local HTML page through a file:// URL.
// Before that happens the input must be provably self-contained: no scripts,
// no event handlers, no external or local-file references that a browser would
// try to fetch. viewBox and width/height must describe a square, because every
// export target is square.

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
];

function attributeValues(text, attribute) {
  const values = [];
  // Match the attribute's local name with any (or no) namespace prefix, so
  // z:href bound to the XLink namespace cannot slip past the "href" check;
  // require whitespace before the name so "stroke-width" is not mistaken
  // for "width".
  const pattern = new RegExp(`\\s(?:[A-Za-z_][\\w.-]*:)?${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'gi');
  for (const match of text.matchAll(pattern)) {
    values.push({ value: match[2], raw: match[0].trimStart() });
  }
  return values;
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
 * Decode XML numeric entities and CSS hex escapes so pattern scans cannot be
 * evaded by writing `@im\70ort`, `\75rl(...)`, `hr&#101;f=` and friends. The
 * decoded copy is used for CHECKING ONLY - rendering always uses the original
 * file, and any decode oddity can only make the checker stricter, never the
 * renderer more permissive. It runs AFTER the markup structure has been
 * tokenized from the raw text: an entity such as `&#60;!--` is plain text to
 * an XML parser, so it must never be able to open a comment in the scan copy
 * and hide real elements behind it.
 */
function decodeForScanning(text) {
  return decodeEntities(text).replace(/\\([0-9a-fA-F]{1,6})\s?/g, codePoint(16));
}

const RASTER_DATA_URL = /^data:\s*image\/(?:png|jpe?g|gif|webp|bmp)(?:[;,]|$)/i;

/**
 * Classify one reference value. Empty values and `#anchor`s are internal.
 * `data:` URIs are allowed for raster image types ONLY: anything else under
 * data: (SVG in any spelling, HTML, XML, unknown types) is rejected without
 * inspecting it, because its payload is never validated here and fallback
 * renderers process it outside the browser's locked-down image mode.
 */
function referenceProblem(kind, raw, value) {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  if (RASTER_DATA_URL.test(trimmed)) return null;
  if (/^data:/i.test(trimmed)) {
    return (
      `${kind} in ${raw} uses a data: URL that is not a supported raster image ` +
      '(only image/png, image/jpeg, image/gif, image/webp, image/bmp data: URIs are allowed; ' +
      'inline SVG shapes directly instead of embedding SVG)'
    );
  }
  return `non-local ${kind} in ${raw} (only "#..." anchors and raster data: URIs are allowed)`;
}

function checkUrlFunctions(text, errors) {
  const pattern = /url\(\s*(["']?)([^)"']*)\1\s*\)/gi;
  for (const match of text.matchAll(pattern)) {
    const problem = referenceProblem('external reference', match[0], match[2]);
    if (problem !== null) errors.push(problem);
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
 * Walk the RAW document as a strict, conservative XML tokenizer. It is not a
 * full parser: it accepts only well-formed tags, comments and CDATA and
 * rejects everything it does not understand (unterminated constructs, a stray
 * "<", processing instructions other than the XML declaration, other "<!"
 * declarations, a second root, text outside the root, mismatched closing
 * tags, repeated attributes). A document this walk rejects would not render
 * as an icon anyway, and refusing it keeps the checker and the renderer from
 * disagreeing about where the real root is.
 *
 * Returns { scan, root, elements, fatal }. `scan` is the raw text minus comments and the
 * XML declaration, with CDATA unwrapped into inert text, ready for the pattern
 * scans; `root` holds the decoded attributes of the document element and
 * `elements` the local names of every element in document order.
 */
function tokenize(raw, errors) {
  const pieces = [];
  const stack = [];
  const elements = [];
  let root = null;
  let rootClosed = false;
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const start = i;
  const fatal = (message) => {
    errors.push(message);
    return { scan: pieces.join(''), root, elements, fatal: true };
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
      elements.push(name[0].slice(name[0].indexOf(':') + 1));
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
  return { scan: pieces.join(''), root, elements, fatal: false };
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
  for (const attribute of ['href', 'xlink:href', 'src']) {
    for (const { value, raw } of attributeValues(scanText, attribute)) {
      const problem = referenceProblem(attribute, raw, value);
      if (problem !== null) errors.push(problem);
    }
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
