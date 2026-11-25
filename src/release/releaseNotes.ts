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
	'2.6.1': `
This release fixes a transcript that was lost when its note was open in Reading view. The plugin showed **"Transcript inserted into the note."**, wrote nothing, and skipped the sidecar file that exists to keep a finished transcript, so the paid run was gone. A note in **Reading view** now takes the transcript like a note being edited, and the same holds for the link of a finished recording, a quick note and the chapter outline.

## Fixed

- A transcript inserted into a note open in Reading view reached nothing ([#177](https://github.com/akhmialeuski/advanced-audio-recorder/issues/177)). Obsidian keeps a hidden editor behind Reading view that accepts a write without an error and never saves it to the note. A note you are editing still takes the transcript at the cursor, and a note in Reading view or closed during the run is now written through the vault: under the embed of the recording, or at the end of the note when it has none ([#178](https://github.com/akhmialeuski/advanced-audio-recorder/pull/178)).
- **"Could not insert the transcript into the note"** now means the note could not be written at all, for instance because it was deleted during the run, and the transcript is then saved as a sidecar file as before. The view mode no longer matters.
- The link of a finished recording reaches a note in Reading view, at the end of the note. A note that was closed during the recording takes the link at the remembered line, where earlier versions put it into whichever note was active when the recording was saved.
- A quick note started in a note in Reading view goes to the end of that note, on a line of its own. A dictation started while editing still lands at its place when the note went to Reading view meanwhile. When no note is being edited to take it, the notice says so and the text is copied to the clipboard.
- The Markdown outline of **Export chapters and markers** is inserted into a note in Reading view too.
- The palette actions that work on a cursor or a selection, **Split selection into another speaker**, **Merge selected lines into one** and **Delete recording & link to file**, no longer act on the hidden cursor of a note in Reading view, which could name a link you never pointed at.

## Internal

- Only one module reads the editor of a Markdown view, and it hands the editor out for a view in editing mode alone. A lint rule fails the build on any other read, so a new writer has to deal with Reading view.
- The test double of a Markdown view now keeps its editor in Reading view, as Obsidian does. The old tests modelled Reading view as an editor that refuses the write, which is how the defect passed them.
- The suite is 8223 tests across 344 suites.

## Compatibility

Requires Obsidian 1.14.4+, unchanged. Existing recordings, stored settings, the recorder, and the players are unaffected.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.6.0...2.6.1
`,
	'2.6.0': `
This release adds AssemblyAI as a sixth transcription engine and brings back the merged file of a multi-track recording that Obsidian lost mid-session. **AssemblyAI** transcribes a meeting of up to ten hours as one job, so speaker labels keep one numbering from the first minute to the last, and the recording is uploaded in its own container with nothing decoded first. A crashed microphone and system audio session set to **Single file** is now recovered with the merged \`multitrack\` file a normal stop would have written, instead of two files that each hold one side of the conversation.

## New: The AssemblyAI engine

AssemblyAI can be chosen under **Transcription engine**, with its own page under **Engines** holding the **Base URL**, the **AssemblyAI API key** kept in Obsidian's keychain, and the **Model** ([#173](https://github.com/akhmialeuski/advanced-audio-recorder/pull/173), [#171](https://github.com/akhmialeuski/advanced-audio-recorder/issues/171)).

- A recording of up to ten hours and 2.2 GB goes in one job, the default \`webm\` included. The plugin uploads it, queues the transcript and reads the job's status every three seconds until it completes, within **Request timeout**, so raise that setting above its 10-minute default before transcribing a recording of several hours.
- **Speaker diarization** is supported. AssemblyAI's lettered speakers appear as \`Speaker 1\`, \`Speaker 2\`, and each sentence of the answer becomes one transcript line with its own timecode.
- Per-word timing comes back on every run, so **Word-level timestamps** is shown disabled in the on position and the JSON file output always carries the words.
- The dictionary is sent as keyterms, at most 6 words per phrase and 1000 words in total on \`assemblyai-stt-3-7\`, or 200 on \`universal-2\`. Terms that do not fit are named in a notice.
- The cost estimate prices \`assemblyai-stt-3-7\` at about $0.21 and \`universal-2\` at about $0.15 per audio hour, and adds about $0.02 for speaker labels and $0.05 for keyterms when the run asks for them. A finished run is recorded at the audio duration AssemblyAI reports billing for.
- A status read that fails in passing, on a server error, a rate limit or a dropped connection, is repeated on the same job, so a recording is uploaded and billed once.
- With **Language** empty, the job detects the language on the selected model alone. The flagship covers 32 languages, so name the language or pick \`universal-2\` for a recording in another one.

A new guide, [AssemblyAI API key](https://github.com/akhmialeuski/advanced-audio-recorder/blob/2.6.0/docs/use-cases/assemblyai-api-key.md), walks through getting a key.

## Fixed

- A multi-track recording that Obsidian lost mid-session is recovered the way a normal stop would have saved it ([#172](https://github.com/akhmialeuski/advanced-audio-recorder/pull/172)). With **Single file** selected, recovery writes the merged \`multitrack\` file with the session's output format and track levels and positions, and keeps the raw \`-recovered\` tracks beside it. Earlier versions recovered two separate files and said nothing about the missing mix, so transcribing the embedded track gave a transcript with one speaker. When the mix fails, or a track could not be recovered, a notice says so and each track stays its own file. A mobile session recorded in parts is still recovered as one set of parts per track.

## Internal

- The dictionary of a run is planned against the model of the selected engine. It used the Deepgram model for every engine, which only Deepgram read, so no earlier run was affected.
- An engine's price can depend on what the run asks for, so the estimate and the session total add AssemblyAI's extras from one rule, and the Whisper, Deepgram and AssemblyAI mappers share one reader of the billed audio duration.
- The suite is 8184 tests across 343 suites.

## Compatibility

Requires Obsidian 1.14.4+, unchanged. Existing recordings, stored settings, the recorder, and the players are unaffected, and the other five engines are priced as before. A recovery journal written by an earlier version carries no merge, so a session lost under it is recovered one file per track as before.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.5.2...2.6.0
`,
	'2.5.2': `
This release changes nothing in the plugin you run. It lets the automated source review of the Obsidian community directory finish, which stopped on 2.5.1 with **"The source code review encountered a fatal error"** before it could list a single finding.

## Internal

- The review lints a release from the repository root with its own ESLint configuration. A file of recorded lint exceptions at the root left ESLint with nothing to apply them to, so it stopped, and 422 test, script and build files sat outside every TypeScript project the review looks for. The exceptions now live under \`.config\`, and the tests, the scripts and the build configs each belong to a project ([#169](https://github.com/akhmialeuski/advanced-audio-recorder/pull/169)).
- CI runs the review's lint on every change and fails when it would stop again.
- The suite is 8110 tests across 340 suites.

## Compatibility

Requires Obsidian 1.14.4+, unchanged. The plugin's code is the same as in 2.5.1, so recordings, settings, the recorder, and the players are unaffected.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.5.1...2.5.2
`,
	'2.5.1': `
This release fixes transcription on older Obsidian installers and brings the model lists up to the November 2026 provider catalogues. Transcribing a recording no longer fails with **"Object not disposable"** on an Obsidian installer built on an older Electron, such as Electron 25. New users start on cheaper current models, **gpt-6.1-terra** for OpenAI post-processing and **gemini-4-hydrogen** for Gemini, and saved model lists gain the new models once while keeping the model already chosen. Diarized Deepgram transcription moves to Deepgram's current diarizer.

## Fixed

- Transcription failed with "TypeError: Object not disposable" on runtimes that lack \`Symbol.dispose\` and \`Symbol.asyncDispose\`, such as the Electron 25 of older Obsidian installers ([#164](https://github.com/akhmialeuski/advanced-audio-recorder/issues/164)). The plugin, its encoding worker and its audio engine now provide both symbols before any other code runs, so a resource is released under the same key it was registered with ([#165](https://github.com/akhmialeuski/advanced-audio-recorder/pull/165)).

## Changed

- The model lists follow the provider catalogues of November 2026 ([#167](https://github.com/akhmialeuski/advanced-audio-recorder/pull/167)). OpenAI post-processing suggests \`gpt-6.1-terra\`, Gemini suggests \`gemini-4-hydrogen\` and \`gemini-4-carbon\`, and Anthropic offers \`claude-fable-5-2\` in place of \`claude-fable-5-1\`.
- A new user starts on \`gpt-6.1-terra\` for OpenAI post-processing, half the price of \`gpt-6.1-sol\`, and on \`gemini-4-hydrogen\` for Gemini, which replaces \`gemini-3.8-flash\`, now Google's previous-generation Flash. A model list saved by an earlier version gains the new models once, and the model selected in it stays selected.
- The cost estimate prices every new model, and \`claude-fable-5-2\` is no longer estimated at the dearer Fable 5.1 rate. \`gemini-4-argon\` and \`gemini-4-carbon\` are priced at the rate Google charges from December 1, 2026, so until November 30 their estimate is twice the bill and stays an upper bound.
- Diarized Deepgram transcription asks for Deepgram's current diarizer, the v2 batch diarizer today, instead of the deprecated switch that always used v1. Speaker boundaries can differ from an earlier transcript of the same recording.

## Internal

- Every function in \`src\` is held to a cyclomatic complexity of 8, five parameters and 50 code lines, every file to 500 code lines, and every function to a CRAP score of 8 that combines complexity with coverage. Code older than the gate is recorded and may only shrink, and CI runs the check after the coverage run ([#134](https://github.com/akhmialeuski/advanced-audio-recorder/pull/134)).
- The repository no longer carries a Claude Code hook that only repeated documentation rules held elsewhere ([#166](https://github.com/akhmialeuski/advanced-audio-recorder/pull/166)).
- The suite is 8110 tests across 340 suites.

## Compatibility

Requires Obsidian 1.14.4+, unchanged. Existing recordings, stored settings, the recorder, and the players are unaffected. A saved model selection is kept, and only a new user starts on the new OpenAI and Gemini defaults.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.5.0...2.5.1
`,
	'2.5.0': `
This release names recordings from a template, saves them in the background, and tops up a transcript that was inserted into a note. A new **File name template** setting puts the name of the note or the date into a recording's file name. A stopped recording is now written in the background, so the next one can start the moment the last one stops. **Transcribe the parts that failed** now fills the gaps of a transcript that lives in a note. A quick note dictated with Google Gemini costs one request instead of two, and a Gemini transcript of a long recording keeps its timecodes inside the recording. Every cloud request is now sent once, through Obsidian's \`requestUrl\`, so no endpoint bills one transcription twice.

## New: Naming recordings from a template

The **File name template** row under **File storage** takes \`{{prefix}}\`, \`{{notename}}\`, \`{{source}}\`, \`{{track}}\`, \`{{timestamp}}\`, \`{{date}}\` and \`{{time}}\`, in the notation of Obsidian's core Templates plugin. A date or time takes a Moment format after a colon, as in \`{{date:YYYYMMDD}}\` ([#161](https://github.com/akhmialeuski/advanced-audio-recorder/issues/161)).

- \`{{notename}}\` is the note that was active when the recording started, so \`{{notename}}-{{date}}\` gives \`Chorus idea-2026-11-04.webm\`. A variable with nothing to show drops out together with the dash beside it.
- The default, \`{{prefix}}-{{source}}-{{timestamp}}\`, spells out the name every recording had before, so an update renames nothing for an ordinary **File prefix**. The exception is a prefix that is empty, starts with a space or a dash, ends with a dash or holds two dashes in a row, whose dashes now fold.
- A template that leaves out both \`{{source}}\` and \`{{track}}\` numbers the tracks of one recording, so none overwrites another. A variable the plugin does not know, a near miss such as \`{{Date}}\` included, is refused in the settings with a message naming it.
- Characters a path cannot hold become dashes, and dots become dashes in the note name only. A very long note name is cut at its end so the whole name stays within 220 bytes, which a title in Cyrillic reaches sooner than one in Latin letters.
- The template is read once when a recording starts, so the merged file of a multi-track session is named from the same values as its tracks.

## New: Saving in the background

A stopped recording is now saved in the background ([#151](https://github.com/akhmialeuski/advanced-audio-recorder/pull/151)). The next recording can start the moment the last one stops, so back-to-back meetings are captured from the first second, where earlier versions made the next recording wait for the save of a long one.

- Saves run one at a time in the order the recordings stopped, and the status bar shows the running save and how many wait.
- The recording panel opens with a **Saving** section whenever a save runs or waits, whatever file is open. It shows the recording being saved with its stage and progress bar, then every recording waiting behind it, each named by its start time and length ([#153](https://github.com/akhmialeuski/advanced-audio-recorder/pull/153)).
- The command line's \`stop\` answers once the save is queued. With \`wait\` it answers once the file is written, or with the reason the save failed.
- The microphone is released as soon as the recorders have delivered their last data, so the system's microphone indicator goes off when **Stop** is pressed and not when the file is written ([#150](https://github.com/akhmialeuski/advanced-audio-recorder/pull/150)).

## New: Topping up a transcript inside a note

**Transcribe the parts that failed** could only complete the transcript file, so a run with **Transcript output > Destination** set to **Insert into note** could never be topped up, and a run with **Note and file** left its gap in the note. The recovered lines are now rendered with the templates the note was written with and placed between the lines around the gap by their timecode links ([#158](https://github.com/akhmialeuski/advanced-audio-recorder/pull/158)). Only the lines inside a retried stretch are replaced, the incomplete-transcription callout is rewritten or removed, and the edits made anywhere else in the note stay. Notes written by earlier releases can be topped up too.

A top-up that recovers at least one segment also generates the recording's chapters again from the completed transcript, replacing only generated chapters, so bookmarks and chapters placed by hand stay ([#157](https://github.com/akhmialeuski/advanced-audio-recorder/pull/157)).

## New: Quick notes in one Gemini request

With Google Gemini on both quick note engine rows, a quick note with a profile selected is heard and rewritten in one request instead of two ([#146](https://github.com/akhmialeuski/advanced-audio-recorder/pull/146)). No setting is added or removed.

A quick note dictated with Gemini no longer fails on the first upload after Obsidian starts with "Upload has already been terminated", and its text lands where the cursor stood when the dictation began, even after edits above that spot. A dictation finished while another note is active still lands in the note it was started in, and a notice names that note ([#145](https://github.com/akhmialeuski/advanced-audio-recorder/pull/145)).

## New: Transcription from the command line without a dialog

The command line's \`transcribe\` now runs the same transcription the dialog runs, without opening it. The app shows the run's progress in a notice with a **Cancel**, as it does for \`convert\` and \`split\`, and the chapters the run is set to generate follow it. The dialog, the transcription queue and the command line start a run through one operation, so a queued run that the engine billed before it failed now counts in the session total, and an engine this device cannot run is refused before the file is read ([#155](https://github.com/akhmialeuski/advanced-audio-recorder/pull/155)).

## Fixed

- A cloud request is never sent twice. A request carrying the run's cancel used to go out through \`fetch\` and was sent again through \`requestUrl\` when \`fetch\` failed, so an endpoint that took the body and answered without CORS headers billed one transcription or completion twice. Every engine now uses \`requestUrl\`, on desktop and mobile alike ([#159](https://github.com/akhmialeuski/advanced-audio-recorder/pull/159)).
- Transcribing a long recording with Google Gemini gave different transcripts on repeated runs and could place lines past the end of the recording, 26:06 in a recording of 24:13. The request now asks for \`MM:SS\` timecodes, which fitted all 10 parts of that recording where seconds drifted in 7 of 10, and every answer is checked against the part it was sent for. An answer that leaves the part or stops more than a minute short is sent once more, and a part that still does not fit keeps the lines inside it and is reported in the note with its reason ([#147](https://github.com/akhmialeuski/advanced-audio-recorder/pull/147)).
- A recording transcribed from a folder queue with auto chapters set to follow every transcription now gets its chapters, as one transcribed from the dialog already did. The queue waits for each recording's chapters before it starts the next, so it still sends one paid request at a time ([#156](https://github.com/akhmialeuski/advanced-audio-recorder/pull/156)).
- A quick note started while a long recording was being saved could break that save, which then left its segment files behind and made the next launch offer to recover them ([#150](https://github.com/akhmialeuski/advanced-audio-recorder/pull/150)).

## Changed

- The audio engine, mediabunny, starts on its first conversion, encode or probe instead of at plugin load, and \`main.js\` carries one copy of it instead of two. The bundle shrinks from 3274035 to 1998000 bytes, and the plugin's load up to its constructor drops from 41.16 to 26.63 ms ([#142](https://github.com/akhmialeuski/advanced-audio-recorder/pull/142), [#144](https://github.com/akhmialeuski/advanced-audio-recorder/pull/144)).

## Internal

- Converting and splitting a recording share the steps that finish them, so a source goes to the trash by one rule ([#143](https://github.com/akhmialeuski/advanced-audio-recorder/pull/143)).
- The palette, the context menus, the command line and the recording panel ask each action's own gate whether it is offered, and every action family has a folder of its own ([#154](https://github.com/akhmialeuski/advanced-audio-recorder/pull/154)).
- Both type-only import cycles in \`src\` are gone, and CI fails on a new one ([#148](https://github.com/akhmialeuski/advanced-audio-recorder/pull/148)).
- \`@types/node\` moves to 24.19.2, the Node that Obsidian's Electron bundles ([#160](https://github.com/akhmialeuski/advanced-audio-recorder/pull/160)).
- The suite is 8069 tests across 337 suites.

## Compatibility

Requires Obsidian 1.14.4+, unchanged. Existing recordings, stored settings, the recorder, and the players are unaffected. Settings written by an earlier version carry no file name template and read as the default, so nothing migrates.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.4.1...2.5.0
`,
	'2.4.1': `
This release records the other side of a call on a Mac without extra software, and fixes transcription retries that failed on a WebM recording. **Include system audio** and a **System audio (this computer)** track now capture this computer's own output on **macOS 14.2 or later**, in an Obsidian installer built on Electron 39.6 or later, so BlackHole and a Multi-Output device are no longer needed. A Google Gemini or Mistral Voxtral run that waited out a temporary refusal no longer ends with **"Cannot decode detached ArrayBuffer"**. Files the plugin removes on its own now go where **Settings > Files and links > Deleted files** sends them.

## New: System audio on macOS

Recording this computer's own output was granted on Windows only, and a Mac had to route it through a loopback device such as BlackHole. On macOS 14.2 or later, in an Obsidian installer built on Electron 39.6 or later, **Include system audio** and a **System audio (this computer)** track now capture it directly through the audio tap of macOS ([#137](https://github.com/akhmialeuski/advanced-audio-recorder/issues/137)).

- The capture needs Obsidian to be allowed under **System Settings > Privacy & Security > Screen & System Audio Recording**, which macOS 14 calls **Screen Recording**. macOS may never prompt for it on this path, so when the grant fails the plugin names that permission, says to add Obsidian with the **+** button if it is not listed, and to quit and reopen Obsidian.
- A Mac below either version is refused before any permission prompt appears, and the message names the version that falls short. Obsidian's in-app updates do not replace its Electron, so an old Electron is fixed by installing the current Obsidian installer.
- The **Include system audio** and **Track N source** rows show why the capture is unavailable on this computer, or which macOS permission it needs.
- On a Mac the failure messages offer BlackHole as the fallback, where Windows offers Stereo Mix or VB-CABLE.
- The troubleshooting guide gains **This computer's output is not recorded**, with one entry per reason, and the meeting-notes guide covers the macOS route step by step.

## Fixed

- A WebM recording transcribed with Google Gemini or Mistral Voxtral failed with "Cannot decode detached ArrayBuffer" whenever the first request met a temporary refusal, such as a 503, and the advanced second pass of such a run was silently discarded ([#136](https://github.com/akhmialeuski/advanced-audio-recorder/issues/136)). A recording the engine cannot read as it stands is now decoded once per run, and every retry and the second pass send the same converted audio. The refusal behind each retry is written to the developer console.

## Changed

- A recording decoded for Mistral Voxtral that runs past three hours is now split into parts of up to three hours and stitched back onto one timeline, instead of being refused. Speaker numbering can reset between the parts.
- The parts a split already wrote before it starts over, and a marker sidecar left with nothing in it, now go where **Settings > Files and links > Deleted files** sends deleted files instead of being deleted outright. A sidecar that only kept a playback position empties when a recording is played to the end, so each finished listen leaves one small \`.markers.json\` file in that trash.
- The README gains a **Privacy and permissions** section on what the plugin does with the network, with files, and with the clipboard.

## Internal

- The changes asked for by the community plugin review: no \`:has\` selectors in the stylesheet, with the status-bar progress surface and the catalogue lists looking as before, and chapter generation reading only the recording's own folder to find its transcript instead of listing every file in the vault.
- Converting a container for an engine moves out of the Gemini and Voxtral providers into audio preparation, and each engine's capabilities declare which original containers it reads.
- The suite is 7797 tests across 325 suites.

## Compatibility

Requires Obsidian 1.14.4+, unchanged. Existing recordings, stored settings, the recorder, and the players are unaffected. System audio on macOS also needs macOS 14.2 or later and an Obsidian installer built on Electron 39.6 or later: the 1.12.4 installer qualifies, while the 1.11.4 installer, on Electron 39.2.6, is refused with advice to install the current one.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.4.0...2.4.1
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
