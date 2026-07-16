# Getting started

This guide takes you from zero to your first recording with **Advanced Audio Recorder**. You will install the plugin, grant your microphone access, record and play back a clip, learn where files are saved, and run through a quick configuration checklist. No audio-engineering background is needed - every step is spelled out.

- [Requirements](#requirements)
- [Installation](#installation)
    - [From Community Plugins](#from-community-plugins)
    - [Manual installation](#manual-installation)
- [Granting microphone access](#granting-microphone-access)
- [Your first recording](#your-first-recording)
- [Playing it back](#playing-it-back)
- [Where recordings are saved](#where-recordings-are-saved)
- [Quick configuration checklist](#quick-configuration-checklist)
- [Next steps](#next-steps)

## Requirements

Advanced Audio Recorder runs on both **desktop and mobile** (iOS and Android); this guide is written for the desktop app, and [Mobile support](mobile-support.md) covers the platform differences. Before you start, make sure you have:

| Requirement               | Detail                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform**              | The Obsidian **desktop** app (Windows, macOS, or Linux) or the **mobile** app (iOS or Android); a few features are desktop-only.         |
| **Obsidian version**      | App version **1.6.6 or newer**. Update Obsidian from **Settings > About > Check for updates** if you are on an older build.              |
| **A microphone**          | Any built-in or external input device that your operating system recognizes.                                                             |
| **Microphone permission** | Your operating system must allow the Obsidian app to use the microphone (see [Granting microphone access](#granting-microphone-access)). |

This plugin is open source under the MIT license. The full repository lives at [github.com/akhmialeuski/advanced-audio-recorder](https://github.com/akhmialeuski/advanced-audio-recorder).

---

## Installation

You can install the plugin from Obsidian's built-in plugin browser (recommended) or by copying the files in manually.

### From Community Plugins

1. Open **Settings** in Obsidian.
2. Go to **Community plugins** and turn off **Restricted mode** (also called **Safe mode**) if it is on.
3. Click **Browse** to open the community plugin catalogue.
4. Search for **Advanced Audio Recorder**.
5. Click **Install**.
6. Click **Enable**.

Once enabled, a **microphone icon** appears in the left ribbon and a new **Advanced Audio Recorder** entry appears in your settings.

### Manual installation

Use this method to install a specific release or a build you compiled yourself.

1. Download `main.js`, `manifest.json`, and `styles.css` from the [release page](https://github.com/akhmialeuski/advanced-audio-recorder/releases).
2. Create the folder `advanced-audio-recorder` inside your vault's plugin directory:
    ```
    <vault>/.obsidian/plugins/advanced-audio-recorder/
    ```
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
4. Restart Obsidian (or reload it), open **Settings > Community plugins**, and **Enable** **Advanced Audio Recorder**.

The `.obsidian` folder is hidden by default; enable hidden files in your file manager if you cannot see it.

---

## Granting microphone access

The plugin records through your operating system's microphone, so the OS must grant Obsidian permission to use it. The first time you record, your system may show a permission prompt - choose **Allow**. If you never see a prompt, or no sound is captured, set the permission manually:

- **Windows** - open **Settings > Privacy & security > Microphone**, make sure **Microphone access** and **Let desktop apps access your microphone** are on, and confirm Obsidian (or the desktop-apps group) is allowed.
- **macOS** - open **System Settings > Privacy & Security > Microphone** and enable **Obsidian**. You may need to quit and reopen Obsidian for the change to take effect.
- **Linux** - make sure your audio server (PipeWire or PulseAudio) exposes the input device and that no other application holds it exclusively. Use your distribution's sound settings to verify the input is active.

If recording produces no sound:

1. Confirm the correct **Input device** is selected in **Settings > Advanced Audio Recorder > Audio input** (see [Audio input](settings-reference.md#audio-input)).
2. Run **Test recording** from **Settings > Advanced Audio Recorder > Diagnostics** - it records a five-second clip with your current settings and plays it back, and nothing is saved to your vault.
3. Re-check the OS permission above, and make sure no other app is holding the microphone.

See [Troubleshooting](troubleshooting.md) for more on capture problems.

---

## Your first recording

With the plugin enabled and your microphone allowed, record your first clip:

1. Open or create a note where you want the audio link to land, and place your cursor there.
2. Click the **microphone icon** in the left ribbon, or open the command palette (`Ctrl/Cmd + P`) and run **Start/stop recording**. The plugin assigns no default hotkeys; you can add your own under **Settings > Hotkeys**.
3. Speak (or play audio) into your microphone. While recording:
    - The **ribbon icon** changes from a microphone to an active recording indicator.
    - The **status bar** shows `Recording...` with **Pause** and **Stop** buttons. If you enabled **Markers and chapters**, an **Add marker** button appears too.
    - When enabled, a live **input level meter** and **recording stats** (elapsed time and total recorded size) appear in the status bar.
4. To pause, click **Pause** in the status bar (or run **Pause/resume recording**); the status bar then reads `Recording paused`. Click **Resume** to continue.
5. To finish, click the ribbon icon again (or run **Start/stop recording** again), or click **Stop** in the status bar.

![Status bar reading Recording with Pause, Stop, and Add marker buttons and a live input level meter](images/status-bar-recording.png)
_Figure: The status bar while a recording is in progress._

When you stop, the plugin flushes the audio buffers, assembles the final file, writes it to your save location, and inserts an embed link (`![[filename.ext]]`) into the active note. For longer recordings, saving can take a moment; the status bar shows a progress bar that walks through `Saving... > Flushing buffers... > Assembling audio... > Writing file... > Cleaning up... > Saved`, and the ribbon switches to a **save** icon while saving runs.

For the full recording workflow - markers, pause/resume, automatic splitting, and crash recovery - see [Recording](recording.md).

---

## Playing it back

The inserted embed link plays your recording directly in the note. Out of the box you get Obsidian's built-in audio player.

For a richer experience, turn on the **Enhanced audio player**:

1. Open **Settings > Advanced Audio Recorder > Audio player**.
2. Enable **Enhanced audio player**. Two extra options appear: **Show waveform** (on by default) and **Markers and chapters** (on by default).
3. Reopen or re-render the note. The embed is now a waveform player with playback-speed presets, ±10-second skip, volume and mute, a loop toggle, an elapsed/total time display, and a copy-timestamp-link button.

The enhanced player applies to **audio-only** files. Files that carry a video track, and any file the app cannot decode, keep Obsidian's built-in player. See [Audio player](audio-player.md) for the full control reference, markers and chapters, and timecode links.

![Enhanced audio player showing the waveform seek bar and the transport controls](images/player-overview.png)
_Figure: The enhanced audio player with its waveform seek bar._

---

## Where recordings are saved

By default, recordings are written to your **vault root** with the file prefix `recording` (for example `recording-1710000000000.webm`) in **WebM** format. You can change all three. Two settings control the destination:

| Setting                              | What it does                                                                                                                      | Default    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Save folder**                      | The vault folder where recordings are stored. Type to autocomplete from your existing folders.                                    | Vault root |
| **Save recordings near active file** | Saves each recording in the same folder as the currently active note. This **takes priority** over **Save folder** when it is on. | Off        |

When **Save recordings near active file** is on, an optional **Active file subfolder** field appears - set it (for example `audio`) to place recordings in a subfolder next to the note; the folder is created automatically if it does not exist.

You can also turn on **Insert at original position** so the embed link lands at the cursor position where recording started, even if you navigate to another note while recording.

Configure all of this under **Settings > Advanced Audio Recorder > File storage** - see [File storage](settings-reference.md#file-storage) for every field.

---

## Quick configuration checklist

Run through these once to tailor the plugin to your setup. Every item links to the full reference.

1. **Pick your input device.** **Settings > Advanced Audio Recorder > Audio input > Input device**. The dropdown lists every detected microphone and refreshes automatically when you plug or unplug one. See [Audio input](settings-reference.md#audio-input).
2. **Choose a recording format.** **Settings > Advanced Audio Recorder > Output format > Recording format** (default **WebM**). Offline formats are labelled `(offline)`. See [Formats](formats.md) for which to pick.
3. **Set the save folder.** **Settings > Advanced Audio Recorder > File storage** - set **Save folder**, or turn on **Save recordings near active file**. See [File storage](settings-reference.md#file-storage).
4. **(Optional) Enable the enhanced player.** **Settings > Advanced Audio Recorder > Audio player > Enhanced audio player**. See [Audio player](audio-player.md).
5. **(Optional) Enable transcription.** **Settings > Advanced Audio Recorder > Transcription > Enable transcription**, then pick an engine and add an API key (or set up local whisper.cpp). See [Transcription](transcription.md) and the [use-case guides](use-cases/index.md).
6. **(Optional) Verify your setup.** **Settings > Advanced Audio Recorder > Diagnostics > Test recording** records a five-second clip and plays it back without saving anything.

The settings tab opens with a **documentation callout** at the very top - a quick link to these guides, so you never have to hunt through the repository.

---

## Next steps

You are ready to record. From here:

- [Features](features.md) - a tour of everything the plugin can do.
- [Mobile support](mobile-support.md) - what works on iOS and Android, and what stays desktop-only.
- [Recording](recording.md) - pause/resume, markers, automatic splitting, save progress, and crash recovery.
- [Multi-track recording](multi-track-recording.md) - capture several input devices at once.
- [Formats](formats.md) - the eight output formats and when to use each.
- [Audio player](audio-player.md) - the enhanced player, markers and chapters, and timecode links.
- [Audio cleanup](audio-cleanup.md) - remove noise and even out loudness on an existing file.
- [Transcription](transcription.md) - turn recordings into text with Whisper, Deepgram, Gemini, or local whisper.cpp.
- [LLM post-processing](llm-post-processing.md) - clean up or summarize a transcript with an LLM.
- [Settings reference](settings-reference.md) - every setting, default, and range in one place.
- [Troubleshooting](troubleshooting.md) - fixes for the most common problems.

Back to the [documentation home](index.md).
