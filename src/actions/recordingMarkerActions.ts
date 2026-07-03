/**
 * Recording-session marker actions: separate bookmark and chapter
 * commands so each can carry its own hotkey and the kind is fixed
 * up front instead of picked in the modal afterwards.
 * @module actions/recordingMarkerActions
 */

import { COMMAND_IDS } from '../constants';
import { MARKER_KIND, type MarkerKind } from '../markers/markerModel';
import type { RecordingMarkerAction } from './PluginAction';

/**
 * Builds the bookmark/chapter marker actions.
 * @param openMarkerModal - Captures a marker draft of the given kind at
 *   the current recording position and opens the naming modal
 * @returns Marker actions for command registration
 */
export function createRecordingMarkerActions(
	openMarkerModal: (kind: MarkerKind) => void,
): readonly RecordingMarkerAction[] {
	return [
		{
			commandId: COMMAND_IDS.addRecordingBookmark,
			title: 'Add bookmark at current recording position',
			icon: 'bookmark-plus',
			run: (): void => {
				openMarkerModal(MARKER_KIND.bookmark);
			},
		},
		{
			commandId: COMMAND_IDS.addRecordingChapter,
			title: 'Add chapter at current recording position',
			icon: 'list-plus',
			run: (): void => {
				openMarkerModal(MARKER_KIND.chapter);
			},
		},
	];
}
