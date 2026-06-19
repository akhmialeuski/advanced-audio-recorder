/**
 * Regression guard for the read-only (reading view) player CSS contract.
 * The marker label is a button, which reading-view styling would centre;
 * the fix scopes the rule under `.aar-player` and left-aligns it. These
 * tests parse the stylesheet so that fix cannot silently regress.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

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
	return match ? match[1] : null;
}

describe('read-only player styles', () => {
	it('left-aligns the static marker label, scoped to outrank reading-view buttons', () => {
		const body = ruleBody('.aar-player .aar-player-marker-label-static');
		expect(body).not.toBeNull();
		expect(body).toMatch(/text-align:\s*left/);
		expect(body).toMatch(/justify-content:\s*flex-start/);
	});

	it('hides editing-only controls in read-only mode', () => {
		const body = ruleBody('.aar-player-readonly .aar-player-edit-only');
		expect(body).not.toBeNull();
		expect(body).toMatch(/display:\s*none/);
	});

	it('left-aligned label fills the row so the segment sits at the right', () => {
		const label = ruleBody('.aar-player .aar-player-marker-label-static');
		expect(label).not.toBeNull();
		expect(label).toMatch(/flex:\s*1/);

		const segment = ruleBody('.aar-player-marker-segment');
		expect(segment).not.toBeNull();
	});

	it('makes the whole read-only row a clickable jump target', () => {
		const row = ruleBody('.aar-player-marker-row-clickable');
		expect(row).not.toBeNull();
		expect(row).toMatch(/cursor:\s*pointer/);
	});

	it('highlights the currently-playing segment row', () => {
		const active = ruleBody('.aar-player-marker-row.is-active');
		expect(active).not.toBeNull();
		expect(active).toMatch(/background-color/);
	});

	it('frames the waveform in a padded bordered rectangle', () => {
		const waveform = ruleBody('.aar-player-seek-waveform');
		expect(waveform).not.toBeNull();
		expect(waveform).toMatch(/border:/);
		expect(waveform).toMatch(/border-radius:/);
		expect(waveform).toMatch(/padding:/);
		// content-box keeps the canvas height equal to the waveform height
		expect(waveform).toMatch(/box-sizing:\s*content-box/);
	});
});

describe('plain seek bar (waveform off)', () => {
	it('is a spaced, rounded track that stands out from the controls and list', () => {
		const bar = ruleBody('.aar-player-seek-bar');
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
		const fill = ruleBody('.aar-player-progress-fill');
		expect(fill).not.toBeNull();
		expect(fill).toMatch(/width:\s*var\(--aar-progress/);
		expect(fill).toMatch(/background-color:\s*var\(--color-accent\)/);
	});

	it('marks the current position with an accent thumb tied to the progress', () => {
		const thumb = ruleBody('.aar-player-progress-thumb');
		expect(thumb).not.toBeNull();
		expect(thumb).toMatch(/left:\s*var\(--aar-progress/);
		expect(thumb).toMatch(/background-color:\s*var\(--color-accent\)/);
		expect(thumb).toMatch(/border-radius:\s*50%/);
	});
});
