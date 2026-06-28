# Advanced Audio Recorder - Documentation

**Advanced Audio Recorder** is a desktop-only [Obsidian](https://obsidian.md) plugin that turns your vault into a full-featured voice recorder, dictation tool, and meeting recorder. Record audio straight into a note, capture several microphones at once, save in any of eight formats, convert and split files, play recordings back in an enhanced waveform player with markers and chapters, clean up noisy audio on demand, and transcribe speech to text with four engines (OpenAI-compatible Whisper, Deepgram, Google Gemini, or a fully offline local whisper.cpp) - with optional LLM post-processing to clean up or summarize the transcript. It requires Obsidian **1.6.6 or newer**.

![The enhanced audio player embedded in a note, showing the waveform seek bar, transport controls, and a marker list](images/index-hero-player.png)
*Figure: A recording playing back in the enhanced waveform player with markers and chapters.*

- [What is Advanced Audio Recorder?](#what-is-advanced-audio-recorder)
- [Highlights](#highlights)
- [Documentation map](#documentation-map)
- [First steps](#first-steps)
- [Support](#support)

---

## What is Advanced Audio Recorder?

Advanced Audio Recorder records audio without leaving Obsidian and drops a playable embed link into your note. It is built for note-takers who want a fast voice recorder for dictation, a reliable meeting recorder for interviews and lectures, and a speech-to-text pipeline that keeps the audio and the transcript together in the vault.

What it does:

- **Records audio** from your microphone with live status-bar feedback, a ribbon microphone icon, and pause/resume.
- **Captures multiple tracks** from up to 8 input devices at once, mixed into one file or saved per device.
- **Saves in 8 formats** - WebM, OGG, WAV, MP3, FLAC, MP4, M4A, and AAC - with configurable bitrate.
- **Converts and splits** existing audio files from the right-click context menu.
- **Plays recordings back** in an enhanced waveform player with playback-speed control, skip buttons, volume, loop, timecode links, and per-file markers and chapters.
- **Cleans up audio on demand** - high-pass filter, noise gate, and loudness leveling - writing a processed copy and never touching the original.
- **Transcribes speech to text** with four engines: a Whisper API (OpenAI-compatible, e.g. Groq), Deepgram, Google Gemini, or a local whisper.cpp binary that runs fully offline.
- **Post-processes transcripts with an LLM** to clean up punctuation, summarize into key points and action items, or apply a custom instruction.
- **Ships diagnostics** - a test recording, a system-info report, and a debug mode - for troubleshooting devices, codecs, and the runtime environment.

It is **desktop only** and requires Obsidian **1.6.6+**. Search terms people use for this plugin include: voice recorder, dictation, meeting recorder, audio notes, speech-to-text, transcription, Whisper, Deepgram, and Gemini.

---

## Highlights

- **One-click recording** - start and stop from the ribbon microphone icon or the command palette, with a link inserted automatically. See [Recording](recording.md).
- **Multi-track capture** - record up to 8 devices at once, mixed or per-track. See [Multi-track recording](multi-track-recording.md).
- **Eight output formats** - pick the right balance of quality, size, and compatibility. See [Formats](formats.md).
- **Convert, split, and manage files** - transcode, divide into parts, and update note links from the context menu. See [File operations](file-operations.md) and [Splitting](splitting.md).
- **Enhanced waveform player** - waveform seek bar, speed presets, skip ±10s, volume, loop, timecode links, and per-file markers and chapters. See [Audio player](audio-player.md).
- **On-demand audio cleanup** - remove rumble and hiss and even out loudness with a single right-click. See [Audio cleanup](audio-cleanup.md).
- **Speech-to-text with four engines** - Whisper API, Deepgram, Gemini, or offline local whisper.cpp, with speaker diarization on Deepgram and Gemini. See [Transcription](transcription.md).
- **LLM post-processing** - clean up, summarize, or run a custom instruction over the transcript. See [LLM post-processing](llm-post-processing.md).
- **Crash recovery and settings backup** - interrupted recordings can be recovered, and settings are auto-restored from a backup. See [Recording](recording.md) and [Settings reference](settings-reference.md).
- **Built-in diagnostics** - a 5-second test recording, a full system-info report, and a verbose debug mode. See [Troubleshooting](troubleshooting.md).

---

## Documentation map

Everything in this documentation set, grouped by topic. Each page is self-contained but links to its siblings for depth.

### Get started

| Page                                  | What it covers                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| [Getting started](getting-started.md) | Install the plugin, make your first recording, and find your way around the UI. |
| [Features](features.md)               | A tour of every feature with pointers to the detailed page for each one.        |

### Recording

| Page                                              | What it covers                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Recording](recording.md)                         | The recording workflow: start, pause/resume, stop, save progress, crash recovery, and live feedback. |
| [Multi-track recording](multi-track-recording.md) | Capture up to 8 input devices at once, mixed into one file or saved per track.                       |
| [Formats](formats.md)                             | The 8 output formats, their codecs, online vs. offline encoding, and how to choose.                  |
| [Splitting](splitting.md)                         | Automatic split into fixed-duration parts while recording, and manual split of existing files.       |
| [File operations](file-operations.md)             | Context-menu actions: audio file info, format conversion, delete, and link updates.                  |

### Playback

| Page                            | What it covers                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Audio player](audio-player.md) | The enhanced waveform player: seek bar, transport controls, timecode links, markers, and chapters. |

### Cleanup

| Page                              | What it covers                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Audio cleanup](audio-cleanup.md) | On-demand DSP: high-pass filter, noise gate, and loudness leveling, with recommended settings. |

### Transcription

| Page                                          | What it covers                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Transcription](transcription.md)             | Speech-to-text with four engines, diarization, output destinations and formats, and the progress flow.  |
| [LLM post-processing](llm-post-processing.md) | Clean up, summarize, or run a custom instruction over the transcript with OpenAI, Anthropic, or Gemini. |
| [Use cases](use-cases/index.md)               | Step-by-step guides for API keys and end-to-end workflows (see Use cases below).                        |

### Reference

| Page                                          | What it covers                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Settings reference](settings-reference.md)   | Every setting in the Settings tab - order, controls, defaults, and ranges.                 |
| [Architecture](architecture.md)               | How the plugin is structured internally, for the curious and for contributors.             |
| [Troubleshooting](troubleshooting.md)         | Fixes for common problems: no sound, missing formats, slow saves, and conversion failures. |
| [Bug reporting guide](BUG_REPORTING_GUIDE.md) | How to collect diagnostics and file a useful bug report.                                   |

### Use cases

| Page                                                                  | What it covers                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Use cases index](use-cases/index.md)                                 | The full list of step-by-step guides.                                      |
| [OpenAI Whisper API key](use-cases/openai-whisper-api-key.md)         | Create an OpenAI API key and configure the Whisper API engine.             |
| [Groq Whisper setup](use-cases/groq-whisper-setup.md)                 | Use Groq's fast, OpenAI-compatible Whisper endpoint.                       |
| [Deepgram API key](use-cases/deepgram-api-key.md)                     | Sign up for Deepgram and enable diarization.                               |
| [Gemini API key](use-cases/gemini-api-key.md)                         | Get a Google AI Studio key for the Gemini engine.                          |
| [Anthropic API key](use-cases/anthropic-api-key.md)                   | Get a Claude key for LLM post-processing.                                  |
| [Local whisper.cpp](use-cases/local-whisper-cpp.md)                   | Run transcription fully offline with a local whisper.cpp binary and model. |
| [Transcribe after recording](use-cases/transcribe-after-recording.md) | Transcribe every recording automatically as soon as it stops.              |
| [Meeting notes workflow](use-cases/meeting-notes-workflow.md)         | Record a meeting, diarize speakers, and summarize into action items.       |

---

## First steps

A 30-second quick start. For the full walkthrough, see [Getting started](getting-started.md).

1. Install **Advanced Audio Recorder** from **Settings > Community plugins > Browse**, then enable it.
2. Click the **microphone icon** in the left ribbon, or run **Start/stop recording** from the command palette (`Ctrl/Cmd + P`).
3. Speak or play audio. The status bar shows `Recording...` with **Pause** and **Stop** buttons.
4. Click the ribbon icon (or run the command) again to stop and save.
5. An audio embed link - `![[recording-….webm]]` - is inserted into your active note. Click it to play it back in the [enhanced player](audio-player.md).

![The plugin's Settings tab with the documentation callout at the top and the Audio input section below it](images/index-settings-tab.png)
*Figure: The Settings tab, where every recording, playback, and transcription option lives.*

The plugin assigns **no default hotkeys** to avoid conflicts - assign your own under **Settings > Hotkeys**. For a complete map of every setting, see the [Settings reference](settings-reference.md).

---

## Support

This plugin is free and open source under the [MIT License](https://github.com/akhmialeuski/advanced-audio-recorder/blob/master/LICENSE).

- **Found a bug or have a feature request?** Open an issue on [GitHub Issues](https://github.com/akhmialeuski/advanced-audio-recorder/issues). The [Bug reporting guide](BUG_REPORTING_GUIDE.md) explains how to collect the diagnostics that make a report actionable.
- **Want to support development?** [Buy Me A Coffee](https://coff.ee/akhmelevskiy) - every coffee helps keep the plugin maintained.
