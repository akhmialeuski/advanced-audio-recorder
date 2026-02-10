/**
 * Unit tests for AudioStreamHandler utilities.
 * @module tests/unit/AudioStreamHandler.test
 */

import { getOrderedTrackSources } from '../../src/recording/AudioStreamHandler';
import { DEFAULT_SETTINGS } from '../../src/settings/Settings';

describe('AudioStreamHandler', () => {
    describe('getOrderedTrackSources', () => {
        it('should return sources in track order regardless of Map insertion order', () => {
            const settings = {
                ...DEFAULT_SETTINGS,
                enableMultiTrack: true,
                maxTracks: 3,
                trackAudioSources: new Map([
                    [2, { deviceId: 'device-2' }],
                    [1, { deviceId: 'device-1' }],
                    [3, { deviceId: 'device-3' }],
                ]),
            };

            const ordered = getOrderedTrackSources(settings);

            expect(ordered.map((source) => source.trackNumber)).toEqual([1, 2, 3]);
            expect(ordered.map((source) => source.deviceId)).toEqual([
                'device-1',
                'device-2',
                'device-3',
            ]);
        });

        it('should skip tracks without selected devices', () => {
            const settings = {
                ...DEFAULT_SETTINGS,
                enableMultiTrack: true,
                maxTracks: 3,
                trackAudioSources: new Map([
                    [1, { deviceId: 'device-1' }],
                    [3, { deviceId: '' }],
                ]),
            };

            const ordered = getOrderedTrackSources(settings);

            expect(ordered.map((source) => source.trackNumber)).toEqual([1]);
        });
    });
});
