/**
 * Audio-file detection shared by menus, commands, and the player.
 * @module utils/audioFile
 */

import type { TFile } from 'obsidian';
import { AUDIO_EXTENSIONS } from '../constants';

/**
 * Checks whether a vault file is an audio file the plugin handles.
 * @param file - The file to check
 * @returns True when the extension is a known audio extension
 */
export function isAudioFile(file: TFile): boolean {
	return AUDIO_EXTENSIONS.includes(file.extension.toLowerCase());
}
