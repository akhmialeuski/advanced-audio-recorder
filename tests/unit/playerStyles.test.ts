/**
 * Regression guard for the read-only (reading view) player CSS contract.
 * The marker label is a button, which reading-view styling would centre;
 * the fix scopes the rule under `.aar-player` and left-aligns it. These
 * tests parse the stylesheet so that fix cannot silently regress.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { MARKER, PLAYER } from '../helpers/selectors';

const css = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8');

/** Escapes a literal string for use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the declaration body of a CSS rule, or null when absent. */
function ruleBody(selector: string): string | null {
	const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`).exec(
		css,
	);
	return match?.[1] ?? null;
}

describe('read-only player styles', () => {
	it('left-aligns the static marker label, scoped to outrank reading-view buttons', () => {
		const body = ruleBody(PLAYER.scopedStaticLabel);
		expect(body).not.toBeNull();
		expect(body).toMatch(/text-align:\s*left/);
		expect(body).toMatch(/justify-content:\s*flex-start/);
	});

	it('hides editing-only controls in read-only mode', () => {
		const body = ruleBody(PLAYER.readonlyEditOnly);
		expect(body).not.toBeNull();
		expect(body).toMatch(/display:\s*none/);
	});

	it('left-aligned label fills the row so the segment sits at the right', () => {
		const label = ruleBody(PLAYER.scopedStaticLabel);
		expect(label).not.toBeNull();
		expect(label).toMatch(/flex:\s*1/);

		const segment = ruleBody(MARKER.segment);
		expect(segment).not.toBeNull();
	});

	it('makes the whole read-only row a clickable jump target', () => {
		const row = ruleBody(MARKER.clickableRow);
		expect(row).not.toBeNull();
		expect(row).toMatch(/cursor:\s*pointer/);
	});

	it('highlights the currently-playing segment row', () => {
		const active = ruleBody(MARKER.activeRow);
		expect(active).not.toBeNull();
		expect(active).toMatch(/background-color/);
	});

	it('leaves an uncoloured tick the colour its kind always gave it', () => {
		const bookmark = ruleBody(MARKER.tickBookmark);
		expect(bookmark).not.toBeNull();
		// The property is read with a fallback, so a marker that carries no
		// colour is drawn exactly as it was before colours existed.
		expect(bookmark).toMatch(
			/background-color:\s*var\(--aar-marker-color,\s*var\(--text-accent\)\)/,
		);
	});

	it('draws a coloured row with an edge in the colour it carries', () => {
		const row = ruleBody(MARKER.coloredRow);
		expect(row).not.toBeNull();
		expect(row).toMatch(/var\(--aar-marker-color\)/);
	});

	it('gives the note a line of its own under the row it belongs to', () => {
		const note = ruleBody(MARKER.noteRule);
		expect(note).not.toBeNull();
		expect(note).toMatch(/flex-basis:\s*100%/);

		const row = ruleBody(MARKER.row);
		expect(row).toMatch(/flex-wrap:\s*wrap/);
	});

	it('frames the waveform in a padded bordered rectangle', () => {
		const waveform = ruleBody(PLAYER.seekWaveform);
		expect(waveform).not.toBeNull();
		expect(waveform).toMatch(/border:/);
		expect(waveform).toMatch(/border-radius:/);
		expect(waveform).toMatch(/padding:/);
		// content-box keeps the canvas height equal to the waveform height
		expect(waveform).toMatch(/box-sizing:\s*content-box/);
	});

	it('stacks the base and played canvases in a positioned layer', () => {
		const layer = ruleBody(PLAYER.waveform);
		expect(layer).not.toBeNull();
		expect(layer).toMatch(/position:\s*relative/);

		const canvas = ruleBody(PLAYER.canvas);
		expect(canvas).not.toBeNull();
		expect(canvas).toMatch(/position:\s*absolute/);
	});

	it('reveals the played waveform with a progress-driven mask, not by redrawing', () => {
		const played = ruleBody(PLAYER.canvasPlayed);
		expect(played).not.toBeNull();
		// The played layer is revealed up to the progress variable by a
		// hard-edged mask, so moving the playhead only repaints the mask (no
		// canvas work). A mask replaces clip-path, which is flagged as only
		// partially supported.
		expect(played).toMatch(/mask-image:\s*linear-gradient\(/);
		expect(played).toMatch(/var\(--aar-progress/);
	});
});

describe('plain seek bar (waveform off)', () => {
	it('is a spaced, rounded track that stands out from the controls and list', () => {
		const bar = ruleBody(PLAYER.seekBar);
		expect(bar).not.toBeNull();
		// Vertical margin separates it from the controls above and list below
		expect(bar).toMatch(/margin:/);
		expect(bar).toMatch(/height:/);
		// Remaining (unplayed) portion is the muted track color
		expect(bar).toMatch(
			/background-color:\s*var\(--background-modifier-border\)/,
		);
	});

	it('fills the played portion with the high-contrast accent, width-driven', () => {
		const fill = ruleBody(PLAYER.progressFill);
		expect(fill).not.toBeNull();
		expect(fill).toMatch(/width:\s*var\(--aar-progress/);
		expect(fill).toMatch(/background-color:\s*var\(--color-accent\)/);
	});

	it('marks the current position with an accent thumb tied to the progress', () => {
		const thumb = ruleBody(PLAYER.progressThumb);
		expect(thumb).not.toBeNull();
		expect(thumb).toMatch(/left:\s*var\(--aar-progress/);
		expect(thumb).toMatch(/background-color:\s*var\(--color-accent\)/);
		expect(thumb).toMatch(/border-radius:\s*50%/);
	});
});
