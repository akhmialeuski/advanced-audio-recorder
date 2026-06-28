# Advanced Audio Recorder for Obsidian

Advanced Audio Recorder lets you record, play, clean up, and transcribe audio directly inside [Obsidian](https://obsidian.md).

Use it for voice notes, meetings, interviews, lectures, and dictation. [Record](docs/recording.md) audio with one click, play it back in an [enhanced waveform player](docs/audio-player.md), add bookmarks and chapters, [split](docs/splitting.md) or [convert](docs/formats.md) files, and [clean up](docs/audio-cleanup.md) noisy recordings when needed.

The plugin also includes [built-in transcription](docs/transcription.md). You can transcribe recordings or existing audio files in your vault using the OpenAI-compatible Whisper API (OpenAI, Groq, and other hosts), Deepgram, Google Gemini, or a local offline whisper.cpp model. Transcripts can include speaker labels, clickable timestamps, and an optional [AI summary](docs/llm-post-processing.md) saved next to your note.

All audio and generated files stay in your vault. API keys are stored locally and are never sent anywhere except to the transcription provider you choose.

Desktop only. Requires Obsidian 1.6.6 or newer. MIT licensed.

The full documentation lives in the [docs](docs/index.md) folder, and the same link is built into the plugin's settings tab.

![The enhanced audio player showing the waveform, playback controls, and a list of bookmarks and chapters.](docs/images/player-overview.png)

## Features

- Recording: one-click capture with pause, resume, live status feedback, automatic splitting of long sessions, and crash recovery.
- Multi-track recording: capture up to eight input devices at once for multi-microphone interviews.
- Enhanced audio player: inline waveform with adjustable speed, skip, loop, volume, per-recording bookmarks, chapters, and clickable timestamp links.
- Transcription: OpenAI-compatible Whisper API, Deepgram, Google Gemini, or fully offline whisper.cpp, with speaker diarization and JSON, SRT, WebVTT, or plain-text output.
- LLM post-processing: optionally clean up or summarize any transcript with OpenAI, Anthropic, or Gemini.
- Audio cleanup: high-pass filter, noise gate, and loudness leveling, written to a fresh copy.
- Formats and file operations: convert between WAV, WebM, OGG, MP3, MP4, M4A, AAC, and FLAC, and split long files from the right-click menu.

Recording is fast and forgiving. Start and stop from the ribbon or a command, follow live feedback in the status bar, and pause or resume without losing anything. Capture up to eight input devices at once for multi-microphone interviews, let long sessions split into fixed-length parts automatically, and recover the audio on the next launch if Obsidian closes mid-recording. See [Recording](docs/recording.md) and [Multi-track recording](docs/multi-track-recording.md).

![The recording status bar showing the Recording label, control buttons, elapsed time, file size, and input level meter.](docs/images/status-bar-recording.png)

The enhanced player turns playback into a first-class part of your notes. Recordings embed as a player with a clickable waveform, adjustable speed, skip, loop, and volume. Add per-recording bookmarks and chapters, move between them, and copy timestamp links that jump straight to a moment in the audio. See the [enhanced audio player](docs/audio-player.md).

Transcription turns any recording, or any audio file already in your vault, into text with the engine that fits your needs: the OpenAI-compatible Whisper API (Groq and other compatible hosts included), Deepgram, Google Gemini, or a fully offline `whisper.cpp` model that never touches the network. Deepgram and Gemini add automatic speaker diarization, so meetings and interviews come back labelled by speaker. You decide where the transcript goes and in which format (JSON, SRT, WebVTT, or plain text), with timestamps you can click to jump the player to the right moment. An optional pass through an LLM (OpenAI, Anthropic, or Gemini) cleans up the wording or condenses the transcript into key points and action items. See [Transcription](docs/transcription.md) and [LLM post-processing](docs/llm-post-processing.md).

![The Transcribe audio dialog with per-run controls for engine, language, speaker diarization, destination, and LLM post-processing.](docs/images/transcription-dialog.png)

Everything else keeps your audio tidy. Convert recordings between WAV, WebM, OGG, MP3, MP4, M4A, AAC, and FLAC, and split long files into parts straight from the right-click menu; the formats you can record in are the subset your platform supports. Clean up noisy audio on demand with a high-pass filter, noise gate, and loudness leveling, always written to a fresh copy so the original is left untouched. See [Formats](docs/formats.md), [File operations](docs/file-operations.md), and [Audio cleanup](docs/audio-cleanup.md).

## Installation

1. In Obsidian, open Settings, go to Community plugins, and turn off Restricted mode if it is on.
2. Click Browse, then search for "Advanced Audio Recorder".
3. Click Install, then Enable.

## Quick start

1. Click the microphone icon in the left ribbon, or run "Start/stop recording" from the command palette.
2. Speak, then click again to stop.
3. The recording is saved to your vault and embedded in the active note.

No default hotkeys are assigned. Set your own in Settings, under Hotkeys.

## Support

If this plugin saves you time, consider supporting its development: [Buy Me A Coffee](https://coff.ee/akhmelevskiy).

## Troubleshooting and bug reports

If something is not working, start with the [troubleshooting guide](docs/troubleshooting.md). When you report a problem, follow the [bug reporting guide](docs/BUG_REPORTING_GUIDE.md) and open an issue on [GitHub](https://github.com/akhmialeuski/advanced-audio-recorder/issues).

## License

Released under the [MIT License](LICENSE).

<!-- Keywords for search: obsidian audio recorder, obsidian voice recorder, obsidian dictation, record audio in obsidian, microphone recorder, multi-track recording, meeting recorder, interview recorder, lecture recorder, audio converter, wav mp3 flac ogg webm m4a aac, waveform audio player, audio bookmarks and chapters, speech to text, transcription, Whisper, OpenAI, Groq, Deepgram, Google Gemini, whisper.cpp offline transcription, speaker diarization, transcript SRT VTT, LLM summary, voice memo plugin. -->
