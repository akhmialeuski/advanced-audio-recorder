/**
 * What each release changed, in the words it was announced in.
 *
 * The text ships inside the plugin instead of being fetched from the GitHub
 * releases, so a vault opened on a plane, on a phone with no signal, or behind
 * a firewall answers the same as one online, and the dialog never waits on a
 * request only to open empty. What it costs is that a version's entry is
 * written before its tag is pushed, which is where the notes are written
 * anyway.
 *
 * Only the recent versions are kept. An entry no upgrade can still arrive at is
 * bundle weight nobody reads, so the oldest are dropped as new ones are added,
 * the way {@link MAX_SHOWN_VERSIONS} bounds what one dialog shows.
 * @module release/releaseNotes
 */

/**
 * How many versions one dialog shows.
 *
 * A vault left unopened for a year arrives at an upgrade spanning a dozen
 * releases, and the oldest of them describe a plugin the reader never ran. The
 * newest are the ones the dialog exists for, so the rest are left to the
 * release pages.
 */
export const MAX_SHOWN_VERSIONS = 10;

/**
 * The notes of each released version, newest first.
 *
 * The key is the tag, which is what `manifest.json` holds and what the stored
 * "last announced" value is compared against, so the two can never drift apart
 * through a rename. The value is Markdown, rendered by Obsidian's own renderer,
 * and it carries no heading for its own version: the dialog writes that, so a
 * version cannot be titled one thing here and another there.
 */
export const RELEASE_NOTES: Readonly<Record<string, string>> = {
	'2.3.2': `
This release moves the text a run applies out of the settings and into the vault, records a call from one switch, and widens a WAV sample. Every profile - a glossary, a participant roster, chapter guidance, a post-processing prompt - can now **keep its body in an ordinary note**, edited in the editor, synced and versioned like anything else, and read again as a transcription starts. **Include system audio** pairs the microphone with this computer's output into a single mixed file without configuring a track. WAV recording gains a **Bit depth** row with twenty-four bit integer and thirty-two bit float. Two diarized speakers can be **merged under one name**, the ribbon button is told apart from Obsidian's own, and a fresh vault opens the enhanced player straight away. Existing recordings, stored settings, and the recorder are unaffected.

## New: Profile bodies from vault notes

- Every profile page carries a **Source** row with **Typed text** and **Note**. Once a note is picked, the profile reads its text from there, so a glossary of a hundred terms lives in the editor: synced, versioned, linked to its project, and editable from a phone.
- A transcription, a chapter generation, and the **Rename speakers** dialog read the notes they apply as they start, so an edit made a moment before a run reaches it. A note open in the editor is read from the editor, every other note from the vault.
- Picking a note for a profile that holds typed text asks first, because that text exists nowhere else once the note is read. An empty note is offered the typed text, and any other note is confirmed.
- A note that is missing, and a note that cannot be read, both leave the profile on the text last read from it, and every screen says so: \`Uses the text last read from Glossaries/Standup.md, which is missing.\` A catalogue entry names the origin beside what it holds, such as \`In use, note, 12 names\`.
- Terms and names are read the way Markdown renders the note. Headings, tables, fenced code, comments, and callout titles are skipped; bullets, quote markers, numbers, and checkboxes are stripped; a link yields its label and a wikilink its alias. Prompts are read verbatim.
- Names applied in the **Rename speakers** dialog are appended to a roster note, continuing the list style of its last line and leaving the rest of the note untouched.

## New: Recording a call from one switch

**Include system audio** under **Audio input** pairs the microphone with the computer's own output and mixes both into one file, so the remote participants of a Zoom, Teams, or Meet call reach the recording without a virtual cable and without setting up tracks. The pairing writes a single mixed file whatever the stored output mode says, and it stands down while multi-track recording is on, because a track already states what it records and one session captures the system output once. The switch needs a desktop build that can open two captures at once, and the row says so where it cannot.

## New: WAV at 24-bit and 32-bit float

**Bit depth** under **Output format** offers sixteen bit integer, the width every WAV recording had until now, twenty-four bit integer, and thirty-two bit float. Sixteen bits are enough for speech at a level set carefully in advance, which is the one thing a meeting does not allow; twenty-four leave room under a speaker quieter than expected; thirty-two floating point keep a sample that ran past full scale, so an overloaded take is recovered by normalizing the finished file. A wider sample costs file size in proportion.

The width travels with the audio through every link that used to treat sixteen bits as a fact: the capture worklet, the write queue, the segment assembly, the streaming mixer, and the byte-level split. A float recording carries the IEEE format tag with the \`fact\` chunk the WAVE specification requires, the recovery journal records the width per track so a segment survives a crash and a settings change, and the row is offered only on devices that record WAV as raw PCM.

## New: Merging two diarized speakers

Diarization routinely splits one person across two labels. Assigning the same name to both now merges them, after a confirmation that says the merge cannot be walked back. A name equal to another speaker's engine label is still refused, an existing merge is not confirmed again, and a merge that is later split leaves the already-rewritten text reported as ambiguous rather than rewritten a second time.

## Settings and the ribbon

- The ribbon button draws \`mic-vocal\` and names itself **Advanced Audio Recorder: start/stop recording** from the manifest, so it is told apart from the core **Audio recorder**, whose button carries the same glyph and the same tooltip. The README and the getting-started guide open by recommending that the core plugin be switched off or its button hidden.
- The enhanced player is enabled in a fresh vault. A vault whose \`data.json\` already stores the value keeps what it stores.
- The **Audio bitrate** and **Recording format** rows rebuild when the channel layout moves, so the rates and formats they offer are the ones this device's encoder accepts for the capture that will run.

## Fixed

- A Whisper-compatible endpoint may omit a word's end time, and the word mapper read that as a zero, which pointed the word's interval backwards: duration came out negative, a sort by end time scrambled the order, and mapping a playback position onto a word landed at the start of the file. A word with no end time now ends at its own start.
- A Deepgram model id typed as \`Nova-3\` was biased as an older generation, and a \`Whisper-Medium\` was biased although it accepts no bias at all, because the generation was read from the id literally. The family is now read from a lower-cased copy, which reaches the request itself, the dictionary plan and its notice, and the warning before an advanced two-pass run.
- Moving **Recording channels** from mono to stereo left the bitrate row offering the mono list, with values the encoder refuses, until the settings tab was opened afresh. All seven settings that move the channel count now rebuild the rows that read it.

## Documentation

The documentation was audited against the source, which found about a hundred claims that had drifted since the September releases: the player's control row, the timecode link format, the decode ceiling, the file actions, the format dropdown's behaviour, and the transcription pages that still described a flat Transcription section although every engine has its own page. Twenty-five figures were re-rendered from the current code, the multi-track figures now show the per-track source, channel, and processing rows, and the settings sections each carry a current figure. The ninety-four figure captions are dropped, because GitHub renders a caption line beside its image rather than under it and the alt text already carried the description.

## Internal

- Twenty-two closed value sets - channel modes, profile kinds, marker colours, queue states, transcript formats, and the rest - state their members as named constants instead of bare unions and loose strings. Every stored string is byte-identical, so nothing written by an earlier version reads differently.
- The LICENSE names the actual author.
- The suite is 6007 tests across 242 suites.

## Compatibility

Requires Obsidian 1.6.6+, unchanged. This release is backward compatible: existing recordings, stored settings, the recorder, and the players are unaffected. Settings written by an earlier version carry no profile note, no system-audio pairing, and no bit depth, and they are read as typed text, the switch off, and sixteen bit, so nothing migrates.

Two behaviours change for a vault that already holds data. A glossary or roster typed into the settings is now read the way Markdown renders it, so a term written \`3. Liga\` yields \`Liga\` and \`__init__\` yields \`init\`; terms typed as plain words are unaffected. The enhanced player's default reaches fresh installs only.

The system-audio pairing needs a desktop build that can grant a loopback capture, which is Windows today, and a session holding it starts from the ribbon icon, the command palette, or a hotkey rather than from the command line. The wider WAV sample needs a device that records WAV as raw PCM.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.3.1...2.3.2
`,
	'2.3.1': `
This release makes an online call recordable from both ends and gives the embedded player a new look. A multi-track track can now **record this computer's own output on Windows**, so the remote participants of a Zoom, Teams, or Meet call reach the file without a virtual cable, and every track can **choose its own input processing**, so a loopback input is no longer silenced by the echo cancellation a room microphone needs. The **embedded player and its marker list are redesigned**, and reading a recording's metadata no longer falls back to decoding the whole file. Existing recordings, stored settings, and the recorder are unaffected.

## New: System audio as a track source

- **Track N source** offers **Input device**, the default and what every stored track already was, or **System audio (this computer)**, which records the machine's own output through Electron's loopback grant. Electron grants it on Windows only, and on every other platform the row says so under itself while keeping the option selectable, so a configuration synced from Windows survives a visit to a machine that cannot grant it.
- A system-audio track names no device, so its input, channel, and processing rows are hidden. One session captures the system output once: a second system-audio track puts a warning on the multi-track settings entry, and a recording started anyway is refused with the surplus tracks named.
- A refused grant is reported as what it is. A denied screen capture names the screen-capture permission and says it is not the microphone one, a capture granted without audio or ended together with its screen capture is refused before any recorder is built over it, and the screen capture requested alongside the audio is released on every path, so its indicator does not stay up.
- The host grants this capture only in answer to a user action in a focused Obsidian window. A session holding a system-audio track therefore starts from the ribbon icon, the command palette, or a hotkey, and \`advanced-audio-recorder:record\` from a terminal answers with that reason and starts nothing.
- Everywhere else the loopback-input route still works, and it is now easier to find: inputs that carry the system output, such as Stereo Mix, VB-CABLE, BlackHole, or a PipeWire monitor, are marked \`(system audio)\` in the settings dropdowns and in **Select audio input device**, and the **System info** report lists them along with whether this build can grant the output directly.
- The meeting-notes guide gains a section on recording a call with its remote participants, covering Windows, macOS, and Linux routing step by step.

## New: Input processing per track

**Track N processing** overrides the three session-wide toggles under **Audio processing & feedback** for one track. **Same as global settings** is the default and keeps the behaviour those toggles always had. **Voice (microphone in a room)** turns noise suppression, echo cancellation, and automatic gain control on, which is what a microphone in a room wants. **Raw (system audio or line input)** turns all three off, which is what a loopback input, a line input, or an already-processed headset wants. The distinction matters when one session holds both kinds, because echo cancellation treats the far end of a call arriving on a loopback input as this machine's own speaker output and suppresses it. The row is disabled on a track with no device yet and hidden on a system-audio track, whose capture passes through none of these filters.

## New: A redesigned player

- The toolbar has a round accent play button, uniform bordered buttons, the time and the link at the right edge, and a volume track filled up to its thumb. The volume slider is the one control that shrinks before the row wraps, so the whole toolbar fits one line at about 700 px.
- An editable marker row keeps its controls on one line: kind icon, time field, title, segment length, a play button that jumps to the marker, move to the current position, colour, and delete. The time field widens to the longest timestamp in the list, so titles line up.
- A marker's note sits under its title. An empty note stays collapsed until the row is worked in, by clicking its time or title or by tabbing into it, instead of taking a second line on every row. A note committed blank closes its line again.
- Reading view uses the same card look, with times right-aligned in a column as wide as the longest timestamp, and notes that keep their line breaks and start under the marker's icon.
- The status bar volume slider is filled up to its thumb as well, when the strip is built, while it is dragged, and when a volume arrives from playback.
- Obsidian's own rules for buttons, text fields, and embeds used to outrank the player's styling, so buttons kept their chrome and the player lost its column layout and the gaps around the waveform. The player's styling now applies in reading view and in Live Preview, and its surfaces are derived from theme variables, so light and dark themes both read.

## Fixed

- **Audio file info**, the silent-channel check after a recording, and the cleanup size guard read a recording's container metadata through a probe that closed the file as soon as the read began. The read then failed, a readable container was logged as unparseable, **Audio file info** decoded the whole file to learn what its headers already said, and the cleanup guard could not refuse an overlong file from its headers. The probe now keeps the file open until its metadata has been read.

## Internal

- The system-audio grant is answered in one place, so the availability shown in settings, the **System info** report, and the capture itself cannot disagree about what a build can do.
- The marker list registers its document listeners through the player, so they are removed with the render that added them, and a blank note is one rule shared by the model, the parser, and the list.
- A sample-rate test left an \`AudioContext\` mock on the global under some \`--randomize\` orders and failed about one run in five. Every case now ends in the state jsdom starts in.
- The suite now runs 5720 tests across 238 suites.

## Compatibility

Requires Obsidian 1.6.6+, unchanged. This release is backward compatible: existing recordings, stored settings, the recorder, and the players are unaffected. The track source and track processing fields are absent from settings written by an earlier version and read as **Input device** and **Same as global settings**, so nothing migrates. System audio as a track source needs the Obsidian desktop app on Windows, the row under **Track N source** reports whether the installed build can grant it, and a session holding it cannot be started from the command line. The screenshots in the documentation still show the previous player.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.3.0...2.3.1
`,
	'2.3.0': `
## What's Changed
* feat(settings): offer bitrates down to 24 kbps, floored by the codec by @akhmialeuski in https://github.com/akhmialeuski/advanced-audio-recorder/pull/89
* feat(transcription): add Mistral Voxtral and Mistral post-processing by @akhmialeuski in https://github.com/akhmialeuski/advanced-audio-recorder/pull/90


**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.2.3...2.3.0
`,
};

/**
 * Orders two versions the way a reader does, so 2.10.0 comes after 2.9.0.
 *
 * Numeric collation compares each run of digits as a number, which is the
 * whole of what comparing versions needs, so this module parses nothing. The
 * locale is named rather than left to the runtime, because the order the
 * dialog shows must not depend on where the vault is opened. `data.json` is a
 * file a sync conflict or a hand edit can leave holding anything, and a value
 * that is not a version sorts where it sorts instead of throwing on the load
 * path.
 * @param left - The version on the left of the comparison
 * @param right - The version on the right of the comparison
 * @returns A negative number when left is older, positive when it is newer,
 * zero when the two are the same version
 */
function compareVersions(left: string, right: string): number {
	return left.localeCompare(right, 'en', { numeric: true });
}

/**
 * The notes of every version released after the one given, newest first.
 *
 * Each section is headed by its own version, so an upgrade spanning several
 * releases reads as the list of releases it actually was rather than as one
 * undivided text.
 * @param previousVersion - The version whose notes were last announced, empty
 * for everything on record
 * @param notes - The catalogue to read, which a test replaces with a fixture
 * @returns The Markdown to render, empty when nothing newer is on record
 */
export function releaseNotesSince(
	previousVersion: string,
	notes: Readonly<Record<string, string>> = RELEASE_NOTES,
): string {
	return Object.keys(notes)
		.filter((version) => compareVersions(version, previousVersion) > 0)
		.sort((left, right) => compareVersions(right, left))
		.slice(0, MAX_SHOWN_VERSIONS)
		.map((version) => `# ${version}\n${notes[version] ?? ''}`)
		.join('\n\n');
}
