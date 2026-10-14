# Recording panel

The recording panel is a sidebar tab that shows what the plugin knows about the recording in front of you and puts its actions one click away. It sits in the right sidebar next to Obsidian's own panes, such as **All properties**, **Outline** and **Backlinks**, under the plugin's microphone icon.

- [Opening the panel](#opening-the-panel)
- [What the panel follows](#what-the-panel-follows)
- [What it shows](#what-it-shows)
- [Actions and settings](#actions-and-settings)

---

## Opening the panel

The first time the plugin runs with the panel, it adds the panel to the right sidebar without switching to it, so its microphone icon appears among the sidebar tabs. Click the icon to show the panel. Like any sidebar tab, it can be dragged to the left sidebar, into another tab group, or into the main area, and Obsidian keeps it there.

If you close the panel, it is not added back on the next start. Run **Open the recording panel** from the command palette to bring it back. The command also shows the panel when it is already open in a sidebar that is collapsed or on another tab.

## What the panel follows

The panel follows the active file:

- **A recording opened on its own** shows that recording.
- **A note** shows the recordings it embeds or links to, which covers a meeting note with its recording embed and the transcript lines whose timecode links point into the recording. Embeds come first. When a note refers to more than one recording, a **Shown** dropdown picks the one to display.
- **Any other file**, or no file at all, shows a short hint and the settings.

The panel updates on its own when you open another file, when the links in the note change, and when the recording's stored data changes: a transcription that finishes, a speaker you rename, a chapter you add, a recording you rename or delete.

## What it shows

| Section          | Rows                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recording**    | The file (with a button that opens it), its duration, size, format and creation time. The duration is read from the file and shows `unknown` when the file cannot be read.                    |
| **Transcript**   | When it was transcribed, the engine model and language, the line template the transcript was written with, the notes and transcript files written for it, and how many parts failed, if any.  |
| **Participants** | The participants profile the names came from, the participant names, and each speaker label with the name you gave it. Shown only for a recording with participants or a diarized transcript. |
| **Markers**      | How many chapters and bookmarks the recording carries. Shown only when it has some.                                                                                                           |

The template is the one used for the note you are looking at when the transcript was written there, and otherwise the one of the latest write. A recording the plugin never transcribed reads **Not transcribed yet.**

## Actions and settings

The **Actions** section lists the same actions the file menu offers for the recording: **Audio file info**, **Convert audio format**, **Split audio into parts**, **Clean up audio**, **Transcribe audio**, **Rename speakers**, **Generate chapters from transcript** and the others, each shown under the same settings that gate it in the menu. **Delete recording** is left to the menus. The same list is in the panel's **More options** menu.

The panel's header has three buttons:

- **Start recording** starts a recording and turns into **Stop recording** while one runs.
- **Show the transcription queue** opens the [transcription queue](transcription.md).
- **Open settings** opens the plugin's settings tab.

The **Settings** section at the bottom offers two switches: **Transcribe after recording** (shown while transcription is on) and **Enhanced audio player**. They are the same settings as in the settings tab; see the [Settings reference](settings-reference.md).
