/**
 * Unit tests for the one accessor plugin code reaches the audio engine through.
 * @module tests/unit/audioEngine.test
 */

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));

import { loadAudioEngine } from 'src/audio/audioEngine';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

describe('loadAudioEngine', () => {
	it('hands every caller the same engine module', async () => {
		const [first, second] = await Promise.all([
			loadAudioEngine(),
			loadAudioEngine(),
		]);

		expect(second).toBe(first);
	});

	it('carries the encoder registrations, so they share the engine registry', async () => {
		const engine = await loadAudioEngine();

		expect(engine.registerFlacEncoder).toBe(registerFlacEncoder);
		expect(engine.registerMp3Encoder).toBe(registerMp3Encoder);
	});
});
