/** @jest-environment jsdom */
/**
 * Guards the player's mode/decision single source of truth — the logic
 * behind two recurring regressions: Reading view wrongly showing editable
 * marker controls, and video/unsupported files being taken over instead
 * of left to the built-in player.
 */

import { isEditableContext, shouldEnhance } from 'src/player/playerMode';

/** Creates a child element inside a parent with the given class. */
function childOf(parentClass: string): HTMLElement {
	const parent = document.createElement('div');
	parent.className = parentClass;
	const child = document.createElement('div');
	parent.appendChild(child);
	document.body.appendChild(parent);
	return child;
}

describe('isEditableContext', () => {
	it('is editable inside the CodeMirror editor (Live Preview)', () => {
		expect(isEditableContext(childOf('cm-editor'))).toBe(true);
	});

	it('is read-only inside the reading view', () => {
		expect(isEditableContext(childOf('markdown-reading-view'))).toBe(false);
	});

	it('is read-only when detached or in an unknown context', () => {
		expect(isEditableContext(document.createElement('div'))).toBe(false);
	});
});

describe('shouldEnhance', () => {
	it('enhances only enabled, audio-only files', () => {
		expect(shouldEnhance(true, 'audio')).toBe(true);
	});

	it('leaves video and unsupported files to the built-in player', () => {
		expect(shouldEnhance(true, 'video')).toBe(false);
		expect(shouldEnhance(true, 'unsupported')).toBe(false);
	});

	it('never enhances when the feature is disabled', () => {
		expect(shouldEnhance(false, 'audio')).toBe(false);
		expect(shouldEnhance(false, 'video')).toBe(false);
	});

	it('does not enhance a not-yet-probed file (null kind)', () => {
		expect(shouldEnhance(true, null)).toBe(false);
	});
});
