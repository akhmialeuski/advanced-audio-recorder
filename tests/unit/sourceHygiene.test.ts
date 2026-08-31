/**
 * Guards the source tree against bytes that stop it being source.
 *
 * A control character inside a string literal is valid TypeScript and compiles
 * without complaint, but git classifies any file holding one as binary. The
 * module then reaches review as `Bin 0 -> 7436 bytes` instead of its contents:
 * no diff to read, no blame to follow, and no textual merge when two branches
 * touch it. A separator that has to be unprintable belongs in the source as an
 * escape, which is what this checks nobody has gone back on.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

/** The trees whose files are shipped or compiled, and so must stay text. */
const SCANNED_ROOTS = ['src', 'tests'].map((dir) =>
	join(__dirname, '../..', dir),
);

/** The shipped tree, whose doc comments are the ones a reader navigates by. */
const SOURCE_ROOT = join(__dirname, '../..', 'src');

/**
 * The only C0 control bytes a text file legitimately holds: tab, line feed,
 * and carriage return. Every other byte below 0x20, NUL above all, is what
 * makes git stop treating the file as text.
 */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

/**
 * Every TypeScript file under a directory, walked rather than globbed so the
 * check covers files added after it was written.
 * @param dir - Directory to walk
 * @returns Absolute paths of the TypeScript files below it
 */
function typeScriptFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...typeScriptFiles(full));
		} else if (entry.name.endsWith('.ts')) {
			found.push(full);
		}
	}
	return found;
}

describe('the source tree stays text', () => {
	it('holds no control byte that would make git call a module binary', () => {
		const offenders = SCANNED_ROOTS.flatMap(typeScriptFiles)
			.map((file) => ({
				file,
				at: readFileSync(file).findIndex(
					(byte) => byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte),
				),
			}))
			.filter((found) => found.at >= 0)
			.map(
				(found) =>
					`${relative(join(__dirname, '../..'), found.file)} at byte ${String(found.at)}`,
			);

		expect(offenders).toEqual([]);
	});
});

describe('every doc comment still describes the thing under it', () => {
	// A declaration inserted between a doc comment and what it documented
	// leaves two blocks with nothing in between: the first now describes its
	// new neighbour, and the thing it was written for is left undocumented.
	// The compiler is happy, the prose is silently wrong, and an editor
	// hovering the symbol shows a paragraph about something else. Four of
	// these arrived in one branch, which is why it is checked rather than
	// noticed.
	it('has no comment block left stranded above another one', () => {
		const stranded = typeScriptFiles(SOURCE_ROOT).flatMap((file) => {
			const lines = readFileSync(file, 'utf-8').split('\n');
			return lines
				.map((line, index) => ({ line, index }))
				.filter(
					({ line, index }) =>
						line.trim() === '*/' &&
						(lines[index + 1] ?? '').trim().startsWith('/**'),
				)
				.map(
					({ index }) =>
						`${relative(join(__dirname, '../..'), file)} at line ${String(index + 1)}`,
				);
		});

		expect(stranded).toEqual([]);
	});
});
