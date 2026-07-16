# Record a voice memo or lecture on your phone

This guide captures a recording on the Obsidian mobile app - a quick voice memo, or a longer lecture or meeting - so it lands in your vault as a playable embed, then optionally turns it into text with a cloud transcription engine. It uses the same recording and transcription features documented elsewhere; this page is the mobile-specific walkthrough, with the platform differences called out where they matter.

- [Goal](#goal)
- [Prerequisites](#prerequisites)
- [Step-by-step](#step-by-step)
    - [1. Open the note for the recording](#1-open-the-note-for-the-recording)
    - [2. Start recording](#2-start-recording)
    - [3. Stop and save](#3-stop-and-save)
    - [4. Play it back](#4-play-it-back)
    - [5. (Optional) Transcribe with a cloud engine](#5-optional-transcribe-with-a-cloud-engine)
- [What is different on mobile](#what-is-different-on-mobile)
- [Tips](#tips)
- [Troubleshooting](#troubleshooting)

## Goal

Record audio on a phone or tablet, have the file saved into your vault with an embed link in your note, and play it back in the enhanced waveform player. When you want the words as text too, run a cloud transcription engine over the recording and drop the transcript into the same note. Everything stays in the vault and syncs to your other devices.

## Prerequisites

1. **Install and enable the plugin** in the Obsidian mobile app. Open **Settings > Community plugins**, turn off **Restricted mode** if it is on, tap **Browse**, search for **Advanced Audio Recorder**, then **Install** and **Enable**. See [Getting started](../getting-started.md#from-community-plugins).
2. **Allow microphone access.** The first time you record, the operating system asks to let Obsidian use the microphone - choose **Allow**. If capture stays silent, enable microphone access for Obsidian in your phone's system settings.
3. **(Only for transcription) Pick a cloud engine and add its key.** Local `whisper.cpp` is desktop-only, so on mobile use the **Whisper API**, **Deepgram**, or **Google Gemini** engine. Each has a setup guide: [OpenAI / Whisper API key](openai-whisper-api-key.md), [Groq (free tier)](groq-whisper-setup.md), [Deepgram API key](deepgram-api-key.md), or [Gemini API key](gemini-api-key.md).

> If you only want to record and play back, you can skip prerequisite 3 entirely - transcription is optional.

---

## Step-by-step

### 1. Open the note for the recording

Open or create the note where you want the audio link to land, and place your cursor where the embed should go. The plugin remembers this note when you start, so the finished link is inserted here even if you navigate away while recording.

### 2. Start recording

The mobile app has no ribbon icon, so start the capture from the command palette:

1. Open the command palette and run **Start/stop recording**. You can also add this command to the mobile toolbar for one-tap access under **Settings > Toolbar**.
2. A short `Recording started` notice confirms the session is live, and the [mobile recording banner](../recording.md#mobile-recording-banner) appears with a recording indicator, the elapsed time, and a stop button.
3. Speak, or let the lecture or meeting run. To pause, run **Pause/resume recording**; run it again to resume. Paused time is excluded from the elapsed counter.

If **Markers and chapters** is enabled, you can drop a bookmark or chapter at the live position with the **Add marker/chapter at current position** command - handy for flagging the start of a topic in a lecture. See [Marking moments while recording](../recording.md#marking-moments-while-recording).

### 3. Stop and save

Tap the **stop** button on the recording banner, or run **Start/stop recording** again. The plugin flushes its buffers, assembles the file, writes it to your save location, and inserts an embed link (`![[recording-….m4a]]`) into your note. A long recording is saved as several self-contained part files (`...-part1`, `...-part2`, and so on) when it exceeds the in-memory buffer limit, with a link to each part inserted into the note.

### 4. Play it back

The inserted embed plays your recording in the note. Turn on the **Enhanced audio player** under **Settings > Advanced Audio Recorder > Audio player** for the waveform seek bar, playback-speed presets, skip, volume, loop, the time display, and per-file markers and chapters - all of which work on mobile. See [Audio player](../audio-player.md).

### 5. (Optional) Transcribe with a cloud engine

To turn the recording into text on the phone:

1. Open **Settings > Advanced Audio Recorder > Transcription** and turn on **Enable transcription**.
2. Choose a **cloud** engine - **Whisper API**, **Deepgram**, or **Google Gemini** - and confirm its API key is set. Deepgram and Gemini also add speaker diarization for meetings and interviews.
3. Long-press the recording (in the File Explorer, on its embed link, or on the player) and choose **Transcribe audio**, or run the **Transcribe audio** command with the audio file active. The transcription dialog opens, runs, and writes the transcript to your configured destination.

To have every recording transcribed automatically the moment it is saved, turn on **Transcribe after recording** as well - see [Transcribe automatically after every recording](transcribe-after-recording.md). Make sure a cloud engine is selected, because a synced desktop configuration that selects the local engine is skipped on mobile with a notice.

---

## What is different on mobile

Recording on a phone follows the same workflow as the desktop, with a few platform limits the plugin applies automatically. The unavailable options are shown **greyed out** in settings, never hidden:

- **One microphone, one track.** Input device selection and multi-track recording are desktop-only; the phone records a single track from its default microphone.
- **The format follows the device.** iOS records AAC (`mp4` / `m4a`); Android records Opus (`webm` / `ogg`). If the stored format cannot be recorded on this device, the plugin falls back to the platform's best recordable format and says so.
- **Sample rate and recording channels are fixed.** The mobile OS sets the sample rate, and the mono/channel-pick options need a multi-channel input device that only the desktop exposes.
- **Long recordings become parts automatically.** Time-based automatic splitting is desktop-only, but a mobile recording is still rotated into part files by size so no single file grows too large.
- **Keep the app in the foreground.** Locking the screen, switching apps, or an incoming call can suspend Obsidian and interrupt the capture. This is a mobile operating-system limit, not a plugin setting.

For the full list, see [Mobile support](../mobile-support.md) and [Recording on mobile](../recording.md#recording-on-mobile).

## Tips

- **Add the command to the mobile toolbar.** With no ribbon icon on mobile, putting **Start/stop recording** on the toolbar makes starting a capture a single tap.
- **Watch the banner, not the status bar.** On mobile the floating [recording banner](../recording.md#mobile-recording-banner) is where the elapsed time and stop button live. Leave the **Mobile recording banner** setting on so an active recording is always visible.
- **Screen on for long captures.** For a lecture or a meeting, keep the screen awake and Obsidian in the foreground so the operating system does not suspend the recording.
- **Transcribe later on any device.** The recording and its markers are just files in the vault, so you can record on the phone and transcribe - or run the desktop-only local `whisper.cpp` engine - once the vault syncs to a desktop.

## Troubleshooting

- **No `Start/stop recording` in the palette.** Confirm the plugin is enabled under **Settings > Community plugins**. On mobile there is no ribbon icon, so the command palette (or a toolbar button) is how you start a recording.
- **Recording is silent.** Grant microphone access to Obsidian in the phone's system settings, and make sure no other app is holding the microphone.
- **The file saved in a different format than I set.** The device could not record the configured format, so the plugin fell back to the platform's best recordable format and showed a notice. See [Recording formats and automatic fallback](../mobile-support.md#recording-formats-and-automatic-fallback).
- **Transcription is skipped or blocked.** The **Local whisper.cpp** engine is desktop-only. Select **Whisper API**, **Deepgram**, or **Google Gemini** under **Settings > Advanced Audio Recorder > Transcription**. See [Transcription on mobile](../mobile-support.md#transcription-on-mobile).
- **The recording stopped when I switched apps.** The mobile operating system suspended Obsidian in the background. Keep the app in the foreground and the screen on for long recordings; parts already saved to disk are kept.
