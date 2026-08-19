/**
 * Guards the player's mode/decision single source of truth - the logic
 * behind two recurring regressions: Reading view wrongly showing editable
 * marker controls, and video/unsupported files being taken over instead
 * of left to the built-in player.
 */

import { isEditableContext, shouldEnhance } from 'src/player/playerMode';
import type { MediaKind } from 'src/player/mediaProbe';

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
	it.each([
		{
			name: 'the CodeMirror editor (Live Preview)',
			parent: 'cm-editor',
			editable: true,
		},
		{
			name: 'the reading view',
			parent: 'markdown-reading-view',
			editable: false,
		},
		{
			name: 'an unknown container',
			parent: 'some-other-plugin',
			editable: false,
		},
	])('is editable inside $name: $editable', ({ parent, editable }) => {
		expect(isEditableContext(childOf(parent))).toBe(editable);
	});

	it('is read-only while detached from any note', () => {
		// A widget Obsidian has not mounted yet: offering marker editing
		// there would write into a note the player is not in.
		expect(isEditableContext(document.createElement('div'))).toBe(false);
	});
});

describe('shouldEnhance', () => {
	it.each([
		{
			name: 'audio, with the feature on',
			enabled: true,
			kind: 'audio',
			expected: true,
		},
		{ name: 'video', enabled: true, kind: 'video', expected: false },
		{
			name: 'a file nothing can play',
			enabled: true,
			kind: 'unsupported',
			expected: false,
		},
		{
			name: 'a file not probed yet',
			enabled: true,
			kind: null,
			expected: false,
		},
		{
			name: 'audio, with the feature off',
			enabled: false,
			kind: 'audio',
			expected: false,
		},
		{
			name: 'video, with the feature off',
			enabled: false,
			kind: 'video',
			expected: false,
		},
	])('enhances $name: $expected', ({ enabled, kind, expected }) => {
		// Taking over a video embed replaces the picture with an audio bar,
		// and taking over before the probe answers does it on a guess.
		expect(shouldEnhance(enabled, kind as MediaKind | null)).toBe(expected);
	});
});
