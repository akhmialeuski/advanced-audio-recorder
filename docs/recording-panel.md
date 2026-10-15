# Recording panel

The recording panel is a sidebar tab that shows what the plugin knows about the recording in front of you and puts its actions one click away. It sits in the right sidebar next to Obsidian's own panes, such as **All properties**, **Outline** and **Backlinks**, under the plugin's microphone icon.

- [Opening the panel](#opening-the-panel)
- [What the panel follows](#what-the-panel-follows)
- [What it shows](#what-it-shows)
- [Buttons and actions](#buttons-and-actions)

---

## Opening the panel

The first time the plugin runs with the panel on a device, it adds the panel to the right sidebar without switching to it, so its microphone icon appears among the sidebar tabs. Click the icon to show the panel. Like any sidebar tab, it can be dragged to the left sidebar, into another tab group, or into the main area, and Obsidian keeps it there. Each device places it once on its own, because Obsidian keeps a separate layout per device.

If you close the panel, it is not added back on the next start of that device, so its icon disappears from the sidebar. To bring it back:

1. Open the command palette with `Ctrl+P` (`Cmd+P` on macOS).
2. Run **Open the recording panel**.

The command also shows the panel when it is already open in a sidebar that is collapsed or on another tab. See [The recording panel is gone](troubleshooting.md#the-recording-panel-is-gone) in Troubleshooting.

## What the panel follows

The panel follows the active file:

- **A recording opened on its own** shows that recording.
- **A note** shows the recordings it embeds or links to, which covers a meeting note with its recording embed and the transcript lines whose timecode links point into the recording. They are listed in the order the note mentions them, its properties first, which is the order the command palette and the [command line](command-line.md) use for the same note. When a note refers to more than one recording, a **Shown** dropdown picks the one to display.
- **Any other file**, or no file at all, shows a short hint and the panel's buttons.

The panel updates on its own when you open another file, when the links in the note change, and when the recording's stored data changes: a transcription that finishes, a speaker you rename, a recording you rename or delete.

## What it shows

The panel is laid out like Obsidian's own **Properties** block: each section has a heading, and each row an icon, a key and a value. Click a section's heading, or focus it and press Enter, to fold or unfold it. The panel remembers which sections are folded, across notes and across restarts.

![The recording panel in the right sidebar for a meeting note that embeds two recordings: one row of icons with the file actions on the left and the record, queue and settings buttons on the right, the dropdown that picks a recording, the Recording section with the file, duration, size, format, creation time and transcription, and the Participants section listing four people from the Platform team profile, two of them with the speaker label given to them](images/recording-panel.png)

| Section          | Rows                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recording**    | The file (click its name to open it), its duration, size, format and creation time, and a **Transcribed** row with the engine, the language and when, for a recording that was transcribed. |
| **Participants** | Each person on a row of their own, with the speaker label you gave their name, if any. The heading names the participants profile they came from. Shown only when someone is on record.     |

The duration is read from the file and shows `unknown` when the file cannot be read. The participants are the names stored with the recording, usually from a participants profile, followed by any name you gave only to a speaker. A speaker nobody named is not listed. When the recording's stored data (its `.markers.json` file) exists but cannot be read, the panel says so in place of the sections it cannot fill.

## Buttons and actions

All the panel's buttons are icons in one row at its top. Hover an icon to see its name.

The row opens with the same actions the file menu offers for the recording: **Audio file info**, **Convert audio format**, **Split audio into parts**, **Clean up audio**, **Transcribe audio**, **Rename speakers**, **Generate chapters from transcript** and the others, each shown under the same settings that gate it in the menu. **Delete recording** is not in that row, where it would sit one mis-click away from the action you meant. **Transcribe the parts that failed** is shown only when the last run actually lost parts. To delete a recording, use the file menu.

The panel's own buttons close the row. Obsidian shows no view header in a sidebar, so they sit in the panel itself:

- **Start recording** starts a recording and turns into **Stop recording** while one runs. While a stopped recording is being saved, it reads **Saving the recording** and is disabled until the save is done.
- **Show the transcription queue** opens the [transcription queue](transcription.md).
- **Open settings** opens the plugin's settings tab.
