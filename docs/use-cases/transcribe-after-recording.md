# Transcribe automatically after every recording

This guide sets up a hands-off workflow: you stop a recording, and the plugin immediately starts transcribing it and drops the transcript into the same note - no extra clicks, no context menus. It builds on the regular [Transcription](../transcription.md) feature, so you configure the engine, destination, and output once, then let it run after every recording.

- [Goal](#goal)
- [Prerequisites](#prerequisites)
- [Step-by-step setup](#step-by-step-setup)
    - [1. Enable transcription](#1-enable-transcription)
    - [2. Turn on "Transcribe after recording"](#2-turn-on-transcribe-after-recording)
    - [3. Set your defaults](#3-set-your-defaults)
    - [4. Record](#4-record)
    - [5. Watch the transcription dialog auto-start](#5-watch-the-transcription-dialog-auto-start)
- [Where the transcript lands](#where-the-transcript-lands)
- [Important: only the first saved file is transcribed](#important-only-the-first-saved-file-is-transcribed)
- [Tips](#tips)
- [Troubleshooting](#troubleshooting)

## Goal

Record audio, stop, and get a finished transcript in your note automatically. The plugin opens its transcription dialog the moment a recording is saved, runs the job using your saved settings, and inserts the result into the note where the recording link went. You stay in control: the dialog still shows progress and a **Cancel** button, and you can minimize it to keep working while the job finishes.

This is the same engine and output described in [Transcription](../transcription.md) - the only difference is that the run starts on its own instead of from the **Transcribe audio** command or the right-click menu.

---

## Prerequisites

Before automatic transcription can do anything useful, you need a transcription engine that is configured and working when run manually.

1. **Pick an engine** and get it ready. Each engine has a dedicated setup guide:

| Engine                        | Setup guide                                           | Needs a key? | Diarization |
| ----------------------------- | ----------------------------------------------------- | ------------ | ----------- |
| Whisper API (OpenAI)          | [OpenAI / Whisper API key](openai-whisper-api-key.md) | Yes          | No          |
| Whisper API (Groq, free tier) | [Groq Whisper setup](groq-whisper-setup.md)           | Yes          | No          |
| Deepgram                      | [Deepgram API key](deepgram-api-key.md)               | Yes          | Yes         |
| Google Gemini                 | [Gemini API key](gemini-api-key.md)                   | Yes          | Yes         |
| Local `whisper.cpp` (offline) | [Local whisper.cpp](local-whisper-cpp.md)             | No           | No          |

2. **Confirm it works once, manually.** Open any audio file, run **Transcribe audio** from the command palette (or from the right-click menu), and make sure a transcript comes back. Automatic transcription uses the exact same configuration, so if a manual run succeeds, the automatic one will too.

3. (Optional) **Decide on output formatting.** Destination, file format, diarization, and the in-note template all come from your settings. Set them now so the automatic transcript looks the way you want - see [Transcription](../transcription.md) for the full output options and [LLM post-processing](../llm-post-processing.md) if you also want an automatic clean-up or summary.

> If you have not chosen an engine yet, read [Transcription](../transcription.md) first - it compares all four engines (cost, file-size limits, diarization, offline) so you can pick the right one for voice notes, meetings, or long lectures.

---

## Step-by-step setup

All of this lives under **Settings > Advanced Audio Recorder > Transcription**.

### 1. Enable transcription

Turn on **Enable transcription**. This reveals the rest of the transcription settings, including the engine picker, language, diarization, output destination, and the **LLM post-processing** subsection. Without this toggle on, nothing transcribes - manually or automatically.

### 2. Turn on "Transcribe after recording"

Switch on **Transcribe after recording** (off by default). This is the toggle that arms the automatic workflow. With it on, the plugin opens the transcription dialog and starts a run the instant a recording is saved.

### 3. Set your defaults

Automatic runs use your saved settings with no prompt, so set them before you record:

| Setting                 | Where                                  | Notes                                                                                                      |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Transcription engine** | Transcription section                 | Whisper API, Deepgram, Google Gemini, or local `whisper.cpp`. Default: Whisper API.                        |
| **Language**            | Transcription section                  | `auto` to detect, or an ISO code such as `en`, `ru`, `es`. Default: `auto`.                                |
| **Speaker diarization** | Transcription section                  | Speaker labels. Only available on Deepgram and Gemini; greyed out for Whisper API and local `whisper.cpp`. |
| **Destination**         | Transcript output                      | Insert into note, Save to file, Note and file, or Save to file and link it. Default: Insert into note.     |
| **File format**         | Transcript output (when not note-only) | JSON, SubRip `.srt`, WebVTT `.vtt`, or Plain text `.txt`. Default: JSON.                                   |
| **Note heading**        | Transcript output                      | The heading the transcript is inserted under. Default: `## Transcript`.                                    |
| **Include timestamps**  | Transcript output                      | Clickable timecode links in the note. Default: On.                                                         |
| **LLM post-processing** | LLM post-processing                    | Optional automatic clean-up, summary, or custom instruction. Default: Off. See below.                      |

For the full list of output options (timestamp/speaker/line templates, the note vs. file destinations, and word-level timestamps), see [Transcription](../transcription.md). To have every automatic transcript cleaned up or summarized by an LLM in the same pass, enable it under [LLM post-processing](../llm-post-processing.md) - it runs as part of the same automatic job.

> The transcription dialog still appears for automatic runs and lets you override most options **for that one run** before or after it starts. But the values above are what an unattended run uses, so get them right once.

### 4. Record

Record as you normally would - see [Recording](../recording.md) for the full workflow:

1. Click the **microphone icon** in the left ribbon, or run **Start/stop recording** from the command palette.
2. Speak or play audio. Pause and resume as needed.
3. Click the ribbon icon again (or run the command) to **stop**.

The recording saves, the audio embed link (`![[recording-….webm]]`) is inserted into your active note, and the automatic transcription begins.

### 5. Watch the transcription dialog auto-start

As soon as the first file is saved, the **Transcribe audio** dialog opens and starts running on its own. You did not have to click **Transcribe** - the run auto-starts. The dialog gives you full visibility and control:

- A **progress bar** and a status label (e.g. `Transcribing...`, or a finer stage the engine reports).
- A live **elapsed-time** counter (`Elapsed m:ss`).
- A **Cancel** button to stop the job. Closing the dialog while a run is in progress also cancels it.
- A **Minimize** button to send the job to the status bar and keep working (see [Tips](#tips)).

When the job finishes, the dialog closes (or, if you minimized it, the status-bar entry clears) and the transcript is written to the configured destination.

---

## Where the transcript lands

The automatic transcript is targeted at **the same note the recording embed was inserted into** - not whatever note happens to be active when the job finishes. The plugin captures the target note when the recording is saved, so even if you navigate away during a long transcription, the result still lands in the right place.

This matters for two reasons:

- **In-note destination.** If your destination inserts into the note (Insert into note, or Note and file), the transcript appears under your configured **Note heading** in that note, below the recording link.
- **Timecode links resolve correctly.** Clickable timestamps such as `[[recording#t=1:30]]` are built against that note's recording embed, so clicking them jumps the [enhanced player](../audio-player.md) in that note to the right position.

If the target note cannot be written to - for example the recording was made while no Markdown note was active, so there is no note to insert into - a note-only destination is automatically downgraded to a file so the transcript is never lost. The sidecar transcript file is written next to the audio instead.

The recording link and its transcript end up in the same note, embed first and transcript below it under its heading:

```markdown
![[recording-1710000000000.webm]]

## Transcript

[[recording-1710000000000.webm#t=0:00]] Thanks for the quick voice note, here is the plan for tomorrow.
```

---

## Important: only the first saved file is transcribed

Automatic transcription transcribes **only the first saved audio file** from a recording session. This is by design, and it changes how two features interact with the workflow.

| Session type                                            | What gets saved                                 | What auto-transcribes       | How to transcribe the rest                           |
| ------------------------------------------------------- | ----------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| Single recording                                        | One file                                        | That file                   | Nothing else to do.                                  |
| [Multi-track](../multi-track-recording.md), single file | One mixed file                                  | The mixed file              | Nothing else to do.                                  |
| [Multi-track](../multi-track-recording.md), per track   | One file per track (same audio, different mics) | Only the first track's file | Transcribe the desired track manually (see below).   |
| [Auto-split](../recording.md)                           | One file per part                               | Only the first part         | Transcribe each remaining part manually (see below). |

The reason: a multi-track session in **Multiple files** mode produces several tracks of the same conversation - transcribing each would be redundant and multiply your API cost. An auto-split session would otherwise fire one transcription request per part. So the plugin transcribes the first file only and leaves the rest to you.

**To transcribe any other file manually**, use either:

- The **right-click > Transcribe audio** menu on the file in the File Explorer, an audio embed link, or the embedded player, or
- The **Transcribe audio** command from the command palette, with the audio file open as the active pane.

Both open the same **Transcribe audio** dialog - the difference is that you press **Transcribe** yourself instead of it auto-starting. For multi-track per-track output, pick the track you actually want a transcript of; for auto-split, transcribe each part you need. See [Multi-track recording](../multi-track-recording.md) and [Recording](../recording.md) for how those sessions are saved.

---

## Tips

- **Minimize and keep working.** Press **Minimize** in the dialog to send the running job to the status bar. Click the status-bar entry to reopen the full dialog. This is ideal for long recordings on a paid engine - you do not have to sit and watch.

- **Recording takes precedence in the status bar.** If you start a new recording while a previous transcription is minimized, the status bar shows the **recording controls** instead of the transcription progress, because the recording controls need to be reachable. The transcription keeps running in the background and its status-bar entry returns once recording goes back to idle.

- **Closing cancels.** Closing the dialog (the **Close**/**Cancel** button or the modal's close action) while a job is running cancels that job. To keep it running out of the way, use **Minimize**, not **Close**.

- **Override per run when you need to.** Even on an automatic run, the dialog lets you change the engine, language, diarization, destination, file format, and the LLM task for that one run before it finishes - without touching your saved settings. Handy when one recording needs a different language or a summary that the rest do not.

- **Add an automatic LLM clean-up or summary.** Turn on **LLM post-processing** so every automatic transcript is also cleaned up, summarized, or run through your custom instruction in the same pass. See [LLM post-processing](../llm-post-processing.md).

- **No hotkey is required.** The whole workflow is hands-off after you stop the recording, but note the plugin assigns no default hotkeys - set your own **Start/stop recording** shortcut under **Settings > Hotkeys** if you want to record without the ribbon.

---

## Troubleshooting

- **The dialog does not appear after recording.** Confirm both **Enable transcription** and **Transcribe after recording** are on under **Settings > Advanced Audio Recorder > Transcription**. Both are required; **Transcribe after recording** is off by default.
- **`Transcription failed: …`** - the dialog shows the cause. The most common reasons are a missing or invalid API key, the wrong base URL, or a file larger than the engine's limit. Verify the engine works with a manual run, then re-check the relevant setup guide for your engine in the [Prerequisites](#prerequisites) table.
- **Only one of several files got a transcript.** That is expected - see [Important: only the first saved file is transcribed](#important-only-the-first-saved-file-is-transcribed). Transcribe the rest manually.
- **The transcript went to a file instead of the note.** The recording was saved while no editable Markdown note was active, so a note-only destination was downgraded to a sidecar file to avoid losing the transcript. Record with a note open, or set a destination that always writes a file.
- **The timestamps don't jump the player.** Timecode links resolve against the note that holds the recording embed. Make sure you are clicking them in that note, and that the [enhanced audio player](../audio-player.md) is enabled. For the full transcription output reference, see [Transcription](../transcription.md).
