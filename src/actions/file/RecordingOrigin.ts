/**
 * How a recording was reached when an action is asked for it: from the file
 * explorer, from a note, through a link whose place is or is not known, at a
 * moment of it, from the command line, or from a panel that stays open beside
 * the note. The facts stay private, and the recording actions ask the
 * questions they need answered, so a new way of reaching a recording is a new
 * constructor here rather than a new flag every action has to interpret.
 * @module actions/file/RecordingOrigin
 */

import type { Editor, TFile } from 'obsidian';

/** One link in an open editor. */
export interface LinkLocation {
	/** The editor holding it. */
	readonly editor: Editor;
	/**
	 * The subpath of its target with the `#`, as in `#t=90`, or an empty
	 * string for a link to the whole file.
	 */
	readonly subpath: string;
	/** Zero-based line. */
	readonly line: number;
	/** Column the link starts at. */
	readonly start: number;
	/** Column just past its end. */
	readonly end: number;
}

/** What is known about how a recording was reached. */
interface OriginFacts {
	/** The note it was reached through. */
	readonly note?: TFile | undefined;
	/** The link the menu or the cursor was on. */
	readonly link?: LinkLocation | undefined;
	/** Reached through a link whose place in a note is not known. */
	readonly throughLink: boolean;
	/** Reached at a moment of it: a timecode link, or a player at a timestamp. */
	readonly atMoment: boolean;
	/** The note above is the whole truth: there is no active note to fall back on. */
	readonly noteFixed: boolean;
	/** Reached from a surface that stays open beside the note. */
	readonly staysOpen: boolean;
}

/** Nothing known beyond the recording itself. */
const NOTHING_KNOWN: OriginFacts = {
	throughLink: false,
	atMoment: false,
	noteFixed: false,
	staysOpen: false,
};

/** How a recording was reached, and what that allows. */
export class RecordingOrigin {
	private constructor(private readonly facts: OriginFacts) {}

	/**
	 * Reached on its own: from the file explorer, with the audio file itself
	 * open, or from a menu that closes once an entry is picked.
	 */
	static direct(): RecordingOrigin {
		return new RecordingOrigin(NOTHING_KNOWN);
	}

	/**
	 * Reached from buttons that stay open beside the note, as the recording
	 * panel's are. Deleting is one click in a menu that closes; next to a note
	 * that stays open, it is one mis-click away from the button meant.
	 */
	static besideNote(): RecordingOrigin {
		return new RecordingOrigin({ ...NOTHING_KNOWN, staysOpen: true });
	}

	/**
	 * Reached as one of the recordings a note links, as the palette finds them
	 * in the active note.
	 * @param note - The note
	 */
	static inNote(note: TFile): RecordingOrigin {
		return new RecordingOrigin({ ...NOTHING_KNOWN, note });
	}

	/**
	 * Reached through a link at a known place in an editor: the link under the
	 * cursor, or the one the editor menu was opened on.
	 * @param note - The note the editor shows, or null for an editor that
	 *   shows none, as a canvas card does
	 * @param link - Where the link is
	 * @param atMoment - Whether the link points at a moment of the recording
	 */
	static atLink(
		note: TFile | null,
		link: LinkLocation,
		atMoment: boolean,
	): RecordingOrigin {
		return new RecordingOrigin({
			...NOTHING_KNOWN,
			note: note ?? undefined,
			link,
			atMoment,
			noteFixed: true,
		});
	}

	/**
	 * Reached through a link whose place in a note may not be known:
	 * Obsidian's own menu for a link, or a player rendered from an embed.
	 * @param note - The note the link is in, when it links the recording
	 * @param link - Where the link is, when the click maps back to it
	 * @param atMoment - Whether the link points at a moment of the recording
	 */
	static throughLink(
		note: TFile | null,
		link: LinkLocation | null,
		atMoment: boolean,
	): RecordingOrigin {
		return new RecordingOrigin({
			...NOTHING_KNOWN,
			note: note ?? undefined,
			link: link ?? undefined,
			throughLink: true,
			atMoment,
			noteFixed: true,
		});
	}

	/**
	 * Named on the command line, which names the note or names none: a script
	 * cannot see which note is active, so there is none to fall back on.
	 * @param note - The note named beside the recording, or null
	 */
	static named(note: TFile | null): RecordingOrigin {
		return new RecordingOrigin({
			...NOTHING_KNOWN,
			note: note ?? undefined,
			noteFixed: true,
		});
	}

	/**
	 * What both origins know together. Obsidian raises the file menu and the
	 * editor menu for one click on one menu, in an order nothing guarantees,
	 * and each knows something the other does not; the first note and link
	 * found are kept, and every fact either one learned holds.
	 * @param other - What another handler of the same menu found
	 * @returns The origin both describe
	 */
	merge(other: RecordingOrigin): RecordingOrigin {
		const mine = this.facts;
		const theirs = other.facts;
		return new RecordingOrigin({
			note: mine.note ?? theirs.note,
			link: mine.link ?? theirs.link,
			throughLink: mine.throughLink || theirs.throughLink,
			atMoment: mine.atMoment || theirs.atMoment,
			noteFixed: mine.noteFixed || theirs.noteFixed,
			staysOpen: mine.staysOpen || theirs.staysOpen,
		});
	}

	/**
	 * The note the recording was reached through: what a transcript is
	 * written into and what a link is removed from. Absent when it was reached
	 * directly.
	 */
	get note(): TFile | undefined {
		return this.facts.note;
	}

	/** The link the menu or the cursor was on, the one "the link" means. */
	get link(): LinkLocation | undefined {
		return this.facts.link;
	}

	/**
	 * Whether it was reached at a moment of the recording. A transcript holds
	 * dozens of those to one recording, so neither delete is offered from one.
	 */
	get atMoment(): boolean {
		return this.facts.atMoment;
	}

	/**
	 * Whether moving the recording to the trash leaves nothing behind that
	 * pointed at it from where it was reached: reached on its own, from a
	 * menu that closes. Anything that reached it through a note or a link has
	 * links a plain delete would leave broken.
	 */
	offersPlainDelete(): boolean {
		const { note, link, throughLink, atMoment, staysOpen } = this.facts;
		return (
			note === undefined &&
			link === undefined &&
			!throughLink &&
			!atMoment &&
			!staysOpen
		);
	}

	/**
	 * Whether the delete that also removes the links is offered: the
	 * recording was reached through a note or a link, and not at a moment.
	 */
	offersLinkDelete(): boolean {
		const { note, link, throughLink, atMoment } = this.facts;
		return (
			!atMoment &&
			(note !== undefined || link !== undefined || throughLink)
		);
	}

	/**
	 * The note a dialog opened for the recording writes into.
	 * @returns The note it was reached through; null where it was reached
	 *   through none and there is no active note to take, as on the command
	 *   line; undefined where the dialog should take the note active in the
	 *   app, each dialog in its own way and at its own moment
	 */
	noteForDialog(): TFile | null | undefined {
		const { note, noteFixed } = this.facts;
		return note ?? (noteFixed ? null : undefined);
	}
}
