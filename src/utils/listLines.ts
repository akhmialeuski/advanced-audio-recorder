/**
 * One entry per line, read the way a Markdown note shows a list.
 *
 * A glossary or a roster typed into the settings is plain lines, and the same
 * body kept in a note is almost always a Markdown list under a heading, often
 * with links to other notes, a comment, a horizontal rule, or a callout around
 * it. Both have to yield the same entries, so the rule turning a line into an
 * entry is written once here and every list-shaped profile body is read through
 * it. A writer continuing such a list uses the same grammar, so it writes only
 * what the reader reads back. A prompt is never read this way: its markup is
 * part of the instruction.
 * @module utils/listLines
 */

import { getLinkpath } from 'obsidian';

/** An ATX heading: a section title of the note, never an entry of the list. */
const HEADING_LINE = /^\s{0,3}#{1,6}(?:\s|$)/;

/** A horizontal rule: three or more of one of `-`, `*`, `_`, spaced or not. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** An Obsidian comment, inline or across lines, hidden from the note's reader. */
const COMMENT = /%%[\s\S]*?%%/g;

/** The markers a blockquote or a callout opens each of its lines with. */
const QUOTE_PREFIX = /^[ \t]*(?:>[ \t]?)+/;

/** The type a callout's first line opens with, before the callout's title. */
const CALLOUT_TYPE = /^\[![^\]]*\]/;

/**
 * The markup a list item opens with: its indent, a bullet or an ordered number
 * with its delimiter, then an optional task box. A marker counts only when
 * whitespace or the end of the line follows it, so `*nix` and `1.5x` stay
 * entries as written.
 */
const LIST_MARKER = /^(\s*)(?:([-*+])|(\d+)([.)]))(?:\s+|$)(\[.\](?:\s+|$))?/;

/** A wikilink: the note it names, then an optional alias. */
const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/**
 * Splits a line into its quote markers and the text they quote.
 * @param line - One line of the text
 * @returns The markers, '' for a line outside a quote, and the rest
 */
function unquote(line: string): { quote: string; content: string } {
	const quote = QUOTE_PREFIX.exec(line)?.[0] ?? '';
	return { quote, content: line.slice(quote.length) };
}

/**
 * The name a wikilink shows in place of its markup: its alias when it has one,
 * otherwise the name of the note it links to, without its folder or heading.
 * @param _link - The whole link as matched
 * @param target - The link text before the alias
 * @param alias - The alias, when the link has one
 * @returns The name the link stands for
 */
function linkName(
	_link: string,
	target: string,
	alias: string | undefined,
): string {
	if (alias !== undefined && alias.trim() !== '') {
		return alias;
	}
	const path = getLinkpath(target);
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Splits text into its list entries. Comments are dropped, and a heading, a
 * horizontal rule, or the first line of a callout is skipped. Every other line
 * keeps only the text after its quote and list markers, with each link read as
 * the name it shows. Entries come back untrimmed and possibly blank, because
 * trimming and de-duplicating are the rules of the list being read, which
 * differ between a glossary and a roster.
 * @param text - The body as typed, or as read from a note
 * @returns One entry per line that can hold one
 */
export function listEntries(text: string): string[] {
	return text
		.replace(COMMENT, '')
		.split(/\r?\n/)
		.flatMap((line) => {
			const { quote, content } = unquote(line);
			if (
				HEADING_LINE.test(content) ||
				THEMATIC_BREAK.test(content) ||
				(quote !== '' && CALLOUT_TYPE.test(content))
			) {
				return [];
			}
			return [
				content.replace(LIST_MARKER, '').replace(WIKILINK, linkName),
			];
		});
}

/**
 * How the entry written after a line opens, so an entry appended to a list
 * continues it: the same quote markers and indent, the same bullet or the next
 * number, and an open task box after a task. A line that is no list item gives
 * only its quote markers.
 * @param line - The last line of the list
 * @returns The markup to write before the next entry, possibly ''
 */
export function nextEntryPrefix(line: string): string {
	const { quote, content } = unquote(line);
	const item = LIST_MARKER.exec(content);
	if (!item) {
		return quote;
	}
	const [, indent = '', bullet, number = '', delimiter = '', task] = item;
	const marker = bullet ?? `${String(Number(number) + 1)}${delimiter}`;
	return `${quote}${indent}${marker} ${task === undefined ? '' : '[ ] '}`;
}
