/**
 * Counts duplicated blocks in the test suite, and refuses to let the count
 * grow.
 *
 * Copy-paste is how a test suite rots: the fifth copy of an arrangement is the
 * one nobody updates, and it keeps passing while the other four move on. The
 * number here is the one that can actually be worked down - distinct maximal
 * blocks that appear identically in two or more places, and the lines those
 * repeats cost.
 *
 * Two things are deliberately not counted, because neither can be deduped:
 * import statements, and `jest.mock` calls, which jest hoists per module so
 * they cannot live in a helper a suite imports.
 *
 * Usage: node scripts/clone-check.mjs [--list]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** Shortest run of lines that counts as a clone rather than a coincidence. */
const WINDOW = 6;
/** Shortest such run by characters, so six short lines are not a "block". */
const MIN_CHARS = 120;
/** Ceilings: the counts the suite sits at, lowered as the work is done. */
const MAX_GROUPS = 211;
const MAX_REDUNDANT_LINES = 1825;

/**
 * Normalises a line for comparison, dropping comments and blank lines: two
 * blocks that differ only in their comments are still the same block.
 * @param line - Raw source line
 * @returns The comparable text, or null when the line carries none
 */
function normalise(line) {
	const trimmed = line.trim();
	if (
		!trimmed ||
		trimmed.startsWith('//') ||
		trimmed.startsWith('*') ||
		trimmed.startsWith('/*')
	) {
		return null;
	}
	return trimmed.replace(/\s+/g, ' ');
}

/**
 * Whether a block is mostly module plumbing, which no helper can absorb.
 * @param lines - Normalised lines of the block
 * @returns True when the block is imports and hoisted mock declarations
 */
function isPlumbing(lines) {
	const plumbing = lines.filter(
		(line) =>
			line.startsWith('import ') ||
			line.startsWith('export ') ||
			line.startsWith("} from '") ||
			line.startsWith('jest.mock(') ||
			line.startsWith("require('") ||
			line.startsWith(') =>') ||
			/^\w+,$/.test(line) ||
			[');', '}));', '},', '};', '));'].includes(line),
	).length;
	return plumbing / lines.length > 0.6;
}

/**
 * Every TypeScript file under a directory.
 * @param dir - Directory to walk
 * @returns Repo-relative paths
 */
function sourceFiles(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...sourceFiles(full));
		} else if (entry.name.endsWith('.ts')) {
			found.push(full);
		}
	}
	return found;
}

/** Digest of a string, for grouping identical blocks. */
const digest = (text) =>
	crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

const lineage = new Map();
const windows = new Map();

for (const file of sourceFiles(path.join(ROOT, 'tests')).sort()) {
	const relative = path.relative(ROOT, file);
	const lines = fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.map((line, index) => ({ number: index + 1, text: normalise(line) }))
		.filter((line) => line.text !== null);
	lineage.set(relative, lines);
	for (let start = 0; start + WINDOW <= lines.length; start++) {
		const block = lines.slice(start, start + WINDOW).map((l) => l.text);
		const text = block.join('\n');
		if (text.length < MIN_CHARS || isPlumbing(block)) {
			continue;
		}
		const key = digest(text);
		windows.set(key, [...(windows.get(key) ?? []), { relative, start }]);
	}
}

// Every line covered by a window that appears more than once, merged back into
// the maximal run it belongs to: one 20-line clone is one finding, not fifteen.
const covered = new Map();
for (const spots of windows.values()) {
	if (spots.length < 2) {
		continue;
	}
	for (const { relative, start } of spots) {
		const set = covered.get(relative) ?? new Set();
		for (let offset = 0; offset < WINDOW; offset++) {
			set.add(start + offset);
		}
		covered.set(relative, set);
	}
}

const groups = new Map();
for (const [relative, indices] of covered) {
	const lines = lineage.get(relative);
	for (const start of [...indices].sort((a, b) => a - b)) {
		if (indices.has(start - 1)) {
			continue;
		}
		let end = start;
		while (indices.has(end + 1)) {
			end += 1;
		}
		const text = lines
			.slice(start, end + 1)
			.map((l) => l.text)
			.join('\n');
		const key = digest(text);
		groups.set(key, [
			...(groups.get(key) ?? []),
			{ relative, line: lines[start].number, size: end - start + 1 },
		]);
	}
}

const clones = [...groups.values()].filter((copies) => copies.length > 1);
const redundant = clones.reduce(
	(total, copies) => total + copies.slice(1).reduce((n, c) => n + c.size, 0),
	0,
);

if (process.argv.includes('--list')) {
	const ranked = clones
		.map((copies) => ({
			copies,
			waste: copies.slice(1).reduce((n, c) => n + c.size, 0),
		}))
		.sort((a, b) => b.waste - a.waste);
	for (const { copies, waste } of ranked.slice(0, 25)) {
		console.log(
			`${String(waste).padStart(4)} lines  ${copies.length} copies x ${copies[0].size}`,
		);
		for (const copy of copies) {
			console.log(`        ${copy.relative}:${copy.line}`);
		}
	}
	console.log();
}

const groupsOk = clones.length <= MAX_GROUPS;
const linesOk = redundant <= MAX_REDUNDANT_LINES;
console.log(
	`${groupsOk ? 'ok  ' : 'OVER'} ${String(clones.length).padStart(4)} / ${String(MAX_GROUPS)}   duplicated blocks`,
);
console.log(
	`${linesOk ? 'ok  ' : 'OVER'} ${String(redundant).padStart(4)} / ${String(MAX_REDUNDANT_LINES)}  lines those repeats cost`,
);

if (!groupsOk || !linesOk) {
	console.error(
		'\nDuplication grew. Name the repeated arrangement in a helper, or ' +
			'run with --list to see what is repeated.',
	);
	process.exit(1);
}

console.log('\nTest duplication is within its ceiling.');
