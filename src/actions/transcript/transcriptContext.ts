/**
 * The target of a transcript action: a selection over rendered transcript
 * lines, as the speakers domain describes it, with the services the action
 * runs against.
 * @module actions/transcript/transcriptContext
 */

import type { ActionServices } from '../core/actionServices';
import type { PluginCommand } from '../core/PluginAction';
import type { TranscriptLineSelection } from '../../speakers/transcriptLineSelection';

/** A selection over transcript lines, with the services every action shares. */
export interface TranscriptSelectionContext extends TranscriptLineSelection {
	/** Injected services shared by every action. */
	readonly services: ActionServices;
}

/**
 * An action on a selection over transcript lines. Rendered into the editor
 * menu, and registered as a palette command that resolves the active editor's
 * selection, so it is hotkey-assignable like every other action.
 */
export type TranscriptAction = PluginCommand<TranscriptSelectionContext>;
