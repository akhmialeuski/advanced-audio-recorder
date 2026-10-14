/**
 * How a long-running job tells the user what went wrong or what it did.
 *
 * A job started from a dialog has the user in front of the app, and a notice
 * is the right place for what it has to say. A job started from the command
 * line has the user at a terminal: the same sentences belong in the answer
 * the command prints, and still in a notice for whoever is watching the app.
 * Taking the reporter as a parameter is what lets one pipeline serve both.
 * @module utils/notify
 */

import { Notice } from 'obsidian';

/** Says one sentence to the user. */
export type Notify = (message: string) => void;

/** Says it in a notice, which is what every job did before it took a reporter. */
export const showNotice: Notify = (message: string): void => {
	new Notice(message);
};

/** A reporter that also keeps what it was told. */
export interface CollectingNotify {
	/** The reporter to hand the job. */
	readonly notify: Notify;
	/** Everything said through it, in order. */
	readonly messages: readonly string[];
}

/**
 * A reporter that shows each sentence in a notice and keeps it, so a command
 * line answer can repeat what the job said.
 * @returns The reporter and what it collected
 */
export function collectingNotify(): CollectingNotify {
	const messages: string[] = [];
	return {
		notify: (message: string): void => {
			messages.push(message);
			showNotice(message);
		},
		messages,
	};
}
