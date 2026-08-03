# Record and summarize a meeting

This is an end-to-end workflow that ties several features together: you record a meeting, get back a **diarized transcript** (each speaker labelled) with clickable timecodes, and an **LLM-written summary** with action items - all without leaving Obsidian. It assumes you have read [Getting started](../getting-started.md); everything else you need is linked from here.

- [Goal](#goal)
- [Recommended setup](#recommended-setup)
    - [1. Pick a diarizing engine](#1-pick-a-diarizing-engine)
    - [2. Enable speaker diarization](#2-enable-speaker-diarization)
    - [3. Choose where the transcript goes](#3-choose-where-the-transcript-goes)
    - [4. Turn on LLM post-processing with the Summarize task](#4-turn-on-llm-post-processing-with-the-summarize-task)
    - [5. (Optional) Multiple microphones](#5-optional-multiple-microphones)
- [Steps: run the workflow](#steps-run-the-workflow)
- [Cleanup tips for noisy rooms and large files](#cleanup-tips-for-noisy-rooms-and-large-files)
- [End-to-end checklist](#end-to-end-checklist)
- [Troubleshooting](#troubleshooting)
- [Related guides](#related-guides)

## Goal

By the end of this guide you will be able to:

- **Capture a meeting** straight into your vault with one click.
- **Mark agenda items** as you go, so you can jump back to any topic later.
- Get a **diarized transcript** - every line attributed to a speaker (`Speaker 1`, `Speaker 2`, …) with a clickable timecode.
- Get an **LLM summary** with key points and action items written into the same note.

You configure this **once**. After that, every meeting is: click record > talk > click stop > read the summary.

The end result is one note with the recording, a diarized transcript, and an LLM-written summary, in this order:

```markdown
![[team-standup.webm]]

## Transcript

[[team-standup.webm#t=0:00]] **Speaker 1** Let's do a quick round of updates.
[[team-standup.webm#t=0:03]] **Speaker 2** I finished the API integration yesterday.

### Summary

#### Key points

- Standup covered current sprint progress.

#### Action items

- [ ] Review the API integration PR.
```

The `![[team-standup.webm]]` line renders as the [enhanced waveform player](../audio-player.md) once the note is open in Obsidian.

---

## Recommended setup

You only do this part once. All of it lives under **Settings > Advanced Audio Recorder > Transcription** unless noted otherwise.

### 1. Pick a diarizing engine

Diarization (splitting the transcript by speaker) is what makes a meeting transcript readable. Only two engines support it:

| Engine            | Diarization | Max file | Cost                        | Best for                                        | Set-up guide                       |
| ----------------- | ----------- | -------- | --------------------------- | ----------------------------------------------- | ---------------------------------- |
| **Deepgram**      | Yes         | 2 GB     | Free credit, then pay-as-go | Consistent speaker labels across the whole file | [Deepgram](deepgram-api-key.md)    |
| **Google Gemini** | Yes         | 2 GB     | Free tier, then paid        | Long recordings and reuse for LLM summarization | [Google Gemini](gemini-api-key.md) |

The **Whisper API** engine (OpenAI / Groq) and **local whisper.cpp** do **not** diarize - the **Speaker diarization** toggle is greyed out for them. Use them only if you do not need speaker labels.

For a multi-hour meeting, Deepgram sends the whole file in one request, so speaker numbering stays consistent end to end. Gemini also accepts up to 2 GB, but a recording longer than **15 minutes** is split into parts and stitched back together; a diarized split **resets speaker numbering** at each part boundary, which the plugin surfaces as a warning. If consistent labels across a very long meeting matter most, prefer Deepgram. See [Speakers and diarization](../transcription.md#speakers-and-diarization) for the full behavior.

1. Set **Transcription engine** to **Deepgram** or **Google Gemini**.
2. Paste the **API key** for that engine (follow the linked guide above).
3. Leave **Model** on its default (`nova-3` for Deepgram, `gemini-3.5-flash` for Gemini) unless you have a reason to change it.

### 2. Enable speaker diarization

1. Turn on **Enable transcription** at the top of the section.
2. Turn on **Speaker diarization**. With a non-diarizing engine selected, this toggle is disabled and greyed out - switch the engine first.

When diarization is on, several speaker-related options unlock further down in the **Transcript output** area:

| Option                  | Default         | What it does                                                     |
| ----------------------- | --------------- | ---------------------------------------------------------------- |
| **Include speakers**    | On              | Writes a speaker label on each line.                             |
| **Merge speaker turns** | On              | Combines consecutive lines from the same speaker into one block. |
| **Speaker format**      | `**{speaker}**` | The template that renders each label (bold by default).          |

![Speaker diarization toggle turned on in the Transcription settings, with the speaker-related output options visible below](../images/settings-transcription-diarization.png)
_Figure: With diarization on, the Include speakers, Merge speaker turns, and Speaker format options become available._

### 3. Choose where the transcript goes

A meeting note benefits from having both the readable transcript **in the note** and a machine-readable sidecar **file** you can reuse. Under **Transcript output > Destination**, pick one of:

| Destination                              | What you get                                                       |
| ---------------------------------------- | ------------------------------------------------------------------ |
| **Insert into note**                     | The transcript is written into the active note only.               |
| **Save to file**                         | A sidecar file next to the audio only; nothing in the note.        |
| **Note and file**                        | Both - the readable transcript in the note **and** a sidecar file. |
| **Save to file and link it in the note** | A sidecar file, with a link to it inserted in the note.            |

For meetings, **Note and file** is the most useful: you read the transcript inline, and you keep a structured sidecar (default **JSON**, which preserves speaker labels and word-level timings) for search or later reuse. Choose **Save to file and link it in the note** instead if you want to keep the note short and link out to the transcript.

When the destination is anything other than note-only, a **File format** option appears: **JSON** (default - full data including speakers and word timings), **SubRip .srt**, **WebVTT .vtt**, or **Plain text .txt**. Keep **JSON** for meetings so nothing is lost.

The in-note formatting defaults are already tuned for meetings:

| Setting                        | Default         | Effect                                                     |
| ------------------------------ | --------------- | ---------------------------------------------------------- |
| **Note heading**               | `## Transcript` | The heading the transcript is inserted under.              |
| **Include timestamps**         | On              | Prefixes each line with a timecode.                        |
| **Timestamps as player links** | On              | Makes each timecode clickable to seek the embedded player. |
| **Include speakers**           | On              | Shows the speaker label (diarization must be on).          |

See [Transcription](../transcription.md) for the complete output reference, and [Settings reference](../settings-reference.md) for every field and template.

### 4. Turn on LLM post-processing with the Summarize task

This is what turns a wall of transcript text into a usable summary with action items. In the **LLM post-processing** subsection (inside Transcription):

1. Turn on **Enable LLM post-processing**.
2. Set **Task** to **Summarize**. (The other tasks are **Clean up**, which fixes punctuation and formatting, and **Custom**, which sends your own instruction verbatim.)
3. Each task carries its own editable prompt. The **Summarize** prompt ships with a sensible default and has the transcript language appended automatically - edit it if you want a specific structure (for example, "list decisions, then action items with owners").
4. Pick its **Post-processing engine**: **OpenAI**, **Anthropic (Claude)**, or **Google Gemini**, and set that service up on its page under **Engines**.
5. Confirm the **API key**. The plugin shares keys where the same vendor does both jobs:
    - **OpenAI** LLM reuses your **Whisper API** key.
    - **Gemini** LLM reuses your **Gemini** key.
    - **Anthropic (Claude)** has its **own** dedicated key - see [Anthropic / Claude](anthropic-api-key.md).
6. Leave **Max output tokens** at its default of **4096** (range 512-200000) unless your summaries are getting cut off, in which case raise it.

Provider model defaults are **OpenAI** `gpt-5.6-sol`, **Anthropic** `claude-opus-4-8`, and **Gemini** `gemini-3.5-flash`. The **LLM base URL** auto-switches to the provider default unless you have typed a custom one.

A practical pairing: use **Gemini** for both transcription and the summary so one key covers everything, or **Deepgram** for the diarized transcript plus **OpenAI** or **Anthropic** for the summary. See [LLM post-processing](../llm-post-processing.md) for the full reference.

### 5. (Optional) Multiple microphones

If everyone in the room has their own microphone, or you want a clean track per participant, enable multi-track capture under **Settings > Advanced Audio Recorder > Multi-track recording**:

- Turn on **Enable multi-track recording**.
- Set **Maximum tracks** (1-8, default 2) and assign an **Track N input** to each microphone.
- Choose an **Output mode**: **Single file** (all mics mixed into one file - simplest to transcribe and diarize) or **Multiple files** (one file per track).

For a transcribe-and-diarize workflow, **Single file** is usually the right choice: the engine sees one timeline and can diarize across it. Multi-file output gives you per-speaker isolation but you would transcribe each file separately. See [Multi-track recording](../multi-track-recording.md) for the details.

> Multi-track is optional. A single good room or lapel microphone, plus diarization, already produces a per-speaker transcript.

---

## Steps: run the workflow

Once the setup above is done, each meeting is fast.

1. **Open the note** where you want the meeting captured, and place the cursor where the audio embed should go.
2. **Start recording.** Click the **microphone icon** in the left ribbon, or run **Start/stop recording** from the command palette. The ribbon icon and status bar show the live state, with an input-level meter and elapsed-time/size stats (configured under **Audio processing & feedback**).

3. **Mark agenda items as you go.** If **Markers and chapters** is enabled (under **Audio player** - this toggle appears only once **Enhanced audio player** is turned on), run **Add marker/chapter at current position** from the command palette each time the meeting moves to a new topic. These markers become seek-bar ticks and a jump list in the player, so you can return to any agenda item in one click later. See [Markers and chapters](../audio-player.md#markers-and-chapters).
4. **Pause if needed.** Run **Pause/resume recording** during a break; resume to continue the same file without losing progress.
5. **Stop and save.** Click the ribbon icon again (or run **Start/stop recording**). The status bar walks through the save stages (Saving > Flushing buffers > Assembling audio > Writing file > Cleaning up > Saved), and an audio embed link is inserted at your cursor.
6. **Let it transcribe.**
    - If you turned on **Transcribe after recording**, transcription starts automatically as soon as the file is saved.
    - Otherwise, with the audio file active, run **Transcribe audio** from the command palette.

    A progress dialog appears with a progress bar, an elapsed timer, **Cancel**, and **Minimize**. Click **Minimize** to send the job to the status bar and keep working in your vault; click the status bar entry to reopen the dialog. Closing the dialog cancels the job.

7. **Review the diarized transcript.** When transcription finishes, the transcript is written under the **Note heading** (`## Transcript` by default). Each line is attributed to a speaker and prefixed with a clickable timecode - click any timecode to seek the embedded player to that moment:

    ```markdown
    ## Transcript

    [[team-standup.webm#t=0:00]] **Speaker 1** Let's do a quick round of updates.
    [[team-standup.webm#t=0:03]] **Speaker 2** I finished the API integration yesterday.
    ```

    Start the recording playing and then click any later timestamp to jump playback straight to that line, so you can skim the transcript and drop into the audio wherever something needs a second listen. While it plays, the **status-bar playback controls** appear at the bottom-right of the window, letting you pause, skip 10 seconds either way, stop, adjust volume, or drop a marker or chapter without scrolling back to the embed. The controls dismiss when you stop playback. See [Playback controls in the status bar](../audio-player.md#playback-controls-in-the-status-bar).

    ![Status-bar playback controls shown while reviewing a meeting recording, with skip, play or pause, stop, volume, marker, chapter, and the elapsed over total time](../images/status-bar-playback-controls.png)
    _Figure: reviewing the transcript, the status-bar controls drive playback while you read and click timestamps._

8. **Put real names on the speakers.** With **Rename speakers** enabled (Settings > Transcription), right-click the recording and choose **Rename speakers**. Each speaker is one row: its label, a name field, and a **▶ button that plays where that speaker first talks** - so you identify `Speaker 2` by listening rather than by remembering, which matters because the dialog is covering the transcript. Press ▶ to hear the opening turn, ■ (the same button) to stop, type the name, and press **Apply**: every line in the note and in the transcript files is rewritten, and re-transcribing this recording later re-applies the names automatically.

    The names are stored **with the recording**, so the next time you open the dialog they are suggested back to you. To carry a recurring team across meetings, create a **participant profile** in the dialog once and pick it under **Participant profile** in the Transcribe dialog - the roster is then written into each recording it transcribes, and any new name you apply is added to both the recording and the profile. See [Naming speakers](../transcription.md#naming-speakers).

9. **Read the summary and action items.** Because **LLM post-processing** is on with the **Summarize** task, the LLM-written summary is produced alongside the transcript. Read the key points and action items, then assign owners or copy them into your task tracker.

---

## Cleanup tips for noisy rooms and large files

A meeting recorded in a noisy room or over a long session can need a little preparation before (or instead of) transcription.

**Noisy rooms - clean the audio first.** If the room has constant hum, HVAC noise, or low-level chatter, run **Clean up audio** on the saved recording before transcribing. Right-click the audio in the File Explorer, an embed link, or the player, choose **Clean up audio**, and enable the **High-pass filter** (and the **Noise gate** for dead air). A cleaner signal usually improves both diarization and transcription accuracy. The cleanup writes a new `…-processed.wav` copy and never touches the original. See [Audio cleanup](../audio-cleanup.md) for the stages, defaults, and recommended settings (the "Interview (two voices)" and "Lecture in a noisy room" presets there fit meetings well).

**Large files - convert or split if needed.** Both Deepgram and Gemini accept up to **2 GB**, so most meetings fit whole. If a recording is still too large, or you want to clean it up first but it exceeds the cleanup size cap, split it into parts and process each part:

- Use **Split audio into parts** from the right-click menu to break a long recording into fixed-duration parts. WAV splits losslessly. See [Splitting recordings](../splitting.md).
- Use **Convert audio format** to re-encode to a smaller, compressed container before transcribing. See [File operations](../file-operations.md).

> Tip: turn on **Split recordings automatically** (under **Audio splitting**) before a very long meeting so the recording is broken into parts as it is captured, rather than after the fact.

---

## End-to-end checklist

Use this once to confirm your setup, then just record.

**One-time setup**

1. Settings > Transcription > **Enable transcription** = On.
2. **Transcription engine** = Deepgram or Google Gemini, with a valid **API key**.
3. **Speaker diarization** = On.
4. **Transcript output > Destination** = **Note and file** (File format **JSON**).
5. **LLM post-processing** = On, **Task** = **Summarize**, its **Post-processing engine** chosen, and that engine's **API key** confirmed under **Engines**.
6. (Optional) **Rename speakers** = On, to replace `Speaker 1` with real names afterwards (with a play button per speaker so you can tell who is who).
7. (Optional) **Transcribe after recording** = On for hands-off transcription.
8. (Optional) **Audio player > Enhanced audio player** = On, then **Markers and chapters** = On (this toggle appears only after the enhanced player is enabled), to mark agenda items.
9. (Optional) **Multi-track recording** = On (Single file) if you use several microphones.

**Per meeting**

1. Open the note and place the cursor.
2. Start recording (ribbon icon or **Start/stop recording**).
3. Add a marker at each agenda item (**Add marker/chapter at current position**).
4. Stop recording (saves and inserts the embed).
5. Transcription runs (auto, or run **Transcribe audio**).
6. Review the diarized transcript and click timecodes to jump.
7. Run **Rename speakers**, play each speaker's sample, and give them real names.
8. Read the LLM summary and action items.

---

## Troubleshooting

- **The Speaker diarization toggle is greyed out** - the selected engine cannot diarize. Switch **Transcription engine** to **Deepgram** or **Google Gemini**.
- **Speaker numbers reset partway through a long Gemini transcript** - Gemini splits recordings longer than 15 minutes into parts, and diarized splits restart speaker numbering at each boundary (surfaced as a warning). Use **Deepgram** for consistent labels across a long meeting.
- **The play buttons in Rename speakers are greyed out** - that recording's roster predates speaker samples. Transcribe it once more with **Speaker diarization** on and the samples appear.
- **No summary appeared** - confirm **Enable LLM post-processing** is on, **Task** is **Summarize**, and the chosen engine's **API key** is set on its page under **Engines** (the OpenAI and Gemini pages are shared with transcription; Anthropic keeps its own).
- **The summary is cut off** - raise **Max output tokens** (default 4096), up to whatever your model allows; the service refuses a larger budget and names its own maximum.
- **Transcription accuracy is poor in a noisy room** - run [Clean up audio](../audio-cleanup.md) first, or move to a better microphone.
- **The transcription dialog closed and the job stopped** - closing the dialog cancels the job. Use **Minimize** to keep it running in the status bar.

For diagnostics, the **System info** report, and verbose **Debug mode**, see [Troubleshooting](../troubleshooting.md).

---

## Related guides

- [Transcription](../transcription.md) - engines, diarization, output formats, and destinations.
- [Speakers and diarization](../transcription.md#speakers-and-diarization) - how speaker labels are produced and formatted.
- [LLM post-processing](../llm-post-processing.md) - clean up or summarize transcripts with an LLM.
- [Deepgram](deepgram-api-key.md) and [Google Gemini](gemini-api-key.md) - get a diarizing-engine API key.
- [Anthropic / Claude](anthropic-api-key.md) - get an LLM key for the summary task.
- [Multi-track recording](../multi-track-recording.md) - record several microphones at once.
- [Enhanced audio player](../audio-player.md) and [Markers and chapters](../audio-player.md#markers-and-chapters) - navigate the recording.
- [Audio cleanup](../audio-cleanup.md) - clean up a noisy room recording before transcribing.
- [File operations](../file-operations.md) and [Splitting recordings](../splitting.md) - convert or split large files.
- [Settings reference](../settings-reference.md) - every setting, option, and default.
