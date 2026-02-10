# Obsidian Advanced Audio Recorder

An audio recording plugin for Obsidian with configurable save location, input device selection, pause/resume control, and optional multi-track capture.

## Features

- **Configurable Save Folder**: Choose where recordings are stored in your vault.
- **Audio Input Selection**: Pick the microphone/input device from command palette or settings.
- **Pause and Resume**: Pause and continue the same active recording session.
- **Multi-Track Recording**: Record several input devices at once and export as a single or multiple files.
- **Format and Bitrate Settings**: Choose output format and bitrate from plugin settings.

## Known Limitations

At the moment there are no known functional limitations that require user workarounds.

- Long recording sessions are supported.
- Selected output format is respected.
- Multi-track recording and track assignment are stable in normal usage.

If you hit an edge case, please open an issue with reproduction steps.

## Installation

1. Open **Obsidian Settings**.
2. Navigate to **Community Plugins** and disable **Safe Mode**.
3. Click **Browse** and search for **"Obsidian Advanced Audio Recorder"**.
4. Click **Install**.
5. Once installed, **Enable** the plugin.

## Usage

1. Click the microphone icon in the left ribbon or run **Start/stop recording** from the Command Palette.
2. Configure **Save folder**, **Input device**, and recording options in plugin settings.
3. Start recording.
4. Optionally run **Pause/resume recording**.
5. Stop recording to save files and insert links into the active note.

## Commands

- **Start/stop recording** — starts a new recording or stops the current one.
- **Pause/resume recording** — pauses an active recording and resumes it.
- **Select audio input device** — opens a quick picker and saves the selected device.

## Formats and Containers

- The plugin exposes supported formats based on your platform/browser MediaRecorder support.
- Commonly available options include: `webm`, `ogg`, `mp3`, `m4a`, `mp4`, and `wav`.
- When **WAV** is selected, recording is captured through a supported compressed recorder format and converted to WAV on save.
- In multi-track mode:
  - **Single file** output combines tracks into one file.
  - **Multiple files** output saves one file per track.

## Configuration

Visit the plugin settings to:
- Select recording format, bitrate, and sample rate.
- Select default input device.
- Set save folder and file prefix.
- Configure multi-track recording (track count, output mode, per-track devices).
- Enable debug logs when troubleshooting.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you find this plugin useful, consider supporting its development!

[Buy Me A Coffee](https://coff.ee/akhmelevskiy)
