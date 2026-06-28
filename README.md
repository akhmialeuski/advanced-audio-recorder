# Advanced Audio Recorder for Obsidian

**Record, play, clean up, and transcribe audio — without leaving [Obsidian](https://obsidian.md).**

Advanced Audio Recorder turns your vault into an audio workspace: a configurable voice recorder, multi-track capture, an audio converter, a waveform player with bookmarks and chapters, on-demand noise cleanup, and built-in speech-to-text with optional AI summaries. Perfect for **voice notes, meetings, interviews, lectures, and dictation** — the audio, the player, and the transcript all live as plain files next to your notes.

**Desktop only** · Requires Obsidian **1.6.6+** · MIT licensed

> 📖 **[Read the documentation »](docs/index.md)**
> Every feature, every setting, and step-by-step setup guides for each transcription engine. The same link is built into the plugin's settings tab. This README is just the quick tour — all the details live in the docs.

![Advanced Audio Recorder in action](docs/pause-resume.png)

## Highlights

- 🎙️ **Recording** — one click to record; pause/resume; multi-track from up to 8 devices; automatic splitting of long sessions; crash recovery.
- 🎧 **Enhanced player** — clickable waveform, playback speed, skip, loop, volume; per-recording bookmarks and chapters; clickable timecode links.
- 🔁 **Formats & files** — 8 formats (WAV, WebM, OGG, MP3, MP4, M4A, AAC, FLAC); convert and split files straight from the right-click menu.
- 🧹 **Cleanup** — remove rumble and noise and even out loudness on demand, written to a fresh copy.
- 📝 **Transcription** — Whisper (OpenAI/Groq), Deepgram, Google Gemini, or fully offline `whisper.cpp`; speaker diarization; JSON / SRT / WebVTT / TXT output; optional LLM cleanup or summary.
- 🔒 **Private** — files stay in your vault, API keys stay on your device, and the offline engine never touches the network.

→ See the full feature tour in **[docs/features.md](docs/features.md)**.

## Documentation

The complete, detailed documentation lives in the **[`docs/`](docs/index.md)** folder — start at the **[documentation home](docs/index.md)** for a map of every guide.

- **New here?** → [Getting started](docs/getting-started.md)
- **Setting up transcription?** → [Transcription guide](docs/transcription.md), plus get-a-key walkthroughs for [OpenAI/Whisper](docs/use-cases/openai-whisper-api-key.md), [Groq](docs/use-cases/groq-whisper-setup.md), [Deepgram](docs/use-cases/deepgram-api-key.md), [Gemini](docs/use-cases/gemini-api-key.md), [Anthropic](docs/use-cases/anthropic-api-key.md), and [offline whisper.cpp](docs/use-cases/local-whisper-cpp.md)
- **Looking for a setting?** → [Settings reference](docs/settings-reference.md)
- **Something not working?** → [Troubleshooting](docs/troubleshooting.md)

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **“Advanced Audio Recorder”**, install it, and enable it. Manual installation and a full walkthrough are in the [getting started guide](docs/getting-started.md).

## Quick start

1. Click the **microphone** icon in the left ribbon (or run **Start/stop recording** from the command palette).
2. Speak, then click again to stop.
3. The recording is saved to your vault and embedded in the active note.

> No default hotkeys are assigned — set your own in **Settings → Hotkeys**.

## Support

If this plugin saves you time, consider supporting its development:

[☕ Buy Me A Coffee](https://coff.ee/akhmelevskiy)

## License

Released under the [MIT License](LICENSE).

---

<sub>Keywords: obsidian audio recorder, obsidian voice recorder, obsidian dictation, record audio in obsidian, microphone recorder, multi-track recording, meeting recorder, interview recorder, lecture recorder, audio converter, wav mp3 flac ogg webm m4a aac, waveform audio player, audio bookmarks and chapters, speech to text, transcription, Whisper, OpenAI, Groq, Deepgram, Google Gemini, whisper.cpp offline transcription, speaker diarization, transcript SRT VTT, LLM summary, voice memo plugin.</sub>
