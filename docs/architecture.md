# Architecture

This document is a technical map of how **Advanced Audio Recorder** is put together: how the plugin loads, how a recording flows from microphone to file, how transcription and the enhanced player work, and how crash recovery and settings backup keep your data safe. It is written for contributors and curious power users. If you only want to _use_ the plugin, start with [Getting started](getting-started.md) and the [Features overview](features.md); come back here when you want to know _why_ something behaves the way it does, or where in the source a behavior lives.

Everything below is verified against the plugin source under `src/`. The plugin runs on **desktop and mobile** (it requires Obsidian `1.6.6+`). Platform differences are decided in one low-level policy layer, `src/platform/` (`platformKind.ts` detects the platform; `capabilities.ts` answers "is this feature available here?" and "which limit applies here?"). Feature code and the settings UI branch on named capabilities - multi-track capture, device selection, auto-split, PCM WAV capture, recovery journaling, local transcription, memory ceilings - never on the platform itself. Device-bound settings (input device ids, channel layouts) are stored per platform under a `perPlatform` branch in `data.json`, so a vault synced between a desktop and a phone never mixes their hardware configuration.

- [System overview](#system-overview)
- [Plugin lifecycle](#plugin-lifecycle)
- [Recording pipeline](#recording-pipeline)
- [Transcription pipeline](#transcription-pipeline)
- [Enhanced player takeover](#enhanced-player-takeover)
- [Crash recovery](#crash-recovery)
- [Settings load and backup](#settings-load-and-backup)
- [Settings tab rendering](#settings-tab-rendering)
- [Module map](#module-map)

---

## System overview

The plugin entry point (`src/main.ts`) constructs a small set of long-lived managers and registers them with the Obsidian host. Each subsystem owns one concern: recording, playback, transcription, on-demand cleanup, settings, and the shared UI surfaces (status bar, ribbon, modals, context menu).

```mermaid
flowchart TB
    subgraph Host["Obsidian host"]
        WS[Workspace and embeds]
        VAULT[Vault file system]
        CMD[Command palette / Hotkeys]
    end

    subgraph Entry["Plugin entry (main.ts)"]
        PLUGIN[AudioRecorderPlugin]
    end

    subgraph Rec["Recording subsystem"]
        RM[RecordingManager]
        FIN[RecordingFinalizer]
        ROT[PartRotationController]
        JRN[SessionJournal]
        REC[RecoveryService]
    end

    subgraph Play["Player subsystem"]
        REG[EnhancedPlayerRegistrar]
        PLY[AudioPlayer]
        MKS[MediaKindStore]
    end

    subgraph Mark["Recording sidecar domain"]
        MRK[RecordingSidecarStore]
    end

    subgraph Act["Action registry"]
        ACT[File + recording actions]
    end

    subgraph Tr["Transcription subsystem"]
        TS[TranscriptionService]
        PROV[Providers]
        LLM[LLM post-process]
    end

    subgraph Clean["Cleanup subsystem"]
        CSVC[AudioProcessingService]
    end

    subgraph Set["Settings"]
        ST[SettingsTab + sections]
        DATA[data.json + data.json.bak]
    end

    subgraph UI["UI surfaces"]
        SB[Status bar]
        RIB[Ribbon icon]
        BAN[Recording banner]
        CTX[Context menu]
        MOD[Modals]
    end

    CMD --> ACT
    PLUGIN --> RM
    PLUGIN --> REG
    PLUGIN --> ST
    PLUGIN --> CTX
    PLUGIN --> SB
    PLUGIN --> RIB
    PLUGIN --> BAN

    RM --> FIN
    RM --> ROT
    RM --> JRN
    RM --> MRK
    JRN --> REC
    RM --> VAULT

    REG --> PLY
    REG --> MKS
    PLY --> MRK
    REG --> WS

    CTX --> ACT
    ACT --> TS
    ACT --> CSVC
    TS --> PROV
    TS --> LLM
    TS --> VAULT

    ST --> DATA
```

What to notice:

- **The plugin object is a thin coordinator.** `main.ts` builds the managers, wires their callbacks, and forwards UI events to them. The real work lives in the subsystem classes.
- **One `RecordingSidecarStore` is shared** by the recording subsystem (which writes markers captured during a session), the player subsystem (which reads and edits them), auto chapters, and the transcription feature (which stores the speaker roster, the recording's participant names, and the written outputs in the same sidecar document), so their cache and serialized write chain stay unified. The marker data model is a standalone domain (`src/markers/`), owned by neither subsystem; the sidecar persistence lives in `src/sidecar/`.
- **File actions are defined once, in a shared action registry** (`src/actions/`). The same declarative list - info, convert, split, clean up, transcribe, delete - is rendered into the file and editor context menus and registered as palette commands, so every action can also be assigned a hotkey. See [File operations](file-operations.md).
- **Settings persist to `data.json`** with an automatic `data.json.bak` next to it, described in [Settings load and backup](#settings-load-and-backup).

---

## Plugin lifecycle

`onload()` runs once when the plugin is enabled. It loads settings (with backup restore), builds the managers, registers commands and UI, and schedules the crash-recovery check for after the workspace is ready so plugin load is never delayed. `onunload()` tears everything down cleanly.

```mermaid
flowchart TD
    START([onload]) --> LS[loadSettings: read data.json,<br/>restore from backup, write backup]
    LS --> EW[Create encoding Web Worker client]
    EW --> JR[Create SessionJournal + RecordingSidecarStore]
    JR --> MGR[Build RecordingManager + RecordingBanner]
    MGR --> TAB[Add settings tab]
    TAB --> CMDS[Register commands]
    CMDS --> RIB[Add ribbon microphone icon]
    RIB --> SBAR[Set up status bar + live-stats interval]
    SBAR --> CTX[Register context menu]
    CTX --> PLR[Build + register EnhancedPlayerRegistrar]
    PLR --> READY[workspace.onLayoutReady]
    READY --> RECCHK[checkForInterruptedSessions:<br/>recovery modal if any]

    UNLOAD([onunload]) --> C1[RecordingManager.cleanup]
    C1 --> C2[Hide recording banner]
    C2 --> C3[EnhancedPlayerRegistrar.dispose:<br/>restore native embeds]
    C3 --> C4[Terminate encoding worker]
    C4 --> C5[Reset status bar + ribbon]
```

Notes on the lifecycle:

- **Settings load first**, because every manager constructed afterward receives a live `settings` reference. The load path can restore from `data.json.bak` and even block saving when the stored file is unreadable (see [Settings load and backup](#settings-load-and-backup)).
- **Streaming conversions are offloaded to a Web Worker** when the build injected its source; if that source is unavailable, everything falls back to the main thread.
- **Commands come from two places.** Four session commands are registered directly (`Start/stop recording`, `Pause/resume recording`, `Add marker/chapter at current position` - gated on markers being enabled and a session being active - and `Select audio input device`), and the shared action registry adds the rest: `Add bookmark at current recording position` and `Add chapter at current recording position` (same recording gate), plus one command per file action (`Audio file info`, `Convert audio format`, `Split audio into parts`, `Clean up audio`, `Transcribe audio`, `Delete recording`), each gated on the active file being audio. No default hotkeys are assigned - see [Recording](recording.md) and [Settings reference](settings-reference.md).
- **Recovery runs after layout is ready**, never during load, and a failure there is caught and logged so it can never break the plugin.
- **Unload restores Obsidian's native embeds first** (so disabling the plugin never leaves overridden media embeds behind), then flushes recording buffers best-effort. The crash-recovery journal is deliberately _not_ ended on unload - an unload mid-recording is exactly the case the next launch should offer to recover.

---

## Recording pipeline

A recording is driven by `RecordingManager`. When you start, it snapshots the session-scoped settings (format, mode, bitrate, auto-split config), acquires the input streams, and chooses one of two capture paths. When you stop, it drains buffers, finalizes the files, writes them, inserts the embed links, and fires the optional transcribe-on-save hook.

```mermaid
sequenceDiagram
    actor User
    participant RM as RecordingManager
    participant Stream as AudioStreamHandler
    participant Cap as Capture path
    participant WQ as TrackWriteQueue
    participant Fin as RecordingFinalizer
    participant Vault as Vault
    participant Hook as onRecordingSaved

    User->>RM: Start/stop recording
    RM->>RM: snapshot session settings
    RM->>Stream: getAudioStreams(settings)
    Stream-->>RM: streams + track order
    RM->>Cap: init capture

    alt WAV on desktop
        Cap->>Cap: PcmStreamRecorder (raw PCM)
    else MediaRecorder formats
        Cap->>Cap: MediaRecorder chunks (timeslice)
    end

    loop While recording
        Cap-->>WQ: buffer + flush .tmp segments
        Cap->>RM: maybe rotate auto-split part
    end

    User->>RM: Start/stop recording (stop)
    RM->>Cap: stop recorders
    RM->>WQ: drain buffers
    RM->>Fin: saveRecording
    alt Offline format
        Fin->>Fin: re-encode (copy packets if codec matches)
    end
    Fin->>Vault: write final file(s)
    Fin-->>RM: save result (paths + note)
    RM->>Vault: insert embed link(s)
    RM->>Hook: onRecordingSaved (transcribe-on-save?)
```

Key decisions in this pipeline:

- **Two capture paths.** WAV on desktop uses a `PcmStreamRecorder` that captures raw PCM directly and assembles a WAV on save - this streams to disk and handles long recordings reliably. Every other format (and WAV on mobile) uses a `MediaRecorder` started with a chunk timeslice, delivering compressed chunks. Format details and the online-vs-offline distinction are in [Formats](formats.md).
- **Buffering and flushing.** The `TrackWriteQueue` serializes per-track writes; chunks accumulate to a flush threshold and are written to `.tmp` segment files. These segments are what the crash-recovery journal tracks.
- **Auto-split rotation.** When auto-split is on (desktop, and not for a merged multi-track session), `PartRotationController` finalizes a part at each boundary while recording continues. WAV parts are split sample-exactly; compressed formats restart the recorder per boundary. See [Splitting](splitting.md).
- **Finalization.** `RecordingFinalizer` produces the final files and reports the save-progress stages you see in the status bar (`Saving > Flushing buffers > Assembling audio > Writing file > Cleaning up > Saved`). Offline formats are re-encoded here; packets are copied without re-encoding when the codec already matches.
- **Multi-track output.** In `Single file` mode the tracks are mixed into one file; in `Multiple files` mode each track is saved separately, with the source/device name (and the track number appended to disambiguate when tracks share a device). See [Multi-track recording](multi-track-recording.md).
- **Transcribe-on-save.** When `Transcribe after recording` is enabled, the hook transcribes only the first saved file - a multi-track session records the same audio per track, and an auto-split session would otherwise fire one request per part. See [Transcription](transcription.md) and [Transcribe after recording](use-cases/transcribe-after-recording.md).

---

## Transcription pipeline

`TranscriptionService` (in `src/transcription/`) reads the audio, prepares provider-ready payloads, transcribes each through the configured provider, stitches the results onto one timeline, optionally post-processes with an LLM, and renders the output. `runTranscription.ts` is the high-level entry point that then writes the configured destinations.

```mermaid
flowchart TD
    READ[Read audio bytes] --> PREP{Provider accepts<br/>container and fits limit?}

    PREP -->|Yes| WHOLE[Send original container untouched]
    PREP -->|No| DECODE[Decode to 16 kHz mono WAV]
    DECODE --> CHUNK[Split into upload-sized / time-bounded parts]

    WHOLE --> PROVIDER{Engine}
    CHUNK --> PROVIDER

    PROVIDER -->|Whisper API| W[Chunked uploads<br/>25 MB per request]
    PROVIDER -->|Deepgram| D[Whole file up to 2 GB]
    PROVIDER -->|Gemini| G[Whole, or split at 15 min]
    PROVIDER -->|whisper.cpp| L[Local binary, offline]

    W --> STITCH[Stitch parts onto one timeline]
    D --> STITCH
    G --> STITCH
    L --> STITCH

    STITCH --> POST{LLM post-process?}
    POST -->|Yes| LLM[Clean up / Summarize / Custom]
    POST -->|No| FMT
    LLM --> FMT[Format: JSON / SRT / VTT / TXT]

    FMT --> DEST{Destination}
    DEST --> NOTE[Insert into note]
    DEST --> FILE[Save sidecar file]
    DEST --> BOTH[Note and file]
    DEST --> LINK[Save file + link in note]
```

How the stages map to behavior:

- **Preparation is lazy.** When a provider accepts the original container and the file fits the per-request limit, the bytes are sent untouched - no decode, so peak memory stays at the encoded file size. Only when the container is unsupported or the file is too large/long does the service decode to 16 kHz mono WAV and split it into upload-sized (or time-bounded) parts. Each part materializes its WAV bytes only just before upload, so a multi-chunk job never holds more than one chunk in memory.
- **Per-engine limits and behavior.** Whisper API has a hard 25 MB per-request limit (larger files are resampled and chunked, then stitched; no diarization). Deepgram sends up to 2 GB whole with consistent diarization. Gemini uploads up to 2 GB whole, decodes containers it does not accept, and splits recordings longer than 15 minutes into stitched parts (diarized splits reset speaker numbering, surfaced as a warning). Local whisper.cpp runs a local binary fully offline. See [Transcription](transcription.md#engines) and the engine setup guides under [Use cases](use-cases/index.md).
- **Stitching.** Successful per-part transcripts are merged onto the original timeline. A part that overruns a provider's output-token budget is subdivided and retried rather than discarded; a part that fails outright is recorded as missing, and the run keeps the good parts and warns instead of failing the whole job.
- **Diarization is one gate for the whole run.** The effective diarize flag decides both whether speaker labels are requested and whether any returned labels are stripped, so the request-time and output-time decisions can never diverge. Diarization is only available for Deepgram and Gemini. See [Speakers and diarization](transcription.md#speakers-and-diarization).
- **LLM post-processing is best-effort.** A failure falls back to the raw transcript rather than discarding completed (and possibly already-billed) work. See [LLM post-processing](llm-post-processing.md).
- **Output is rendered then written.** Markdown is built with optional clickable `#t=` timecode links, and `runTranscription.ts` writes the sidecar file and/or inserts into the note per the `Destination` setting. If in-note insertion is the only requested destination but it fails (note not open, reading mode), a sidecar file is written as a safety net so a completed transcript is never silently dropped.

---

## Enhanced player takeover

`EnhancedPlayerRegistrar` is the single decision point for whether an embedded audio file gets the enhanced `AudioPlayer` or Obsidian's native embed. It registers a custom embed creator in Obsidian's internal embed registry (with a Markdown post-processor as a Reading-view-only fallback), classifies each file by probing its actual content, and upgrades open views once a file proves audio-only. The `AudioPlayer` itself is a thin coordinator over focused collaborators: `SeekController` (seeking and timecode math), `WaveformController` (peak decode and cache), `PlayerMarkerController` (bookmark/chapter edits), `DurationProbe` (cheap metadata-only duration read), `MediaEmbedShell` (the embed DOM shell), and the `PlayerControlsView`, `WaveformCanvas`, and `MarkerListView` views.

```mermaid
flowchart TD
    EMBED[Obsidian renders an embed] --> ON{Enhanced player<br/>enabled?}
    ON -->|No| NATIVE[Return native embed]
    ON -->|Yes| KIND{Media kind<br/>already probed?}

    KIND -->|Audio-only| ENH[Build enhanced AudioPlayer]
    KIND -->|Video / undecodable| NATIVE
    KIND -->|Not probed yet| PROBE[Render native now<br/>+ probe content in background]

    PROBE --> RESULT{Probe result}
    RESULT -->|Audio-only| RERENDER[Re-render the embedding note<br/>to upgrade to enhanced]
    RESULT -->|Video / undecodable| KEEP[Keep native embed]
    RERENDER --> ENH

    ENH --> WAVE{Show waveform?}
    WAVE -->|Yes| PEAKS[Decode lazily, progressive,<br/>cached per file revision<br/>fallback to plain bar if huge]
    WAVE -->|No| BAR[Plain seekable bar, no decode]
    ENH --> SIDE[Load markers sidecar<br/>recording.ext.markers.json]
```

What this buys you:

- **Container classification, not extension.** The media kind is always determined by probing the actual content, cached per path, and persisted in the plugin folder (`MediaKindStore`), so an audio-only `.mp4` or `.webm` still gets the enhanced player, a file carrying a video track keeps Obsidian's native player, and the probe never repeats across sessions. See [Audio player](audio-player.md#audio-video-and-unsupported-files).
- **Both view modes stay correct.** Returning Obsidian's native embed unwrapped is what keeps Live Preview and Reading view consistent; the same re-render mechanism applies player setting changes immediately and identically in both modes.
- **Waveforms are cheap to scroll.** Peaks are computed once per file revision and cached, decoded lazily and progressively as the player scrolls into view, and fall back to a plain (still seekable) bar above a large safety size or when the file cannot be decoded. Turning off `Show waveform` skips decoding entirely.
- **Markers live in a sidecar.** Each recording's bookmarks and chapters are stored in a `recording.ext.markers.json` sidecar next to it; the registrar moves the sidecar on rename and removes it on delete so markers stay attached. Edits are allowed in Live Preview and read-only in Reading view. See [Markers and chapters](audio-player.md#markers-and-chapters).
- **Timecode links play from the offset in both view modes.** A document-level click handler intercepts `#t=` links that point to an audio file and plays from that offset instead of opening the file. It resolves the link the same in Reading view (a rendered `a.internal-link`) and Live Preview (read from the editor source, since CodeMirror renders the link without an attribute), seeks an on-screen embed in place when one exists, and otherwise plays the file's shared element through note-independent `DetachedPlayback` surfaced in the status bar.
- **The speaker preview is the one deliberate exception to the shared element.** `SpeakerPreviewPlayer` (used only by the rename dialog to play where a speaker first talks) owns its own element: a two-button excerpt must not hijack the embed of the same recording in the note behind the dialog, nor appear in the status-bar transport, which offers seek, skip, and markers. It still drives that element through the same `playbackCommands`, so seeking and stopping behave identically, and it is disposed with the dialog.
- **One audio element and one command set per file.** Every playback surface - the embedded `AudioPlayer`, the status-bar controls, and `DetachedPlayback` - operates on the single shared element the `AudioPlayerRegistry` keys per file, and every play, pause, stop, skip, mute, volume, and seek routes through `src/player/playbackCommands.ts`. Keeping one element and one command source is what stops the surfaces drifting out of sync (playback running while an embed still reads `0:00`). Because mocked unit tests hid exactly that drift, a change to any playback surface must add a real integration test that drives the actual `AudioPlayer` against a real registry, as in `tests/integration/PlaybackSync.test.ts`.

---

## Crash recovery

While a desktop recording is active, `SessionJournal` records its temporary `.tmp` segment files in `recording-journal.json` inside the plugin folder. If Obsidian crashes, loses power, or the plugin is unloaded mid-recording, the next launch collects the surviving sessions and offers a recovery choice through `RecoveryService` and a modal.

```mermaid
flowchart TD
    REC[Recording active] --> JRN[SessionJournal writes<br/>recording-journal.json:<br/>segments + parts per track]
    JRN --> CRASH[Crash / power loss /<br/>plugin unload mid-recording]
    CRASH --> LAUNCH[Next launch:<br/>onLayoutReady]
    LAUNCH --> COLLECT[collectRecoverableSessions:<br/>prune missing segments,<br/>delete corrupt journal,<br/>skip newer-version journal]
    COLLECT --> ANY{Any recoverable<br/>sessions?}
    ANY -->|No| NONE[Self-clear silently]
    ANY -->|Yes| MODAL[Recovery modal]

    MODAL --> RECOVER[Recover audio:<br/>reassemble segments, no re-encode]
    MODAL --> DISCARD[Discard:<br/>delete temp segments,<br/>keep finalized parts]
    MODAL --> LATER[Decide later:<br/>prompt again next launch]
```

Important details:

- **What can be recovered.** Everything already flushed to disk can be reassembled; in-memory audio still buffered below the flush threshold at the moment of the crash cannot. Recovery never transcodes - a raw reassembled container (or a WAV for PCM sessions) is the safest artifact a truncated stream can produce.
- **Pruning self-clears.** `collectRecoverableSessions` drops segments (and tracks, and sessions) whose files no longer exist and persists the pruned journal, so a crash before the first flush self-clears without ever prompting. A corrupt journal is deleted; a journal written by a newer plugin version is left untouched so a downgrade never destroys recovery data it cannot interpret.
- **MediaRecorder header rule.** A compressed track is only playable from its first segment (which carries the container header); if that segment was lost, the track is marked discard-only rather than producing an unplayable file.
- **Recover, Discard, Decide later.** Recover reassembles surviving segments and removes the consumed temp files. Discard deletes the temp segments but never touches finalized auto-split part files. Decide later leaves everything in place and the prompt returns next launch. See [Crash recovery](recording.md#crash-recovery) in the recording guide.

---

## Settings load and backup

Settings persist to `data.json` in the plugin folder, with a `data.json.bak` copy kept next to it. The load path in `main.ts` carefully distinguishes "no settings yet" (first install) from "settings exist but cannot be read" (a transient lock during a plugin update, a truncated file), and protects the stored file in the latter case.

```mermaid
flowchart TD
    LOAD([loadSettings]) --> READ[Read data.json]
    READ --> OK{Read succeeded?}
    OK -->|Yes| MERGE[Merge with defaults<br/>+ write backup]
    OK -->|No| EXISTS{data.json exists<br/>on disk?}

    EXISTS -->|No, no backup| DEFAULTS[First install:<br/>use defaults, saving enabled]
    EXISTS -->|No, backup present| RESTORE[Restore from backup,<br/>recreate data.json]
    EXISTS -->|Yes| RETRY[Wait + retry once]

    RETRY --> OK2{Read succeeded?}
    OK2 -->|Yes| MERGE
    OK2 -->|No| BLOCK[Use backup or defaults in memory,<br/>BLOCK saving, show notice,<br/>restart to recover]

    DEFAULTS --> DONE([Session ready])
    RESTORE --> DONE
    MERGE --> DONE
    BLOCK --> DONE
```

Why it works this way:

- **Missing vs. unreadable is decided by an explicit `exists()` check**, not by the `loadData()` return value, because some filesystems map a missing file to the same result as a failed read.
- **The backup is refreshed on every successful load and save.** When `data.json` goes missing but the backup is present, the settings are restored _and a new `data.json` is written immediately_ so the backup is never left as the only copy.
- **An unreadable `data.json` blocks saving.** The session continues on the backup (or defaults), saving is disabled so the possibly intact and possibly newer stored file is never overwritten with fallback values, and a notice tells you to restart. A protective `exists()` failure is treated as "file present" so a possibly intact file is never overwritten.
- **External changes reload.** `onExternalSettingsChange` (sync, manual edit) reloads settings so a stale in-memory copy does not overwrite the external change on the next save.

See [Settings reference](settings-reference.md) for every individual setting and its default.

---

## Settings tab rendering

Obsidian 1.13 replaced the settings contract this tab was built on. Before it, `display()` was the render call and the tab drew into its own container. From 1.13 on the framework renders a tab from the definitions returned by `getSettingDefinitions()`, does not call `display()` while that list is non-empty, and owns the DOM around every definition: after each pass it resets the group's list element to exactly the rows it tracks and the tab container to the group elements, so anything drawn beside a tracked row is discarded again, and a row the definition removed is put back.

The tab is described once, as data, in `settingsDefinitions.ts`. On 1.13 that tree _is_ the tab: the framework renders it, indexes every setting for the settings search by its name and its declared `aliases`, reads and writes the values, runs the validators, and re-evaluates the `visible` and `disabled` predicates after every change. The aliases matter twice over - they let a user find a row by the thing rather than by our word for it ("microphone" reaches the input device, "speech to text" reaches transcription), and they are the only way the fields inside a hand-rendered block are reachable at all, because the search indexes definitions and such a block is one definition. Below 1.13 none of that exists, so `legacySettingsRenderer.ts` walks the same tree with the `Setting` API that has always existed - a group becomes a heading and its rows, a control becomes the matching `add*` call, an action becomes a clickable row, a render definition is handed the same `Setting` and its cleanup is kept - and re-evaluates the predicates itself, the way `refreshDomState()` does. The official migration guide's dual-support path keeps two hand-written implementations side by side instead; for a tab with sixty-odd settings that is a drift generator, and the guide says as much.

Three shapes beyond the plain group carry the rest of the tab. The saved model ids and the two profile catalogues are `type: 'list'` collections: the framework draws the rows, the add affordance, and the empty state, and each one declares a `search`, which is Obsidian's own filter over that collection - typing narrows the list in place, and the tab contributes no filtering code of its own. Adding an entry to a list opens a dialog rather than growing a form in the tab, as the guide asks. Where an entry is a plain string the framework's own delete button ends it; where it is an entity with a page of its own, deleting belongs on that page, so the two profile catalogues declare no `onDelete` at all.

A profile is such an entity, and one mechanism serves every kind of them. The catalogue describes where a kind lives and what its body is called, and the same builder turns any catalogue into a list of pages, so the dictionary glossaries and the chapter guidance prompts differ in their copy and in nothing else. Each profile's page carries its body across the full row, a switch deciding whether the Transcribe dialog offers it, and the rename and delete actions; the control keys of those rows carry the profile's id, so a row on one profile's page cannot write to another's. The name is taken in a dialog rather than in a field on the page, because the framework addresses an open page by its name path: renaming under itself would leave the page unresolvable, so a rename applies and returns to the list, and deleting does the same.

Those collections are what makes `type: 'page'` worth using at every level. Transcription is a page, because forty-odd settings with a scope of their own belong behind one entry rather than inline on the main tab. Each collection is a page of its own inside it, because a vendor catalogue runs to thirty-odd model ids and a glossary to as many profiles, and inline that is thirty rows between the engine and everything configured after it. With Deepgram selected and six profiles of each kind, the transcription page carries 40 rows instead of 96. Four more sections went the same way for the same reason, since they are set once and then read past on the way to something else: audio splitting, the audio player, audio processing and feedback, and the audio cleanup defaults. What the main tab keeps inline is what a recording is configured with before every session.

Every page entry declares a `displayValue`, so what it holds is readable without opening it, and what that value says follows what the page is. A page with one master switch reports it, which is how transcription and the player read. A page with a value behind a switch reports the value, so audio splitting says how often a recording is cut rather than merely that it is. A page of independent switches has no single value and reports how many are on, counted from its own rows so a switch added later is counted without being registered twice. The cleanup defaults name their enabled stages instead, because a count would not say which two of the three the dialog would open with.

None of those three shapes exists below 1.13, so the legacy renderer builds each from what does. A page flattens into its groups, since a tab with no sub-pages has nowhere to send the user. A list keeps its rows and gains three of its own, because that Obsidian has no group header to hang them on: the filter, the empty-state note, and the add button. Those three are the only rows the stylesheet has to dress - a filter with no label beside it takes the whole row, an empty-state note reads muted so it is not mistaken for a setting whose control failed to render, and the add row drops the divider between itself and the list it closes. A declared text area is stacked under its name for the same reason: from 1.13 the framework does that itself, while the older stylesheets put every control in a narrow right-hand column that a multi-sentence prompt cannot use.

Six rows keep a render callback, because no control type covers them: the documentation callout, the recording format (whose options are blocked one by one by an asynchronous encoder probe), the output summary (derived from the format and bitrate rows rather than stored), the diagnostics test capture (which reports into its own row and owns a cleanup), and the two credential blocks - the transcription engine's and the LLM vendor's - whose fields are password inputs the declarative control set has no type for and whose identity changes with the selected engine. Those password fields still follow Obsidian rather than invent: the reveal button beside them is the eye toggle from the app's own keychain dialog, icon and all. Everything else is a control, an action, a group, a list, or the page.

Obsidian 1.13 does offer somewhere else to put a secret - `app.secretStorage`, encrypted through Electron's `safeStorage` and surfaced by `SecretComponent`. The tab does not use it. A secret there is stored per device and outside `data.json`, so adopting it would migrate every saved API key out of the plugin's own data and stop it syncing between a user's machines. That is a product decision about where credentials live, not a rendering one, and it is deliberately left for its own change.

Values do not take the framework's default write path. `PluginSettingTab.setControlValue()` writes `plugin.settings[key]` and calls `saveData(settings)`, which would flatten the `trackAudioSources` Map to `{}`, skip the per-platform write-back, and leave the recording manager and the player registrar holding stale settings. `AudioRecorderSettingTab` therefore overrides `getControlValue`/`setControlValue` and routes every write through `plugin.saveSettings()`; the legacy renderer binds its controls to the same pair, so a value reaches the plugin identically on both versions. Three things ride on those overrides: text-control writes are debounced (they fire per keystroke) and flushed in `hide()`; per-track audio sources are addressed through `track.<n>.<field>` keys because they live in a Map rather than in a property; and two platform-gated switches read their effective value rather than their stored one, so a feature synced on from a device that supports it reads as off where it cannot run without rewriting what is stored.

Almost nothing re-renders any more. A setting that reveals another is a `visible` predicate, and a setting an engine or a platform cannot honour is a `disabled` one, both evaluated in place. What is left re-renders because the tree itself changed rather than because a value did: the input device list (enumerated asynchronously, so the tab asks for a re-render when the list actually changes - compared by content, because a render enumerates again), a list that gained or lost an entry, and the recording format, which the output summary is derived from. On 1.13 a re-render is `SettingTab.update()`, the framework re-reading the same tree; below it, the legacy renderer rebuilding it.

The version split itself lives in `settingsRenderMode.ts` as two objects behind one interface, and `AudioRecorderSettingTab` picks one when it is constructed by probing for `SettingTab.update()`, the method 1.13 added alongside the definition-driven render. The declarative mode hands the framework the tree and re-renders by asking the framework to re-read it, while the imperative mode returns an empty definition list, which is what makes a 1.13 host fall back to `display()`, and re-renders through the legacy renderer, which releases the previous rows' cleanups before it rebuilds.

---

## Module map

The `src/` tree groups code by concern. The table below maps each area to its key directory and responsibility; file names are real and can be opened directly.

| Area              | Key directory under `src/`                                                                                                        | Responsibility                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point       | `main.ts`                                                                                                                         | Loads settings, builds managers, registers commands, ribbon, status bar, context menu, player, recovery                                                                                                                                                                          |
| Recording         | `recording/` (`RecordingManager`, `RecordingFinalizer`, `TestRecorder`)                                                           | Stream capture, PCM/MediaRecorder paths, write queue, auto-split rotation, finalization, the test recording                                                                                                                                                                      |
| Crash recovery    | `recording/` (`SessionJournal`, `RecoveryService`)                                                                                | Journals temp segments and offers recovery, discard, or decide-later on next launch                                                                                                                                                                                              |
| Audio encoding    | `audio/` (`AudioEncoder`, `AudioFormatConverter`, `formatRegistry`)                                                               | Format registry, capability detection, PCM/WAV encoding, conversion, and the Web Worker encoding offload                                                                                                                                                                         |
| Actions           | `actions/` (`fileActions`, `PluginAction`, `registerActionCommands`)                                                              | Single declarative list of file/recording actions, rendered into every menu and registered as commands                                                                                                                                                                           |
| Player            | `player/` (`EnhancedPlayerRegistrar`, `AudioPlayer`, controllers, views)                                                          | Embed takeover, container probing (persisted in `MediaKindStore`), waveform decode/cache, playback controls                                                                                                                                                                      |
| Markers           | `markers/` (`markerModel`, `markerFactory`)                                                                                       | Pure marker/chapter data model: ordering, navigation, (de)serialization                                                                                                                                                                                                          |
| Recording sidecar | `sidecar/` (`RecordingSidecarStore`, `recordingSidecarModel`)                                                                     | Persists the per-recording sidecar (markers + transcript roster/outputs/history); follows rename, move, and delete                                                                                                                                                               |
| Transcription     | `transcription/` (`TranscriptionService`, `api`)                                                                                  | Audio preparation, provider dispatch, cancellation, stitching, output formatting and destinations                                                                                                                                                                                |
| Providers         | `transcription/providers/`                                                                                                        | Whisper API, Deepgram, Gemini, and local whisper.cpp engine implementations                                                                                                                                                                                                      |
| LLM post-process  | `transcription/llm/`, `llmPostProcess.ts`                                                                                         | Clean up, summarize, or apply a custom instruction to a finished transcript                                                                                                                                                                                                      |
| Cleanup           | `cleanup/` (`AudioProcessingService`, `audioDsp`)                                                                                 | On-demand offline DSP: high-pass filter, noise gate, loudness leveling                                                                                                                                                                                                           |
| Settings          | `settings/` (`settingsSchema`, `settingsDefinitions`, `SettingsTab`, `legacySettingsRenderer`, `settingsRenderMode`, `sections/`) | Settings model and defaults (`settingsSchema`), serialization, validation, the tab described as definitions (`settingsDefinitions`), the pre-1.13 renderer for that same tree (`legacySettingsRenderer`), and the render path picked per Obsidian version (`settingsRenderMode`) |
| UI surfaces       | `ui/` (`StatusBar`, `RibbonIcon`, modals)                                                                                         | Status bar, ribbon icon, recording banner, context menu, and every modal dialog                                                                                                                                                                                                  |
| Diagnostics       | `diagnostics/` (`SystemDiagnostics`, `SystemInfoModal`)                                                                           | Environment, device, codec, and settings info collection and the read-only copyable JSON snapshot modal                                                                                                                                                                          |
| Obsidian glue     | `obsidian/` (`embedRegistry`)                                                                                                     | Thin wrappers over Obsidian's internal embed registry API                                                                                                                                                                                                                        |
| Utilities         | `utils/`                                                                                                                          | Time formatting, byte formatting, device helpers, link updating, debug logging                                                                                                                                                                                                   |
| Constants         | `constants.ts`                                                                                                                    | Format ids, limits, thresholds, defaults, and catalogue links used across the plugin                                                                                                                                                                                             |
| Errors            | `errors.ts`                                                                                                                       | Shared error classes (`AudioStreamError`, `SettingsValidationError`, `RecordingError`, `EncodingError`) thrown across recording, settings, and encoding                                                                                                                          |

For the user-facing tour of each capability, see the [Features overview](features.md); for the exact controls and defaults, see the [Settings reference](settings-reference.md). If you hit a bug, the [Troubleshooting](troubleshooting.md) guide and the [Bug reporting guide](BUG_REPORTING_GUIDE.md) explain how to collect diagnostics.
