# Script recordings from the terminal

Every action of the plugin is also a command of Obsidian's desktop [command line](../command-line.md), so the jobs that take many clicks in the app become one line in a terminal or a shell script. The recipes below are complete commands for the common ones. Each runs inside the Obsidian app that is open, with the vault, settings and API keys it already has, and prints a line saying what it did or why it did nothing.

- [Before you start](#before-you-start)
- [Checking the recorder from a shell](#checking-the-recorder-from-a-shell)
- [Recording a timed session](#recording-a-timed-session)
- [Transcribing a folder overnight](#transcribing-a-folder-overnight)
- [Processing one meeting end to end](#processing-one-meeting-end-to-end)
- [Finding a moment and linking to it](#finding-a-moment-and-linking-to-it)
- [Sharing a recording as a small MP3](#sharing-a-recording-as-a-small-mp3)
- [Exporting chapters for a podcast app](#exporting-chapters-for-a-podcast-app)
- [Fixing a transcript line without opening the note](#fixing-a-transcript-line-without-opening-the-note)
- [Stopping a script on a refusal](#stopping-a-script-on-a-refusal)
- [Related pages](#related-pages)

## Before you start

Turn on Obsidian's command line under **Settings > General > Command line interface** and keep Obsidian running. Check that the plugin answers:

```bash
obsidian advanced-audio-recorder
```

It prints what the recorder is doing, for example `Idle. A recording started now is saved as WEBM.` List the commands and their parameters with Obsidian's own help:

```bash
obsidian help advanced-audio-recorder:transcribe
```

Commands take the vault the terminal is in, or the one active in the app. A script that should always reach one vault names it with `vault=` before the command, for example `obsidian vault=Work advanced-audio-recorder:queue`.

## Checking the recorder from a shell

A status bar or a shell prompt can ask whether a recording is running. The answer's first line starts with `Recording.` while one is:

```bash
obsidian advanced-audio-recorder | head -n 1
```

The playback commands answer `Nothing is playing in Obsidian.` when nothing plays, so a hotkey daemon can bind `play-pause`, `skip-back` and `skip-forward` without checking first.

## Recording a timed session

A lecture or a call that starts and ends on the clock can be recorded with the configured input and format, here for 50 minutes:

```bash
obsidian advanced-audio-recorder:record && sleep 3000 && obsidian advanced-audio-recorder:stop
```

`stop` answers with the state it left behind once the file is saved. A recording that captures this computer's own output, **Include system audio** or a **System audio (this computer)** track, cannot be started this way, because the system grants that capture only in answer to a click in Obsidian, so `record` then answers with the reason and starts nothing. A loopback input device has no such limit, see [Recording a call with its remote participants](meeting-notes-workflow.md#recording-a-call-with-its-remote-participants).

## Transcribing a folder overnight

A week of recordings can be queued at the end of the day and transcribed while the computer is idle. `start` starts the queue right away:

```bash
obsidian advanced-audio-recorder:transcribe-folder folder=Recordings/2026-10 start
```

The command answers how many recordings it queued, and leaves out the ones already queued. In the morning, `queue` prints the state of the queue and one tab-separated line per recording with its state, and a failed one with the reason:

```bash
obsidian advanced-audio-recorder:queue
```

`queue remove="Recordings/2026-10/call.webm"` drops one entry, `queue pause` stops after the recording being transcribed, and `queue clear` removes everything that is not running.

## Processing one meeting end to end

The note `Meetings/2026-10-14 Standup.md` embeds the recording of the meeting. One script transcribes it into the note with speakers, names them, generates chapters, adds the chapter outline to the note and splits the recording at its chapters. `wait` makes `transcribe` answer only when the transcript is written, so the next step reads a finished one:

```bash
NOTE="2026-10-14 Standup"
obsidian advanced-audio-recorder:transcribe file="$NOTE" diarize=on wait
obsidian advanced-audio-recorder:speakers file="$NOTE" map="Speaker 1=Ann; Speaker 2=Bob"
obsidian advanced-audio-recorder:chapters file="$NOTE"
obsidian append file="$NOTE" content="$(obsidian advanced-audio-recorder:export-chapters file="$NOTE" format=outline)"
obsidian advanced-audio-recorder:split file="$NOTE" by=chapters
```

Run `speakers file="$NOTE"` without `map` first to see the labels the engine used, each with its name and the syntax to rename them. Two speakers given one name merge for good, so such a map is refused unless `merge` is added.

## Finding a moment and linking to it

`markers` searches the bookmarks and chapters of every recording in the vault. With `format=json` it answers with an array of objects carrying `recordingPath`, `recordingName`, `time` in seconds, `label`, `kind` and `note`, which goes straight into `jq`, here to print the recording, the time and the label of every chapter about the budget:

```bash
obsidian advanced-audio-recorder:markers query=budget kind=chapter format=json | jq -r '.[] | [.recordingPath, .time, .label] | @tsv'
```

A link to a moment for pasting into another note comes from `timestamp-link`, and Obsidian's `--copy` puts it on the clipboard:

```bash
obsidian advanced-audio-recorder:timestamp-link file=standup at=1:15 --copy
```

## Sharing a recording as a small MP3

A long recording is easier to send as a mono MP3 at a low bitrate. `source=keep` keeps the original, and `links=none` leaves the notes pointing at it:

```bash
obsidian advanced-audio-recorder:convert path=Recordings/standup.webm to=mp3 channels=mono-mix bitrate=64 source=keep links=none
```

Without `to=` the command answers with the formats this device can encode, which differ between computers.

## Exporting chapters for a podcast app

A cue sheet next to the recording carries its chapters into a player or an editor that reads them:

```bash
obsidian advanced-audio-recorder:export-chapters file=standup format=cue
```

`format=list` writes a plain list instead, and `print` prints either one rather than writing a file.

## Fixing a transcript line without opening the note

A diarization engine sometimes gives one speaker's words to another. `split-line` moves words of one line to another speaker, by the line number the editor shows:

```bash
obsidian advanced-audio-recorder:split-line file="2026-10-14 Standup" line=12 text="Sounds good to me." speaker=Bob
```

The edit reads the line and writes it back only if nobody changed it in between, so a note being edited in the app is never overwritten, and the command then answers that the lines changed.

## Stopping a script on a refusal

A command that cannot run says why and changes nothing, but it still exits like any other command, so a script decides from the answer. One that must not go on after a refusal compares the first word:

```bash
ANSWER=$(obsidian advanced-audio-recorder:transcribe file="2026-10-14 Standup" wait)
case "$ANSWER" in Transcribed*) echo "$ANSWER" ;; *) echo "Stopped: $ANSWER" >&2; exit 1 ;; esac
```

## Related pages

- [Command line](../command-line.md) is the reference for every command and parameter.
- [Record and summarize a meeting](meeting-notes-workflow.md) covers the same meeting from the app.
- [Transcription](../transcription.md#transcribing-a-folder) explains the transcription queue.
