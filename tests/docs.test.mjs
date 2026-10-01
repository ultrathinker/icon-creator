// The skill, the slash command and the README are the product's instructions:
// these tests keep them in step with the real tool (subcommands, flags, limits,
// warning codes) and with the question flow the owner specified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MAX_INPUT_BYTES, MAX_SIDE } from '../scripts/lib/imagefile.mjs';
import { DEFAULT_TOLERANCE, BACKGROUND_MODES } from '../scripts/lib/importimg.mjs';
import { planFiles, TARGETS } from '../scripts/lib/export.mjs';
import { linkNote } from '../scripts/lib/publish.mjs';

const read = (relative) => fs.readFileSync(path.resolve(relative), 'utf8').replace(/\r\n/g, '\n');
// Prose wraps at 80 columns, so wording checks run on text with whitespace collapsed.
const flat = (text) => text.replace(/\s+/g, ' ');

const SKILL = read('skills/icon-creator/SKILL.md');
const COMMAND = read('commands/icon.md');
const README = read('README.md');
const PRIVACY = read('PRIVACY.md');
const SECURITY = read('SECURITY.md');
const IMPORT_SOURCE = read('scripts/lib/importimg.mjs');
const SKILL_FLAT = flat(SKILL);
const COMMAND_FLAT = flat(COMMAND);

const help = spawnSync(process.execPath, [path.resolve('scripts/icons.mjs'), '--help'], { encoding: 'utf8', windowsHide: true }).stdout;
const KNOWN_FLAGS = new Set(help.match(/--[a-z][a-z-]*/g));
const SUBCOMMANDS = ['doctor', 'import', 'render', 'sheet', 'check', 'export'];
const REQUIRED_FLAGS = {
  import: ['--out', '--name'],
  render: ['--size', '--out'],
  sheet: ['--out'],
  check: ['--out'],
  export: ['--out', '--name'],
};

/** Every `icons.mjs <subcommand> ...` invocation in a text, with its flags. */
function invocations(text) {
  const found = [];
  for (const match of text.matchAll(/icons\.mjs"?\s+([a-z]+)([^\n`]*)/g)) {
    found.push({ subcommand: match[1], flags: match[2].match(/--[a-z][a-z-]*/g) ?? [], line: match[0] });
  }
  return found;
}

function section(text, from, to) {
  const start = text.indexOf(from);
  const end = to ? text.indexOf(to, start) : text.length;
  assert.ok(start >= 0 && end > start, `section ${from} .. ${to} exists`);
  return text.slice(start, end);
}

test('the help text lists the import command and its flags', () => {
  assert.match(help, /node icons\.mjs import <image> --out <dir> --name <name>/);
  for (const flag of ['--background', '--tolerance', '--force', '--renderer']) assert.ok(KNOWN_FLAGS.has(flag), flag);
  for (const mode of BACKGROUND_MODES) assert.match(help, new RegExp(mode));
});

for (const [label, text] of [['SKILL.md', SKILL], ['README.md', README]]) {
  test(`${label}: every shown command uses a real subcommand, real flags and its required flags`, () => {
    const all = invocations(text);
    assert.ok(all.length >= 5, `${label} shows commands`);
    for (const { subcommand, flags, line } of all) {
      assert.ok(SUBCOMMANDS.includes(subcommand), `unknown subcommand in: ${line}`);
      for (const flag of flags) assert.ok(KNOWN_FLAGS.has(flag), `unknown flag ${flag} in: ${line}`);
      for (const required of REQUIRED_FLAGS[subcommand] ?? []) {
        assert.ok(flags.includes(required), `${required} missing in: ${line}`);
      }
    }
    assert.ok(all.some((c) => c.subcommand === 'import'), `${label} shows the import command`);
  });
}

test('the skill asks question 0 alone, with the owner-specified wording and options', () => {
  assert.match(SKILL_FLAT, /\*\*Should I draw the icon for you or use your own image file\?\*\*/);
  assert.match(SKILL_FLAT, /`Draw one for me`/);
  assert.match(SKILL_FLAT, /`Use my image file`/);
  assert.match(SKILL_FLAT, /in its own `AskUserQuestion` call/);
  assert.match(SKILL_FLAT, /Skip question 0\*\* when the command argument or the user's message already/);
  assert.match(SKILL_FLAT, /path to an existing image file/);
  assert.match(COMMAND_FLAT, /Should I draw the icon for you or use your own image file\?/);
  assert.match(COMMAND_FLAT, /`Draw one for me`/);
  assert.match(COMMAND_FLAT, /`Use my image file`/);
  assert.match(COMMAND_FLAT, /no question about how many icons and no approval step/);
});

test('file mode asks only the location question and builds exactly one icon at once', () => {
  const rawFile = section(SKILL, '## File mode', '## Draw mode');
  const file = flat(rawFile);
  assert.match(file, /Exactly ONE icon, and the full set right away/);
  assert.match(file, /Do not ask how many icons and do not ask for approval first/);
  assert.match(file, /Ask ONLY the location question/);
  assert.match(file, /\(header `Location`\)/);
  for (const forbidden of ['Which icon should I create', 'How many different icons', 'Show the icons for approval first']) {
    assert.ok(!file.includes(forbidden), `file mode must not ask: ${forbidden}`);
  }
  // It still looks at the result and runs the mandatory 16 px check.
  assert.match(file, /sheet icon-work\/my-app-master\.svg/);
  assert.match(file, /The 16 px test \(mandatory, never skip\)/);
  assert.match(file, /check icon-work\/my-app-master\.svg/);
  // A raster has no hand-drawn small variant, and the three real options are offered.
  assert.ok(!invocations(rawFile).some((c) => c.flags.includes('--small')));
  assert.match(file, /cannot get a hand-drawn small variant/);
  assert.match(file, /`Accept it as it is`/);
  assert.match(file, /`I will supply a simpler image`/);
  assert.match(file, /`Draw one for me instead`/);
  assert.match(file, /Relay every warning/);
});

test('draw mode keeps exactly the four existing questions in one call', () => {
  const draw = flat(section(SKILL, '## Draw mode', '## Tell the user what exists'));
  assert.match(draw, /these four questions in ONE `AskUserQuestion` call/);
  for (const header of ['Icon', 'Location', 'How many', 'Approval']) {
    assert.ok(draw.includes(`(header \`${header}\`)`), `draw mode asks the ${header} question`);
  }
  assert.match(draw, /Make the full set right away \(Recommended\)/);
  assert.match(draw, /Show me the icons first/);
});

test('every warning code the tool can print is explained in the skill', () => {
  const codes = [...IMPORT_SOURCE.matchAll(/code: '([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 7, `found codes: ${codes}`);
  for (const code of new Set(codes)) assert.ok(SKILL.includes(`\`${code}\``), `${code} is explained in SKILL.md`);
});

test('documented limits and defaults match the code in every document', () => {
  assert.equal(MAX_INPUT_BYTES, 25 * 1024 * 1024);
  assert.equal(MAX_SIDE, 8192);
  for (const [name, text] of [['README', README], ['PRIVACY', PRIVACY], ['SECURITY', SECURITY], ['SKILL', SKILL]]) {
    assert.match(flat(text), /25 MB/, `${name} states the byte cap`);
    assert.match(flat(text), /8192 x 8192/, `${name} states the pixel cap`);
  }
  assert.match(flat(README), new RegExp(`default ${DEFAULT_TOLERANCE} of 255`));
  assert.match(SKILL_FLAT, new RegExp(`default ${DEFAULT_TOLERANCE}\\)`));
});

test('the privacy-relevant documents say the plugin reads the one image file the user names', () => {
  assert.match(flat(PRIVACY), /the one image file you name for the `import` command/);
  assert.match(flat(PRIVACY), /never run, and nothing in it is fetched/);
  assert.match(flat(PRIVACY), /it makes no network requests/);
  assert.match(flat(SECURITY), /the one image file you give to `import`/);
  assert.match(SKILL_FLAT, /the one image file the user named for `import`/);
  assert.match(flat(README), /The only files it reads are the SVGs and the one image file you name/);
  assert.ok(!/reads no user files beyond the SVGs you point it at;/.test(SKILL_FLAT), 'the old, now false sentence is gone');
});

test('the skill and the command have valid front matter and the version is bumped', () => {
  for (const [name, text] of [['skill', SKILL], ['command', COMMAND]]) {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(match, `${name} has front matter`);
    assert.match(match[1], /^description: .+$/m, `${name} has a one-line description`);
  }
  assert.match(COMMAND, /\$ARGUMENTS/);
  assert.match(SKILL, /^name: icon-creator$/m);
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.version, '0.2.1');
  assert.match(manifest.description, /your own image file/);
});

// ---- several icons: the fifth question and parallel subagents --------------

const AGENT = read('agents/icon-designer.md');
const AGENT_FLAT = flat(AGENT);

test('the fifth question is asked only for two or more icons, in a second call, with both options described', () => {
  const draw = flat(section(SKILL, '## Draw mode', '## Tell the user what exists'));
  assert.match(draw, /only when the answer to "How many" is 2 or more/);
  assert.match(draw, /SECOND `AskUserQuestion` call, after the four answers are in/);
  assert.match(draw, /one call can hold at most four questions/);
  assert.match(draw, /\*\*How should I make the different icons\?\*\* \(header `Method`\)/);
  assert.match(draw, /`One by one in this conversation \(Recommended\)` - description: "Simpler and cheaper in tokens/);
  assert.match(draw, /`In parallel, one subagent per icon` - description: "Faster, but uses more tokens/);
  assert.match(draw, /Skip it when N is 1, or when the user already said how/);
  assert.match(draw, /File mode never asks this/);
  // The file-mode section must not mention the fifth question or subagents at all.
  const file = flat(section(SKILL, '## File mode', '## Draw mode'));
  assert.ok(!/How should I make the different icons|subagent/i.test(file));
});

test('parallel mode: motifs first, one subagent per icon in one message, own folders, previews, own verification', () => {
  const parallel = flat(section(SKILL, '### Parallel mode: one subagent per icon', '## Tell the user what exists'));
  assert.match(parallel, /Write N clearly different motifs, one line each/);
  assert.match(parallel, /so the subagents cannot converge on the same idea/);
  assert.match(parallel, /Start ONE subagent per icon, all in the same message/);
  assert.match(parallel, /N calls of Claude Code's Agent tool in a single response/);
  assert.match(parallel, /`icon-creator:icon-designer`/);
  assert.match(parallel, /writes ONLY inside `<root>\/icon-work\/<k>\/` and, in `full` mode, `<root>\/<name>-<k>\/`/);
  assert.match(parallel, /copy the previews to `<root>\/preview\/icon-<k>\.png`/);
  assert.match(parallel, /build ONE combined contact sheet/);
  assert.match(parallel, /Wait for the answer/);
  assert.match(parallel, /never trust a report alone/);
  assert.match(parallel, /open its images with the Read tool/);
  assert.match(parallel, /per icon: the motif, the folder, the files, the warnings/);
  const combined = invocations(section(SKILL, '### Parallel mode: one subagent per icon', '## Tell the user what exists')).find((c) => c.subcommand === 'sheet');
  assert.ok(combined && combined.flags.includes('--out'), 'the combined contact sheet command is shown');
  assert.match(SKILL_FLAT, /the one image file the user named for `import`/, 'file-mode privacy text is intact');
});

test('the icon-designer agent file is valid, minimal in tools and points at the real tool', () => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(AGENT);
  assert.ok(match, 'agent front matter');
  const fields = Object.fromEntries(match[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name', 'tools']);
  assert.equal(fields.name, 'icon-designer');
  assert.ok(fields.description.length > 40 && !fields.description.includes('\n'), 'single-string description');
  assert.deepEqual(fields.tools.split(',').map((tool) => tool.trim()), ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
  assert.ok(!/WebFetch|WebSearch|mcp__/.test(AGENT), 'no network or MCP tools');
  assert.ok(AGENT.includes('${CLAUDE_PLUGIN_ROOT}/scripts/icons.mjs'), 'the script is referenced through CLAUDE_PLUGIN_ROOT');
});

test('every command in the agent file uses a real subcommand and flags, and stays in the agent\'s own folders', () => {
  const all = invocations(AGENT);
  assert.ok(all.length >= 5);
  for (const { subcommand, flags, line } of all) {
    assert.ok(SUBCOMMANDS.includes(subcommand), `unknown subcommand in: ${line}`);
    for (const flag of flags) assert.ok(KNOWN_FLAGS.has(flag), `unknown flag ${flag} in: ${line}`);
    for (const required of REQUIRED_FLAGS[subcommand] ?? []) assert.ok(flags.includes(required), `${required} missing in: ${line}`);
  }
  assert.match(AGENT_FLAT, /Write ONLY inside `<root>\/icon-work\/<k>\/`/);
  assert.match(AGENT_FLAT, /`<root>\/<name>-<k>\/`/);
  assert.match(AGENT_FLAT, /Never touch another icon's folder, `<root>\/preview\/`/);
  assert.match(AGENT_FLAT, /Mode `preview`:\*\* render the preview and STOP/);
  assert.match(AGENT_FLAT, /Do not claim a result you did not see/);
  // Every command writes below the agent's own folders.
  for (const { subcommand, line } of all) {
    if (subcommand === 'doctor') continue;
    const target = /--out\s+(\S+)/.exec(line)[1];
    assert.ok(/^(icon-work\/<k>\/|<name>-<k>$)/.test(target), `${subcommand} writes to ${target}`);
  }
});

test('the agent file carries the same hard and design rules as the skill', () => {
  const designTitles = [...SKILL.matchAll(/^\d\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]).filter((title) => /shape|Fill|contrast|container|colours|Flat|16 px|No text/.test(title));
  assert.ok(designTitles.length >= 8, `found design rule titles in the skill: ${designTitles}`);
  for (const title of designTitles) assert.ok(AGENT.includes(`**${title}**`), `the agent has design rule "${title}"`);
  for (const phrase of ['`<script>`', 'event handlers', '`<foreignObject>`', 'DOCTYPEs', 'non-raster `data:` URL', 'Draw letters as paths', 'at least 12 units wide']) {
    assert.ok(AGENT_FLAT.includes(phrase), `the agent states: ${phrase}`);
  }
});

test('README and the command describe the fifth question and the parallel option', () => {
  assert.match(flat(README), /a fifth question follows: make them \*\*one by one\*\*/);
  assert.match(flat(README), /\*\*in parallel, one subagent per icon\*\*/);
  assert.match(flat(README), /The restriction to an agent's own folder is an instruction, not a sandbox/);
  assert.match(COMMAND_FLAT, /a fifth question in a second call/);
  assert.match(COMMAND_FLAT, /one subagent per icon \(`icon-designer`/);
  assert.match(COMMAND_FLAT, /you check every subagent's result yourself/);
});

// ---- review 13: SVG sources and the wiring instructions ---------------------

test('the skill, command and README treat an SVG source differently from a raster source', () => {
  const file = flat(section(SKILL, '## File mode', '## Draw mode'));
  assert.match(file, /If the file is an SVG, everything about the raster master is different/);
  assert.match(file, /ONE file, `icon-work\/my-app-master\.svg` \(no PNG, no background handling, none of the warning codes below\)/);
  assert.match(file, /ALL files are written, including `icon\.svg`, `web\/favicon\.svg` and `linux\/scalable\/apps\/<name>\.svg`/);
  assert.match(file, /When the master is a raster \(PNG, JPEG, WebP, GIF, BMP source\), the export does NOT write/);
  assert.match(file, /For an SVG source it writes every file and skips nothing/);
  assert.match(file, /an SVG source can: draw `icon-work\/small\.svg`/);
  assert.match(file, /for a raster source that no vector files exist/);
  assert.ok(!/Because the master is a raster, the export does NOT write/.test(file), 'the unconditional claim is gone');
  assert.match(COMMAND_FLAT, /an SVG file is only validated and copied/);
  assert.match(COMMAND_FLAT, /For a raster file \(PNG, JPEG, WebP, GIF, BMP\) say which vector files are not written/);
  assert.match(COMMAND_FLAT, /an SVG file keeps all of them/);
  const readme = flat(README);
  assert.match(readme, /\*\*A raster file \(PNG, JPEG, WebP, GIF, BMP\)\*\* becomes a prepared master/);
  assert.match(readme, /\*\*An SVG file\*\* is validated by the normal SVG rules and copied unchanged to one file, `<name>-master\.svg`: no PNG/);
  assert.match(readme, /the export writes every file, including `icon\.svg`/);
});

test('every <set>/ path in the wiring instructions is a file the export really writes', () => {
  const wiring = section(SKILL, '## Tell the user what exists and how to wire it', '## What this tool will never do');
  const planned = new Set(planFiles('my-app', TARGETS).map((file) => file.rel));
  // <set> is followed by a forward slash or (in the csproj line) a backslash.
  const paths = [...wiring.matchAll(/<set>[\\/]([A-Za-z0-9_.@\-\\/<>]+)/g)].map((match) =>
    match[1]
      .replaceAll('\\', '/')
      .replace(/<\/.*$/, '') // the closing tag of the csproj line
      .replace('<name>', 'my-app')
      .replace(/[.,;:)]+$/, ''),
  );
  assert.ok(paths.length >= 10, `found paths: ${paths}`);
  for (const rel of paths) {
    if (rel === 'hicolor/') continue; // a directory (the Linux copy instruction)
    const concrete = rel.replace('<N>x<N>', '48x48');
    assert.ok(
      planned.has(concrete) || [...planned].some((file) => file.startsWith(concrete)),
      `the wiring section names <set>/${rel} but the export never writes it`,
    );
  }
});

test('the Tauri instruction lists only PNG, ICNS and ICO files and keeps the SVG out of bundle.icon', () => {
  const wiring = flat(section(SKILL, '## Tell the user what exists and how to wire it', '## What this tool will never do'));
  const tauri = /\*\*Tauri:\*\* (.*?)(?= - \*\*Qt:\*\*)/.exec(wiring);
  assert.ok(tauri, 'a Tauri line exists');
  const [list, aside = ''] = tauri[1].split('The scalable SVG');
  assert.match(list, /takes PNG, ICNS and ICO files only/);
  const listed = [...list.matchAll(/<set>\/([^\s`,]+)/g)].map((m) => m[1].replace(/[.,;]+$/, ''));
  assert.deepEqual(listed.map((rel) => rel.split('.').pop()), ['png', 'png', 'png', 'icns', 'ico']);
  assert.ok(!listed.some((rel) => rel.endsWith('.svg')), 'no SVG in the bundle.icon list');
  assert.deepEqual(listed.slice(0, 3).map((rel) => /hicolor\/(\d+)x/.exec(rel)[1]), ['32', '128', '256']);
  assert.match(aside, /belongs to a Linux icon-theme install, not to this list/);
});

// ---- CI fix round: links in named paths, and the CI job itself --------------

test('the documents describe the link behaviour truthfully and the old absolute claims are gone', () => {
  const readme = flat(README);
  assert.match(readme, /\*\*Links in the paths you type\.\*\*/);
  assert.match(readme, /macOS keeps `\/var`, `\/tmp` and `\/etc` as links into `\/private`/);
  assert.match(readme, /follows such a link once, works in the real location and says so/);
  assert.match(readme, /It refuses a link \*\*inside your current folder\*\*/);
  assert.match(readme, /the error names the real path to pass instead/);
  assert.match(readme, /Below an output folder it never follows a link/);
  assert.match(flat(SECURITY), /links in the directories you name are followed once and reported, a link inside the current folder is refused/);
  assert.match(SKILL_FLAT, /\*\*Paths and links\.\*\*/);
  assert.match(SKILL_FLAT, /prints a line starting with `Note:` that names the real location/);
  assert.match(SKILL_FLAT, /If a command is refused because a link lies INSIDE the current folder, the error names the real path/);
  assert.match(AGENT_FLAT, /quote the real path from the error and stop, do not work around it/);
  for (const [name, text] of [['README', readme], ['SECURITY', flat(SECURITY)], ['SKILL', SKILL_FLAT]]) {
    assert.ok(!/no links in its path|reached through real directories|must not pass through a symbolic link|links and junctions are refused/.test(text), `${name} no longer claims every link is refused`);
  }
});

test('the CLI note the documents quote is the note the tool prints', () => {
  const note = linkNote('The output folder', { typed: '/tmp/icons', path: '/private/tmp/icons' });
  assert.equal(note, 'Note: The output folder /tmp/icons goes through a symbolic link or junction; using its real location /private/tmp/icons.');
  assert.match(flat(README), /`Note: \.\.\. goes through a symbolic link or junction; using its real location \.\.\.`/);
});

test('the CI job covers the three systems and both Node versions with room for slow runners', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(workflow, /node: \[18, 22\]/);
  const minutes = Number(/timeout-minutes: (\d+)/.exec(workflow)[1]);
  assert.ok(minutes >= 30, `timeout-minutes is ${minutes}; the slow Windows runner needs at least 30`);
});

test('the link rule is documented for input paths as well as output paths', () => {
  const readme = flat(README);
  assert.match(readme, /This covers every path you name: the output folder or file, the SVG you render, sheet, check or export \(and its small variant\), and the image you import/);
  assert.match(readme, /it never reads an input file that is itself a link/);
  assert.match(SKILL_FLAT, /This applies to every path you pass - the SVG or image you read as well as the folder or file you write/);
  assert.match(SKILL_FLAT, /A file that is itself a link is refused as an input/);
  assert.match(flat(read('CHANGELOG.md')), /The same link rule now covers every input path/);
});
