/**
 * Tests for the embed-to-actions association the context menu uses to drive
 * a live player without importing the DOM-heavy player module. The link is a
 * WeakMap keyed by the embed element, so nothing is stored on the DOM node.
 */

import {
	setPlayerEmbedActions,
	getPlayerEmbedActions,
	clearPlayerEmbedActions,
	type PlayerEmbedActions,
} from 'src/player/playerEmbedActions';

function makeActions(): PlayerEmbedActions {
	return {
		markersEnabled: true,
		timestampLinksEnabled: true,
		timeAtClientX: () => 0,
		addMarkerAtTime: () => undefined,
		copyTimestampAtTime: () => undefined,
		togglePlayback: () => undefined,
	};
}

describe('playerEmbedActions', () => {
	it('returns undefined for an embed with no published actions', () => {
		const embed = document.createElement('div');
		expect(getPlayerEmbedActions(embed)).toBeUndefined();
	});

	it('returns the actions published for an embed', () => {
		const embed = document.createElement('div');
		const actions = makeActions();
		setPlayerEmbedActions(embed, actions);
		expect(getPlayerEmbedActions(embed)).toBe(actions);
	});

	it('clears the actions for an embed', () => {
		const embed = document.createElement('div');
		setPlayerEmbedActions(embed, makeActions());
		clearPlayerEmbedActions(embed);
		expect(getPlayerEmbedActions(embed)).toBeUndefined();
	});

	it('keeps actions independent per embed', () => {
		const a = document.createElement('div');
		const b = document.createElement('div');
		const actionsA = makeActions();
		setPlayerEmbedActions(a, actionsA);
		expect(getPlayerEmbedActions(a)).toBe(actionsA);
		expect(getPlayerEmbedActions(b)).toBeUndefined();
	});

	it('overwrites the actions when published again', () => {
		const embed = document.createElement('div');
		const first = makeActions();
		const second = makeActions();
		setPlayerEmbedActions(embed, first);
		setPlayerEmbedActions(embed, second);
		expect(getPlayerEmbedActions(embed)).toBe(second);
	});
});
