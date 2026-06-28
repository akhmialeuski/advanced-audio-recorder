# Enhanced audio player

The **Enhanced audio player** replaces Obsidian's built-in audio embed with a richer player wherever an audio file is embedded (`![[recording.webm]]`). It adds a waveform seek bar, playback-speed control, skip buttons, volume and mute, a loop toggle, a time display, per-file markers and chapters, and a copy-timestamp-link action. The takeover is opt-in, applies in both Reading view and Live Preview, and falls back cleanly to Obsidian's native embed for video files, undecodable files, or when the feature is off.

- [Enabling the player](#enabling-the-player)
- [How the takeover works](#how-the-takeover-works)
- [The controls](#the-controls)
  - [Waveform seek bar](#waveform-seek-bar)
  - [Playback speed](#playback-speed)
  - [Skip forward and back](#skip-forward-and-back)
  - [Volume and mute](#volume-and-mute)
  - [Loop](#loop)
  - [Time display](#time-display)
  - [Copy timestamp link](#copy-timestamp-link)
- [Markers and chapters](#markers-and-chapters)
- [Timecode links](#timecode-links)
- [Audio, video, and unsupported files](#audio-video-and-unsupported-files)
- [Related settings](#related-settings)

![Enhanced audio player embedded in a note with the waveform seek bar and control row](images/player-overview.png)
*Figure: the enhanced player rendered in place of an audio embed, with the waveform seek bar above the control row.*

## Enabling the player

The enhanced player is off by default. Turn it on under **Settings > Advanced Audio Recorder > Audio player > Enhanced audio player**.

1. Open **Settings > Advanced Audio Recorder**.
2. Scroll to the **Audio player** section.
3. Enable **Enhanced audio player**.
4. Two more options appear below it - **Show waveform** (on by default) and **Markers and chapters** (on by default).

![Audio player settings section with the Enhanced audio player, Show waveform, and Markers and chapters toggles](images/settings-audio-player.png)
*Figure: the Audio player settings section, with the master toggle and its two windows.*

The change applies to notes that are **rendered after** the change. Toggling the master switch flips what every embed is (native versus enhanced), so the plugin re-renders open notes to rebuild their embeds. Disabling **Enhanced audio player** restores Obsidian's built-in embed on the next render.

The two sub-toggles - **Show waveform** and **Markers and chapters** - apply **in place** to already-open players, so flipping either one updates the live player immediately without re-rendering the note or interrupting playback. See [Related settings](#related-settings).

---

## How the takeover works

The player integrates with Obsidian's own embed rendering rather than bolting on afterward:

- **Embed registry.** The plugin registers a custom embed creator in Obsidian's internal embed registry for its media extensions (`wav`, `webm`, `ogg`, `mp3`, `mp4`, `m4a`, `aac`, `flac`). Obsidian itself then builds the embed through the plugin in **both Reading view and Live Preview**, so the enhanced player is the embed rather than something layered over a native one.
- **Markdown post-processor fallback.** When the internal embed-registry API is unavailable, the plugin falls back to a Markdown post-processor that takes over embeds in **Reading view only**. A console warning notes when this fallback is in use.
- **Clean teardown.** Each player is a render child whose lifecycle - event listeners, the audio element, observers, and registry registration - is torn down automatically when the note re-renders or its leaf closes. If the enhanced render ever throws, the embed degrades to a plain native `audio` element so the note still opens and the audio still plays.

A single audio element is shared per file across view modes, so the same playback is controlled whether you are in Reading view or Live Preview, and switching modes does not stop and restart playback.

> **Desktop and mobile.** The enhanced player works wherever Obsidian renders audio embeds. Waveform extraction relies on the Web Audio API available in the app. (The recording features of the plugin are desktop-only; the player itself renders embeds on either platform.)

---

## The controls

Every control below is **fixed** - none of them is configurable. Only the master **Enhanced audio player** toggle and the two windows (**Show waveform**, **Markers and chapters**) can be changed in settings.

![Enhanced player control row showing play, skip back, skip forward, speed, mute, volume, loop, chapter navigation, time, and copy-link buttons](images/player-controls.png)
*Figure: the full control row of the enhanced player.*

### Waveform seek bar

The recording is drawn as a waveform that doubles as the seek bar.

- **Click or drag** anywhere on it to seek. A drag that leaves the bar still tracks, because the bar captures the pointer on press.
- **Keyboard.** Focus the seek bar and use the arrow keys to nudge the position by **5 seconds** per press (`ArrowRight`/`ArrowUp` forward, `ArrowLeft`/`ArrowDown` back). `Home` jumps to the start; `End` jumps to the end. The seek bar is exposed as a slider for screen readers.
- **Played portion.** The part you have already played uses the **theme accent color**, so progress is visible at a glance.
- **Caching.** Waveforms are computed once per file revision (keyed on the file path, modification time, and size) and cached, so scrolling a note with many players does not re-decode audio. Resizing the window or switching view modes redraws from the cache instead of decoding again.
- **Lazy and progressive decoding.** Decoding is deferred until the player scrolls near the viewport, so a long note with several recordings does not decode every embed up front. Peaks are then computed progressively in the background and the waveform fills in as they become ready, so even an hour-plus recording never blocks the interface.
- **Plain-bar fallback.** A file larger than the safety ceiling (**1 GB** on disk), or one the app cannot decode, falls back to a plain - but still seekable - progress bar instead of the waveform. The plain bar shows a filled track for the played portion and a thumb at the current position.
- **Disabling the waveform.** Turn off **Show waveform** in settings to always use the plain bar. No audio is decoded in that mode at all.

![Waveform seek bar with the played portion highlighted in the theme accent color and a position thumb](images/player-waveform-seek.png)
*Figure: the waveform seek bar, with the played portion in the theme accent and the current position marked.*

![Plain seekable progress bar shown when the waveform is disabled or the file is too large to decode](images/player-plain-bar.png)
*Figure: the plain (still seekable) bar shown when Show waveform is off or the file exceeds the decode ceiling.*

### Playback speed

Click the **speed** button to open a dropdown of presets and pick any one (the current rate is checked). The presets are `0.5×`, `0.75×`, `1×`, `1.25×`, `1.5×`, `1.75×`, `2×`, `2.5×`, and `3×`.

New players start at `1×`. The button always shows the current rate.

![Playback-speed dropdown menu listing the speed presets with the current rate checked](images/player-speed-menu.png)
*Figure: the playback-speed dropdown, opened from the speed button.*

### Skip forward and back

The **back** and **forward** buttons jump playback by **10 seconds** in each direction, clamped to the track bounds.

### Volume and mute

- A **volume slider** sets the level from 0 to 1. Dragging it above 0 while muted automatically unmutes.
- The **mute** button toggles mute and reflects the state with its icon.

### Loop

The **loop** button toggles whether the recording repeats when it reaches the end. Loop is **off** for a newly opened recording and stays on once you enable it for the shared audio element.

### Time display

The time readout shows **elapsed / total** time (for example `1:05 / 3:42`). Both sides are formatted against the total length so they line up. A file whose duration the browser does not report up front (common for MediaRecorder WebM, and some multitrack MP4 files) is probed automatically so the total fills in.

### Copy timestamp link

The **link** button copies a [timecode link](#timecode-links) to the **current position** - for example `[[recording#t=1:30]]` - to the clipboard, following your vault's link-format preferences. A notice confirms the copied timestamp. You can also copy a link at any other position from the [right-click menu](#markers-and-chapters).

---

## Markers and chapters

With **Markers and chapters** enabled, each recording can carry per-file **bookmarks** (jump points) and **chapters** (named segments). These are extra navigation aids stored alongside the recording; they do not change the audio.

![Enhanced player with a marker list below the controls and bookmark and chapter ticks on the seek bar](images/player-marker-list.png)
*Figure: the marker list under the player, with bookmark ticks and chapter boundaries on the seek bar.*

**Adding markers**

- **Add a bookmark** at the current position with the **bookmark** button, or by **double-clicking the waveform** at the spot you want.
- **Add a chapter** at the current position with the **chapter** button.
- Each new entry gets a default label and is added to the [marker list](#markers-and-chapters), where you can rename it. A notice confirms the addition with its timestamp.

**On the seek bar**

- **Bookmarks** appear as **ticks** on the seek bar.
- **Chapters** appear as **labelled boundary lines**.
- Clicking either one jumps playback to it (without forcing play/pause to change).

![Seek bar with bookmark ticks and labelled chapter boundary lines](images/player-seek-ticks.png)
*Figure: bookmark ticks and chapter boundaries rendered on the seek bar.*

**The marker list**

The list below the player shows every marker and chapter in time order. From it you can:

- **Jump** to an entry by clicking its time (or the whole row in Reading view).
- **Rename** an entry by editing its label inline (saved shortly after you stop typing).
- **Delete** an entry with its trash button.

The currently playing segment is highlighted as playback crosses chapter boundaries. The read-only list also shows each segment's length.

**Chapter navigation**

The **previous chapter** and **next chapter** buttons move between chapter boundaries. Previous-chapter from just after a boundary returns to the start of the current chapter.

**Right-click menu**

Right-click the player to add a **marker** or **chapter**, or copy a **timestamp link**, **at the clicked position** - alongside the usual audio file actions (info, convert, split, delete). Position-aware actions use the spot under the cursor. The **add marker** and **add chapter** items appear only when **Markers and chapters** is enabled and the note is open for editing (Live Preview); **copy timestamp link** is always available.

![Right-click context menu on the player offering add marker, add chapter, copy timestamp link, and file actions](images/player-context-menu.png)
*Figure: the right-click menu on the player, with position-aware marker, chapter, and timestamp actions.*

**Editing versus read-only**

Adding, renaming, and deleting markers is available while **editing** the note (Live Preview). In **Reading view** the markers and chapters are **read-only** - they are shown and remain clickable to jump, but cannot be edited. The player defaults to read-only and only enables edit controls once it confirms it is inside the editor, so Reading view never wrongly shows edit affordances.

**Storage and portability**

Markers are stored in a **sidecar file** next to each recording, named `<recording>.markers.json` (for example `recording.webm.markers.json`). Because the sidecar lives in your vault:

- Markers **survive a plugin reinstall**.
- They **travel with the vault**.
- Renaming, moving, or deleting the recording **moves or removes its sidecar automatically**, so markers stay attached and never orphan. Deleting all of a recording's markers removes the sidecar, so the vault is not left with empty files.

Markers can also be added **while recording**, before the file even exists as a player - see [Marking moments while recording](recording.md#marking-moments-while-recording). Those markers attach to the recording's sidecar at save and show up in the player once the recording stops.

---

## Timecode links

A link with a `#t=` offset jumps a rendered player to that position instead of opening the file. The offset accepts several formats:

| Format    | Example      | Meaning                |
| --------- | ------------ | ---------------------- |
| Seconds   | `#t=90`      | 90 seconds (1:30)      |
| `m:ss`    | `#t=1:30`    | 1 minute 30 seconds    |
| `h:mm:ss` | `#t=1:02:03` | 1 hour 2 min 3 seconds |

When a matching player is already visible in the note, **clicking the link seeks it** and starts playback. When no live player for that file is on screen, the link **behaves normally** (Obsidian opens the file as usual). A single embed with a `#t=` offset displays that start position until you engage playback, without dragging other embeds of the same file.

![Note showing a transcript line as a clickable timecode link that seeks the player above it](images/player-timecode-link.png)
*Figure: a timecode link in a note seeking the player to the linked position.*

Timecode links are also how transcripts become clickable: when **Timestamps as player links** is on, each transcript timestamp is rendered as a `#t=` link that seeks the player to that moment - click a line to hear it. See [Transcription > output formatting](transcription.md#output-where-the-transcript-goes) for how those links are generated, and [Copy timestamp link](#copy-timestamp-link) above to create one by hand.

---

## Audio, video, and unsupported files

The enhanced player takes over **audio-only** files. Other media is left to Obsidian's built-in player:

- **Audio-only files** get the enhanced player.
- **Files that carry a video track** (for example a `.mp4` or `.webm` with video) keep Obsidian's built-in player, so the video can be watched.
- **Files the app cannot decode** fall back to the built-in embed as well.

Crucially, the media kind is classified from the file's **container metadata, not its extension**. Each file is probed once and cached. This means an **audio-only `.mp4` or `.webm`** recording still gets the enhanced player, even though those containers can also hold video. A file that has not been probed yet renders natively for a moment and is then upgraded to the enhanced player in place once the probe confirms it is audio-only.

The waveform is drawn for supported audio files up to the **1 GB** decode ceiling; a larger or undecodable file falls back to the plain (still seekable) bar, as described under [Waveform seek bar](#waveform-seek-bar).

---

## Related settings

All three controls live under **Settings > Advanced Audio Recorder > Audio player**. The player's other controls (speed, skip, volume, mute, loop, time display, copy-timestamp link) are fixed and are not listed here because there is nothing to configure.

| Setting                   | Description                                                                                                                                                | Default |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Enhanced audio player** | Replace the built-in audio embed with the enhanced player. Enabling it reveals the two options below. Applies to notes rendered after the change.          | Off     |
| **Show waveform**         | Draw a waveform behind the seek bar. When off, a plain (still seekable) progress bar is shown and no audio is decoded. Applies in place to open players.   | On      |
| **Markers and chapters**  | Show the markers and chapters list and the add/jump/rename/delete and chapter-navigation controls. Markers are stored in a sidecar next to each recording. | On      |

For the full settings tour, see the [Settings reference](settings-reference.md#audio-player). For the player's role in the wider feature set, see [Features](features.md). For markers added during capture, see [Recording](recording.md). For clickable transcript timestamps, see [Transcription](transcription.md).
