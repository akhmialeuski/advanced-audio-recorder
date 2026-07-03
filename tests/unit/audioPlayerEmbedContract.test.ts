/**
 */

/**
 * Regression guard for the embed lifecycle contract. The enhanced player is
 * handed to Obsidian as an embed component via the embed-registry override.
 * In Live Preview, Obsidian's CodeMirror embed widget calls `loadFile()` on
 * that component while building the embed DOM. When the method was missing,
 * the call threw "loadFile is not a function", which crashed the editor and
 * left the whole note blank (Obsidian then reported "Failed to open"). Reading
 * view renders through onload and never calls loadFile, so only edited notes
 * broke. This test pins the method's presence so the regression cannot return.
 * @module tests/unit/audioPlayerEmbedContract.test
 */

import { AudioPlayer } from 'src/player/AudioPlayer';

describe('AudioPlayer embed contract', () => {
	it('exposes loadFile so the Live Preview embed widget never crashes', () => {
		expect(typeof AudioPlayer.prototype.loadFile).toBe('function');
	});
});
