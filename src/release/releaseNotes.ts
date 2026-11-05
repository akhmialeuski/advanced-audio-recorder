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
	'2.4.0': `
This release adds a recording panel to the sidebar, keeps API keys in Obsidian's keychain, and transcribes a recording that switches between languages. The **recording panel** shows the length, the format, the transcription, and the participants of the recording in front of you, with its actions one click away. API keys move out of \`data.json\` into **Settings > Keychain**. **Language** takes several codes, such as \`pl, uk\`, and a new **Language lesson** cleanup profile keeps every line in the language it was spoken in. Every action of the plugin is now in the command palette and on the command line, and a conversion or a split can be cancelled while it runs. This release requires Obsidian 1.14.4 or later.

## New: The recording panel

A sidebar tab under the plugin's microphone icon, next to **Outline** and **Backlinks**, follows the file you have open: a recording opened on its own, or a note that embeds or links one, a property such as \`recording: "[[standup.webm]]"\` included. When a note refers to several recordings, a dropdown picks one.

- A row of icon buttons runs the recording's file actions, starts or stops a recording, shows the transcription queue, and opens the settings.
- **Recording** lists the file, its duration, size, format, and creation time, and which engine transcribed it, in which language and when.
- **Participants** lists each person with the speaker label given to their name.
- The sections fold the way **Properties** does, and the panel remembers which are folded. **Open the recording panel** brings a closed panel back.

## New: API keys in Obsidian's keychain

The keys of the six engines were kept in plain text in \`data.json\` and its backup. Each **API key** row now links a secret in **Settings > Keychain** through Obsidian's own picker, and \`data.json\` holds only its ID. Keys an earlier version stored are copied into the keychain on the first start, under IDs such as \`openai-api-key\`, and a notice says so. The plain-text copy leaves \`data.json\` at the next start of the same device, once the keychain is found holding the key, so a keychain write lost on the way to disk costs no key.

The keychain does not sync, and on the desktop each vault has a keychain of its own. A second device therefore shows **No key** for an engine until its key is added there once under the same ID.

## New: Several languages in one recording

**Language** takes several codes separated by commas, such as \`pl, uk\` for a Polish lesson with a Ukrainian-speaking tutor. Google Gemini is told every code and returns each segment in the language and the script it was spoken in, tagged with its code in the JSON transcript. Every other engine receives the first code. Splitting a line, merging lines, and translating keep each segment's language, and the advanced two-pass mode no longer discards a second pass as language drift when a list is set.

Cleanup no longer brings a mixed transcript over into one language: the prompt names every language of the transcript and asks to keep each line in its own. A new **Language lesson** cleanup profile ships beside **Default**. It keeps the student's mistakes and the tutor's corrections, and it is used only once you pick it under **Cleanup prompt profile**.

## New: Every action in the palette and on the command line

Every action of the plugin is now one command offered in three places: the command palette, where it can take a hotkey, its context menu, and Obsidian's command line as \`advanced-audio-recorder:<name>\`. The palette grows from a handful of commands to 37, and the command line from four to 40.

- From the palette an action works on the open recording, or on the recordings the open note embeds or links, and asks which one when there are several.
- **Delete recording** is offered for a recording reached on its own, in the file explorer or opened as a file. Reached through a note or a link, only **Delete recording & link to file** is offered, and timecode links are kept.
- The **Command line** page of the documentation lists every command and its parameters, with a meeting processed end to end by a script.

## New: Cancelling a conversion or a split

The **Convert audio format** and **Split audio into parts** dialogs show a **Cancel** button while the job runs, and it stops the job in the middle of the transcoding. A dialog closed mid-job leaves a notice with the progress and a **Cancel** of its own. A cancelled job leaves the vault as it found it: the parts a split already wrote go to the trash, and no link changes.

## Changed

- Colours, text sizes, corner radii, and the focus ring come from Obsidian's theme tokens, and the status-bar controls, the volume sliders, the progress bars, and the input device picker are Obsidian's own components. On mobile the plugin's text and icons follow the system text size.
- With reduced motion switched on in the operating system, the ribbon and banner pulses and every transition stop. The recording icon and dot stay red.
- Every icon-only control has an accessible name, and the input meter, the progress bars, and the volume sliders announce their values to a screen reader.
- The model lists are checked against the providers' October 2026 catalogues. The defaults become \`gemini-3.8-flash\`, \`gpt-6.1-sol\`, and \`claude-opus-5-5\`, shut-down models leave the seeded lists, and the cost estimate carries the current rates. A model you chose stays selected.
- A new recording is embedded in the link format set in Obsidian, and deleting a recording sends its sidecar to the trash you chose.
- A \`.aac\` file is now a bare AAC stream in ADTS frames. Earlier versions wrote an MP4 container under that name, and those files still play and convert.
- A menu opens in the pop-out window it was called from, and destructive actions are no longer offered on timestamp links.

## Fixed

- The advanced two-pass mode failed on every current Claude model, the earlier default \`claude-opus-4-8\` included, because the context agents sent a temperature those models refuse. A request to Anthropic now drops a field the endpoint refuses and sends the request again.
- A 16 kHz mono recording converted to M4A came out as stereo at 48 kHz without a word. The conversion now keeps the channel count, picks the nearest rate the device's encoder takes, and says so in a notice.
- Renaming a recording while the plugin read its sidecar could leave the moved sidecar empty, losing the recording's markers and transcription details.
- A link whose target holds \`%20\`, or a time after \`#t=\`, is now read the way Obsidian reads it.
- The **Convert to mono** action of the silent-channel notice rendered as a grey box instead of a link.

## Internal

- The settings tab renders only through Obsidian's settings framework, and about 900 lines kept for older Obsidian versions are gone.
- mediabunny moves to 1.61.4, and the Obsidian typings to 1.14.4.
- The suite is 7694 tests across 324 suites.

## Compatibility

Requires Obsidian 1.14.4+, raised from 1.6.6, and an older Obsidian keeps receiving 2.3.5. Existing recordings, stored settings, the recorder, and the players are unaffected. API keys move into the keychain on the first start, so a plugin version older than this one, installed afterwards, finds no keys in \`data.json\`. Every existing install receives the **Language lesson** cleanup profile once and unselected, and a profile you delete stays deleted.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.3.5...2.4.0
`,
	'2.3.5': `
This release makes the mobile recording banner reachable and movable. The banner no longer sits at the very top of the screen, where a touch opens the system's notification shade, and it can now be dragged to one of six places on the screen and stays there for later recordings. Both banner settings move to a new **Mobile** settings page. Existing recordings, stored settings, and the recorder are unaffected.

## New: Dragging the mobile recording banner

When the banner covers part of the note or a toolbar you need, drag it with a finger. On release it snaps to the nearest of six places: the top or the bottom edge, at the left, in the centre or at the right. The banner keeps that place for every later recording and after the screen rotates, and a vault synced to another phone or a tablet brings it along.

- The drag can start anywhere on the banner, the stop button included, and a drag never stops the recording. Only a tap on the stop button does.
- A bottom place stays above the navigation bar, docked or floating, and above the editing toolbar while the keyboard is open.
- **Banner position** offers the same six places as a dropdown, and **Top center** puts a dragged banner back where it started.

## New: The Mobile settings page

**Show recording banner** and **Banner position** move off **Audio processing & feedback**, where the banner switch sat among the microphone filters, onto a page of their own under **Settings > Advanced Audio Recorder > Mobile**. The page entry shows **Off** or the place in use, and **Banner position** is shown only while the banner is on. Both settings now apply to a recording in progress: switching the banner off hides it at once instead of at the next pause or resume.

## Fixed

- The banner sat at the very top of a phone screen, inside the area where a touch pulls down the system's notification shade, so in portrait its stop button could not be pressed ([#118](https://github.com/akhmialeuski/advanced-audio-recorder/issues/118)). It now floats just below the note header on a phone, and below the tab strip on a tablet.

## Internal

- The release workflows run on the Node 24 versions of the GitHub actions and build the plugin on Node 22.
- The suite is 6532 tests across 262 suites.

## Compatibility

Requires Obsidian 1.6.6+, unchanged. This release is backward compatible: existing recordings, stored settings, the recorder, and the players are unaffected. The banner switch keeps the value stored by an earlier version, and settings written by an earlier version carry no banner position, which then starts at **Top center**.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.3.4...2.3.5
`,
	'2.3.4': `
This release lets you repair a diarized transcript line by line, right in the note. **Split selection into another speaker** hands the selected words of one line to another speaker, and **Merge selected lines into one** joins consecutive lines of one turn back together. Both edits rewrite the note and every transcript file of the recording from the same segments. The **Transcribe audio** dialog now fits on one screen, with its secondary options in a collapsed **More options** block, and a quick note can be transcribed by an engine of its own. Existing recordings, stored settings, and the recorder are unaffected.

## New: Splitting a transcript line between speakers

When two people talk over each other, or the engine guesses wrong, one transcript line holds words from both of them. Select those words inside the line, right-click, and choose **Split selection into another speaker**, which is also a palette command.

- **Spoken by** picks who the selection belongs to: any speaker the transcript shows, a participant of the recording nobody is named after yet, or a new \`Speaker N\`.
- **Time span** starts from the word timings when the recording's JSON transcript has them. A bar under the fields covers the line with a handle at each end of the selection, so the boundary is dragged or typed, and the play button plays the span with a playhead running along the bar.
- A selection in the middle of a line splits it in three, and **Rest of the line spoken by** picks the speaker of the words after it.
- The note line is replaced through the editor, so **Ctrl/Cmd+Z** undoes it. The JSON transcript's segments are cut at the entered times, each part keeping its word timings, and the JSON, SRT, WebVTT, and TXT files the run wrote are rewritten from them. A new speaker joins the recording's roster, so **Rename speakers** plays and names it.

## New: Merging lines into one

Diarization also cuts one person's turn into several lines when it hears a pause as a change of speaker. Select the consecutive lines and choose **Merge selected lines into one** from the editor menu or the palette. The dialog shows the merged text, starts **Spoken by** on the first line's speaker, and plays the whole passage, so you can check it really is one voice. Two lines are merged at once, and three or more are confirmed first. The note line and the transcript files are written the same way as for a split.

Without a JSON transcript, or when its segments do not match the lines (after a hand edit, for example), both edits change only the note, and the dialog says so before anything is written.

## New: More options in the Transcribe audio dialog

The dialog had grown tall enough that **Transcribe** needed a scroll to reach. Language, the participant profile, and the destination stay up front beside the cost estimate, and every other option moves into a collapsed **More options** block. The block stays open while you change options, and it opens by itself when the stored engine cannot run on this device, so the reason **Transcribe** is disabled is in view.

## Fixed

- A quick note was always transcribed by the engine recordings use, because the only engine row on the **Quick notes** page picked the LLM that rewrites the text, and its name read as the engine for the whole dictation. The page now has a **Quick note transcription engine** row, and the dictation, its size limits, and its recorded cost all follow it. The old row is renamed **Quick note rewrite engine**.

## Internal

- The note outputs a transcription writes now record their timestamp template in the recording's sidecar, so a line is read back with the templates it was written with even after the settings change.
- The line model the split and the merge share lives in its own module, and the two dialogs share one harness in the integration suite.
- The suite is 6483 tests across 261 suites.

## Compatibility

Requires Obsidian 1.6.6+, unchanged. This release is backward compatible: existing recordings, stored settings, the recorder, and the players are unaffected. Settings written by an earlier version carry no quick note transcription engine, which then starts on the engine recordings use, so a dictation is transcribed exactly as before until the row is changed. A transcript written by an earlier version has no stored timestamp template, and its lines are read with the current setting.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.3.3...2.3.4
`,
	'2.3.3': `
This release lets you dictate straight into the note you are writing, clean up a recording while it plays, and pick DeepSeek for post-processing. A **quick note** records a dictation into memory, transcribes it, and inserts the text at the cursor, optionally rewritten by an LLM profile first. The player's control row gains a **Voice boost** switch that runs the audio cleanup stages on the playing audio without writing a file. **DeepSeek** joins the LLM engines, and a **What's new** dialog now greets each update with its notes. Existing recordings, stored settings, and the recorder are unaffected.

## New: Quick notes

- With transcription on, turn on **Enable quick notes** under **Settings > Advanced Audio Recorder > Quick notes**, and a ribbon button with a waveform icon and the **Start/stop quick note** command appear at once. The first press starts a dictation, the second stops it, and the recognized text is inserted at the cursor of the note the dictation was started in.
- The audio is held in memory only and dropped as soon as the text is ready, whether the dictation succeeded, failed, or was cancelled, so nothing reaches the vault or a sync service.
- The dictation is transcribed by the engine set up under **Transcription**, in the language it was spoken in: no speaker labels, no word timings, no translation into English.
- A **quick note profile** rewrites the text with an LLM before it is inserted, for example to tidy it up, turn it into a bulleted list, or format it as a task. Profiles live in their own catalogue, and the rewrite runs on its own **Quick note engine**. With **None**, the default, the text goes in as it was recognized, and a failed rewrite inserts the text as dictated.
- While a dictation records, the status bar shows it the way it shows a recording, with a stop button, the elapsed time, the size, and the input meter, and then follows each processing stage with a progress bar. On mobile a notice follows the same stages.
- A dictation is refused before the microphone opens when the engine it needs is not set up, and a dictation and a recording never hold the microphone together. When no note is open to take the text, it is copied to the clipboard.

## New: Voice boost in the player

The player's control row carries a **Voice boost** toggle between the volume slider and **Loop**. It runs the same three stages the **Clean up audio** dialog writes into a \`...-processed.wav\` - the high-pass filter, the noise gate, and loudness leveling - on the audio as it plays, with the values the cleanup settings hold. Nothing is decoded ahead and nothing is written, so one quiet passage is made intelligible without processing the whole recording. The switch applies to every playing recording at once and is offered where the runtime provides the Web Audio nodes it needs. A press with every cleanup stage switched off says where to turn one on instead of lighting the button over unchanged audio.

## New: DeepSeek for post-processing

DeepSeek is a fifth LLM engine, with an endpoint, a key, and a model list of its own on its page under **Transcription > Engines**, and it can be chosen for post-processing, chapter titles, and the advanced context agents. It seeds \`deepseek-flash\`, the default, and \`deepseek-v4-pro\`. DeepSeek offers no audio endpoint, so it is not a transcription engine. The cost estimate prices it at the weekday peak rate, and an off-peak run costs about half. Until now DeepSeek was reachable only by pointing the OpenAI base URL at it, which also moved Whisper API transcription onto an endpoint with no audio support.

## New: What's new after an update

The first run of a new version opens a **What's new** dialog with the notes of every release since the one you were on, newest first. The notes ship inside the plugin, so the dialog answers the same offline, and the **Show what's new** command opens every release on record at any time. **Release notes** under **Settings > Advanced Audio Recorder** switches the dialog off.

## Fixed

- The transcribe dialog put the estimate for the run directly above the session's accumulated spending, and neither figure said what it covered, so a run priced at a few cents beside a session at a few dollars read as a broken calculation. The two figures are now labelled **Estimated total for this run** and **Session spending**.
- The estimate did not change when the **LLM task** or the advanced two-pass switch changed, although both change what the run costs. Every control of the dialog now re-prices it.
- A dialog longer than the window scrolled its own title and **Close** button out of view. The title and the button now stay in place and the content scrolls between them.

## Internal

- The suite is 6247 tests across 252 suites, and it now fails a test that changes the shared default settings in place, which is what made coverage depend on the order the tests ran in.
- A release is cut by \`scripts/release.mjs\`, which refuses a version whose notes the plugin does not carry.

## Compatibility

Requires Obsidian 1.6.6+, unchanged. This release is backward compatible: existing recordings, stored settings, the recorder, and the players are unaffected. Quick notes and voice boost are off until switched on, and settings written by an earlier version carry no quick note engine, which then starts on the engine post-processing already uses.

The **What's new** dialog appears from the next update on. A vault that updates into this release records the version without showing the dialog, so these notes are opened with the **Show what's new** command.

**Full Changelog**: https://github.com/akhmialeuski/advanced-audio-recorder/compare/2.3.2...2.3.3
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
