# Transcription (speech-to-text)

**Advanced Audio Recorder** can turn any recording - or any existing audio file in your vault - into searchable text. Transcription is **off by default**: enable it under **Settings > Advanced Audio Recorder > Transcription**, choose an engine, supply its credentials, and then run it on a file from the context menu, a command, or automatically right after recording. The transcript can be inserted into a note, saved as a sidecar file, or both, with fully configurable in-note formatting and optional [LLM post-processing](llm-post-processing.md) on top.

- [Enabling transcription](#enabling-transcription)
- [Three ways to run it](#three-ways-to-run-it)
- [Engines](#engines)
    - [Whisper API (OpenAI-compatible)](#whisper-api-openai-compatible)
    - [Deepgram](#deepgram)
    - [Google Gemini](#google-gemini)
    - [Local whisper.cpp (desktop)](#local-whispercpp-desktop)
- [Model picker and language](#model-picker-and-language)
- [Speakers and diarization](#speakers-and-diarization)
    - [Naming speakers](#naming-speakers)
- [Biasing recognition toward your own terms](#biasing-recognition-toward-your-own-terms)
- [Output: where the transcript goes](#output-where-the-transcript-goes)
- [In-note formatting](#in-note-formatting)
- [The Transcribe dialog (per-run overrides)](#the-transcribe-dialog-per-run-overrides)
- [Progress and minimizing](#progress-and-minimizing)
- [Cost estimates](#cost-estimates)
- [LLM post-processing](#llm-post-processing)
- [Auto chapters](#auto-chapters)
- [Security and storage](#security-and-storage)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)

---

## Enabling transcription

Open **Settings > Advanced Audio Recorder > Transcription** and turn on **Enable transcription**. The rest of the section appears only while it is on. From top to bottom you then configure:

1. **Transcribe after recording** - auto-transcribe each saved recording (off by default).
2. **Transcription engine** - the row naming the service that transcribes, with the **Engines** entry under it opening the page where that service is configured: base URL, API key, and model.
3. **Language** - `auto` to detect, or an ISO code.
4. **Speaker diarization** - request speaker labels (only some engines).
5. **Translate speech to English** - write the recording down in English whatever was spoken, using the engine's own translating operation (only some engines).
6. **Word-level timestamps** - per-word timing in JSON output, selectable on Whisper API and decided by the engine on the other three.
7. **Request timeout** - the per-request network deadline (cloud engines only), replaced by **Local run timeout** on local whisper.cpp.
8. **Transcript output** - destination, file format, and in-note formatting.
9. **Auto chapters** - optional LLM-generated chapters for the enhanced player (see [Auto chapters](#auto-chapters)).
9. **LLM post-processing** - optional, documented separately in [LLM post-processing](llm-post-processing.md).

---

## Three ways to run it

Once transcription is enabled, you can start a run in three ways:

| Method                         | How to trigger it                                                                                   | When it is available                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Transcribe audio** (menu)    | Right-click an audio file in the **File Explorer**, an audio **embed link**, or an embedded player. | Always, for any audio file, once transcription is enabled.           |
| **Transcribe audio** (command) | Run the identically named command from the palette (`Ctrl/Cmd + P`); it targets the active file.    | Only when transcription is enabled **and** the active file is audio. |
| **Transcribe after recording** | Toggle **Transcribe after recording** on; every new recording is transcribed when it is saved.      | Automatic; runs as soon as a recording finishes saving.              |

The first two open the **Transcribe audio** dialog, where you can override the engine, language, diarization, destination, and file format for that single run (see [The Transcribe dialog](#the-transcribe-dialog-per-run-overrides)). The automatic path opens the same dialog with progress already running, so an auto-run stays visible and you can still cancel it.

> **Auto-transcribe and multiple files.** **Transcribe after recording** transcribes **only the first saved file** by design. A multi-track session in **Multiple files** mode, or an [auto-split](recording.md#automatic-splitting) recording, produces several files; auto-transcribing all of them could fire many paid API calls at once. To transcribe the other parts, run **Transcribe audio** on each from its context menu. See [Recording](recording.md) and [Multi-track recording](multi-track-recording.md).

---

## Engines

Choose the **Transcription engine** from the dropdown. Four engines are available:

| Engine                              | Type                        | Size limit per request | Diarization | Network  |
| ----------------------------------- | --------------------------- | ---------------------- | ----------- | -------- |
| **Whisper API (OpenAI-compatible)** | Cloud (OpenAI, Groq, …)     | 25 MB (hard)           | No          | Required |
| **Deepgram**                        | Cloud (pre-recorded API)    | 2 GB                   | Yes         | Required |
| **Google Gemini**                   | Cloud (multimodal)          | 2 GB                   | Yes         | Required |
| **Local whisper.cpp (desktop)**     | Local binary, fully offline | None (local)           | No          | None     |

Audio preparation (decoding and chunking, when a provider needs it) happens **in memory**. Whenever a provider accepts the original container and the file fits the limit, the file is sent untouched, which keeps memory low and avoids re-encoding. Nothing is written to disk during preparation, except that the local whisper.cpp engine hands each request to the binary as a temporary WAV and deletes it afterward.

### Whisper API (OpenAI-compatible)

OpenAI's speech-to-text API, and any OpenAI-compatible host (for example **Groq**), addressed by base URL, key, and model. This is the **default** engine.

Settings to fill:

| Setting                  | Description                                                                                                      | Default                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Upload chunk size**    | Megabytes per WAV chunk when a recording is too large to upload whole. Range 1-24 MB.                            | 24                          |
| **Whisper API base URL** | OpenAI-compatible endpoint base, e.g. `https://api.openai.com/v1` or a Groq URL.                                 | `https://api.openai.com/v1` |
| **Whisper API key**      | Your API key. Stored in plugin data on this device.                                                              | -                           |
| **Whisper model**        | Model id in use; the entry opens the saved ids, where it is picked. Must support `verbose_json` with timestamps. | `whisper-1`                 |

Behavior and limits:

- **Per-request limit is a hard 25 MB.** Files **at or under 25 MB** are uploaded in their **original container**, untouched.
- **Larger files** are resampled to **16 kHz mono**, split into upload-sized WAV chunks (sized by **Upload chunk size**, default 24 MB to stay under the 25 MB limit), and the per-chunk results are stitched back onto one timeline.
- **No diarization.** Whisper does not return speaker labels, so **Speaker diarization** is disabled for this engine.
- **Speech translation.** The endpoint carries a second operation that writes the recording down in **English** whatever was spoken. Turn on **Translate speech to English** to use it: the request is otherwise identical, so chunking, the dictionary bias, and word timestamps all behave the same, and the **Language** hint is ignored because it would describe the audio rather than the answer. This is the only engine that offers it. To translate into any other language, or on any other engine, use the [translation task](llm-post-processing.md) of LLM post-processing instead, which runs on the finished transcript.
- **Model requirements.** Only models that return `verbose_json` with segment timestamps work. `whisper-1` is OpenAI's; `whisper-large-v3` and `whisper-large-v3-turbo` are served by Groq and other compatible hosts. (OpenAI's `gpt-4o-transcribe` models do **not** support `verbose_json` and are intentionally excluded.)

Getting a key: [OpenAI Whisper API key](use-cases/openai-whisper-api-key.md) · [Groq Whisper setup](use-cases/groq-whisper-setup.md). The catalogue link next to the model picker points at the [OpenAI speech-to-text guide](https://platform.openai.com/docs/guides/speech-to-text).

![Whisper API engine settings: upload chunk size number field, base URL, API key, and model picker](images/settings-transcription-whisper.png)
_Figure: the Whisper API engine fields, with the upload chunk-size number field and the model picker._

### Deepgram

Deepgram's official **pre-recorded** transcription API, with strong diarization.

Settings to fill:

| Setting               | Description                                                                                           | Default                       |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Deepgram base URL** | Deepgram API base.                                                                                    | `https://api.deepgram.com/v1` |
| **Deepgram API key**  | Your Deepgram key. Stored in plugin data on this device.                                              | -                             |
| **Deepgram model**    | Model id in use; the entry opens the saved ids, where it is picked (e.g. `nova-3`, `nova-2-meeting`). | `nova-3`                      |

Behavior and limits:

- **Up to 2 GB sent whole.** Because the entire recording goes in one request, **diarization keeps consistent speaker numbering across the whole file**.
- **Diarization supported.** Turn on **Speaker diarization** to request speaker labels.
- **Billing.** A free Deepgram account includes a generous starter credit; beyond that, usage is pay-as-you-go.
- The picker is seeded with the Nova, Enhanced, and Base families; add your own ids if needed.
- **Custom dictionary support depends on the model.** Nova-3 biases with keyterm prompting and Nova-2 and older with keyword boosting, while the hosted Whisper models cannot bias; see [Biasing recognition toward your own terms](#biasing-recognition-toward-your-own-terms).

Getting a key: [Deepgram API key](use-cases/deepgram-api-key.md). The catalogue link points at the [Deepgram model list](https://developers.deepgram.com/docs/model).

![Deepgram engine settings: base URL, API key, and the Deepgram model picker](images/settings-transcription-deepgram.png)
_Figure: the Deepgram engine fields with the model picker seeded with the Nova family._

### Google Gemini

Google's multimodal `generateContent` API, using the File API to upload the recording.

Settings to fill:

| Setting             | Description                                                                                                     | Default                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Gemini base URL** | Gemini API base (no version segment).                                                                           | `https://generativelanguage.googleapis.com` |
| **Gemini API key**  | Your Gemini key. Stored in plugin data on this device.                                                          | -                                           |
| **Gemini model**    | Model id in use; the entry opens the saved ids, where it is picked (e.g. `gemini-3.5-flash`, `gemini-2.5-pro`). | `gemini-3.5-flash`                          |

Behavior and limits:

- **Up to 2 GB uploaded whole** via the File API, then transcribed in one request - so diarization keeps consistent speaker numbering across the whole file.
- **Container conversion.** Containers Gemini does not accept directly (notably `webm`, `mp4`, and `m4a`) are decoded to **16 kHz mono WAV** before upload. WAV, MP3, AAC, OGG, FLAC, and AIFF are sent as-is.
- **Long recordings are split.** A recording **longer than 15 minutes** is split into parts of equal length, each transcribed and stitched back onto the timeline; a recording of exactly 15 minutes still goes in one request. Splitting **resets Gemini's per-request speaker numbering**, so a diarized split shows a warning that speaker labels may differ between parts; the message suggests using Deepgram or splitting the recording for consistent speakers.
- **Diarization supported.** Turn on **Speaker diarization** to request speaker labels.

Getting a key: [Gemini API key](use-cases/gemini-api-key.md). The catalogue link points at the [Gemini model list](https://ai.google.dev/gemini-api/docs/models).

![Google Gemini engine settings: base URL, API key, and the Gemini model picker](images/settings-transcription-gemini.png)
_Figure: the Google Gemini engine fields with the Flash and Pro models in the picker._

### Local whisper.cpp (desktop)

Runs a local `whisper.cpp` binary with **no network access** - everything stays on your machine. Desktop only.

Settings to fill:

| Setting                     | Description                                    | Default |
| --------------------------- | ---------------------------------------------- | ------- |
| **whisper.cpp binary path** | Absolute path to the `whisper.cpp` executable. | -       |
| **Model path**              | Absolute path to a GGML model file (`.bin`).   | -       |
| **Extra arguments**         | Optional extra CLI arguments, space-separated. | -       |

Behavior and limits:

- **Fully offline.** No API key, no upload, and no per-request timeout (the **Request timeout** setting is hidden for this engine because it runs no HTTP request).
- **No diarization.** whisper.cpp does not return speaker labels, so **Speaker diarization** is disabled.
- **Model files.** Download a GGML model and point **Model path** at it. The model description lists the available names: `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium`, `medium.en`, `large-v3`, `large-v3-turbo`. Names ending in `.en` are **English-only**; the rest are multilingual.
- Each request is handed to the binary as a temporary WAV that is deleted afterward.

Setup walkthrough: [Local whisper.cpp](use-cases/local-whisper-cpp.md). The download link in the model-path description points at the [whisper.cpp models on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp).

![Local whisper.cpp engine settings: binary path, model path, and extra arguments fields](images/local-whisper-settings-engine.png)
_Figure: the local whisper.cpp engine fields for an offline transcription setup._

---

## Model picker and language

The cloud engines share one **model picker** control, with the saved model ids listed below it. Between them you can:

- **Pick from the list** - choose a model id from the dropdown of saved suggestions.
- **Add a model** - the add button on the list asks for the id your endpoint serves, adds it, and selects it.
- **Delete one** - the button on a list row removes that id; deleting the one **In use** moves the selection to the first remaining id.
- **Filter the list** - type in the field above it once the list is long enough to scroll.

On Obsidian 1.13 and later the saved ids live on a page of their own, reached from the model row, which shows the id in use; a vendor catalogue can run to thirty ids and inline they would bury the settings after them. On older versions the list is shown inline, since that Obsidian has no sub-pages.
- **Catalogue link** - a help link beside the field opens that engine's official model list (OpenAI, Deepgram, or Gemini).

The list is seeded on first run with common models for each engine and is fully user-editable. Local whisper.cpp does not use this picker - it takes a model **file path** instead (see above).

The **Language** setting controls the spoken language sent to the engine:

- Leave it as **`auto`** to let the engine detect the language.
- Or set an **ISO code** such as `en`, `ru`, or `es` to force a language. All languages supported by the chosen model work.

---

## Speakers and diarization

The transcript data model carries a **speaker** label per segment. To populate it, enable **Speaker diarization** - the provider then detects the number of speakers automatically and labels segments (for example `Speaker 1`, `Speaker 2`).

- **Diarization is available only with Deepgram and Google Gemini.** For Whisper API and local whisper.cpp the **Speaker diarization** toggle is **disabled and greyed out**, since those engines never return speaker labels.
- The effective state is what matters: a stored "on" reads as off the moment you switch to an engine that cannot diarize, so the toggle never claims a result it cannot deliver.

When diarization is **not in effect** (an engine that cannot diarize, or the toggle turned off), speaker labels are **stripped from the transcript entirely**. Neither the in-note Markdown nor the sidecar file - **including JSON** - shows them. The strip happens once on the canonical transcript, so every output path stays consistent.

Because there are no labels to act on without diarization, these output controls are **disabled and dimmed** whenever diarization is not in effect:

- **Include speakers**
- **Merge speaker turns**
- **Speaker format**

![Speaker diarization toggle enabled for Deepgram, with the speaker output controls active below](images/settings-transcription-diarization.png)
_Figure: with Deepgram and diarization on, the speaker-related output controls become editable._

### Naming speakers

Generic `Speaker 1` / `Speaker 2` labels are rarely what you want in a meeting note. **Rename speakers** is a manual action that replaces those labels with real participant names. Turn it on with the **Rename speakers** toggle under **Settings > Advanced Audio Recorder > Transcription**; the action then appears in the context menu of any recording, in the editor menu of its embed, and in the command palette.

The names you assign are **remembered in the recording's sidecar file** (`<recording>.markers.json`, shared with the player markers - see [Markers and chapters](audio-player.md#markers-and-chapters)). Every transcription - diarized or not - records the outputs it wrote there (with the exact paths, the render templates and heading in effect, and the run's provenance: detected language, engine model, and timestamp), and a diarized run records its speaker roster on top: each speaker's label, the name assigned to it, **where that speaker first talks**, and the **participant names** the run carried. That record is what makes the feature durable:

- **Re-transcribing the same recording re-applies your names automatically.** Once `Speaker 1` is named `Alex`, every output of the next diarized transcription - the in-note Markdown and the transcript files - says `Alex` again without any action from you. Names are matched by the engine's label, and a heads-up: **engines number speakers per run**, so when the detected speaker set changes between runs (someone joined, or the engine split differently) a notice asks you to check the assigned names. New labels appear unnamed; names of matched labels are kept. A stored name that happens to equal another speaker's label in the new run is **not** applied (it would render two speakers identically and merge them beyond repair) - a notice asks you to re-check the names instead. For the same reason the dialog refuses to give one speaker another speaker's label as a name.
- **The dialog shows the stored roster as three columns**: the engine label, a name field prefilled with your stored name, and a **play button that plays where that speaker first speaks**. Clearing a name field reverts that speaker to its original label. A recording without a stored roster - never diarized, or transcribed before speaker names were stored - has nothing to rename yet: transcribe it with speaker diarization (once, for older recordings) and the roster appears.
- **Listen to a speaker instead of remembering them.** The dialog sits on top of the note, so the transcript that would tell you who `Speaker 2` is has just been covered up. Press a row's ▶ button and that speaker's opening turn plays; the button turns into ■ while it does, and back to ▶ when you press it again, when the excerpt ends, or when you start another speaker's - only one plays at a time. The column carries nothing else: no seeking, no volume, no markers. The excerpt is the speaker's **first uninterrupted turn**, stretched to at least 4 seconds when that turn is a one-word "Yeah" and cut off after 15 seconds when it is an opening monologue. The row also states the timecode ("First speaks at 3:41") so you can find the moment in the transcript afterwards. Playback is independent of any player embedded in the note behind the dialog - it neither hijacks it nor shows up in the status-bar transport - and it stops when the dialog closes. Rosters written before this existed carry no timings, so their buttons are disabled with a tooltip saying to transcribe again with diarization.
- **Renames are applied to the outputs each transcription actually wrote**, using the render templates that were in effect at write time (including per-run overrides from the Transcribe audio dialog). Changing **Speaker format** or the other templates in settings later does not break renaming transcripts written with the old ones. **Renaming or moving a written note or transcript file inside Obsidian updates the recorded path automatically**, so the rename keeps reaching it; a recorded output deleted since (or moved outside Obsidian) no longer resolves and is skipped - the outcome notice says so, and the next transcription re-records the current outputs.
- **Each apply is self-healing.** Every replacement also targets the original engine label, so an output that missed an earlier rewrite (a failed write, a file restored from backup) is corrected by the next apply instead of staying out of sync forever. Because the names are already stored by the time you notice, that healing apply is one you press with the fields left exactly as they are: **Apply** stays available when nothing in the roster would change, rewrites the outputs, and records nothing, so the undo history keeps only the steps that actually renamed something. The outputs are rewritten first and the roster and history are committed only afterwards, so the sidecar never claims names the outputs were not even attempted with.
- Renaming touches **only this recording's transcript**. In a note, every transcript line carries a timecode link to its own audio, so a second recording's transcript in the same note is left untouched, and only the lines that belong to this recording are rewritten. Two names can be swapped in one apply, and replacements never chain through each other.
- **LLM post-processing does not exempt a note from renaming.** A **Clean up** or **Custom** pass is asked to keep speaker labels and timestamps on their original lines, so the note it produces almost always still carries the rendered transcript, and every recorded note is therefore rewritten like any other. What the run enabled decides nothing; only what the note turns out to contain does. A pass that genuinely restructured the body leaves no rendered label to match, and the outcome notice then says how many notes were left as they are; each untouched note is read back before it is described, so one that already reads the names you are applying is reported as already using them rather than accused of having lost them. When such a pass also stripped the timecode links, the note can no longer be tied to this recording, so the notice points you at **Rename in notes without timecodes** - turn that on and press **Apply** again with the same names to rewrite every matching label in it. A **Summary** pass prepends its summary above an intact transcript body and renames normally, and the transcript files next to the recording are updated in every one of these cases.
- **Undo:** every applied mapping is recorded in the sidecar (the last ten). When the history has entries, the dialog offers **Undo last rename**, which restores the previous names across all outputs through the same apply path and removes the undone entry - so pressing it again steps one rename further back each time, and the button disappears once the history is exhausted.
- **An unreadable sidecar is protected, not overwritten.** If the `.markers.json` file exists but cannot be read (damaged JSON, sync conflict), the dialog says so instead of pretending the recording has no roster, and all writes to that sidecar are paused so the possibly intact data on disk survives. Restore or remove the file and reopen the dialog; the plugin re-reads it on every access.
- **The recording carries its own participant roster**, so name suggestions do not depend on remembering which profile a meeting belonged to. The **Participant profile** picker defaults to **This recording**, whose names live in the same sidecar file as everything else, and the fields suggest from them as you type. Picking a profile instead **widens** the suggestions with its names rather than replacing them - the recording's own names always come first. Where that roster comes from:
    - **Transcription seeds it.** Pick a **Participant profile** in the Transcribe dialog and that profile's names are written into the recording's sidecar alongside the speaker roster, together with the profile's id - so reopening the rename dialog re-selects that profile automatically. A profile deleted since simply falls back to **This recording**.
    - **Every rename grows it.** A name you apply that was in neither the recording's roster nor the picked profile is added to **both**, in the same write that stores the roster. So a name typed once is suggested by this recording forever after, and by the profile for the next recording that picks it.
    - **Nothing is ever removed.** Transcribing again with a different profile adds that profile's names; it never drops the ones already there, so a recording accumulates everyone who has been named in it.
    - You can still create a profile and add names to it right in the dialog. Two speakers cannot be given the same name, because merging speakers is not supported yet.
- When a transcript has no timecode links to identify the recording (for example with timestamp links turned off), the dialog cannot pin its lines to this audio. It warns you, and only after you opt in does it rewrite every matching label in those notes.

---

## Biasing recognition toward your own terms

Names, abbreviations, and domain jargon are the words an engine mishears most often. **Dictionary profiles** live under the **Advanced settings** master switch (**Settings > Advanced Audio Recorder > Transcription > Advanced settings**), which is off by default; turn it on to reveal the dictionary and the two-pass mode, and with it off a recording transcribes in one plain pass with no biasing. The profiles are named glossaries, one term per line, so you can keep separate lists for different meeting types (standup, legal, medical) instead of one merged glossary that dilutes the bias. Manage them in the settings tab: **Dictionary profiles** opens a page (on Obsidian 1.13 and later; inline on older versions) whose entry shows the profile in use. That page is a list of the saved profiles with a filter above them, each entry saying how many terms it holds and whether a run uses it, plus **Add profile** for another one. Opening an entry gives that profile a page of its own with its terms across the full width, a **Use by default** switch deciding whether the Transcribe dialog offers it, and **Rename profile** and **Delete profile**. Names are unique, because a profile's page is addressed by its name. A term may contain spaces, so a full name or a multi-word product stays intact, while blank lines and case-insensitive duplicates are ignored. In the per-run **Transcribe audio** dialog you choose which profile to apply for that run, or **None**; the last choice is remembered and becomes the default for the next dialog and for transcribe-on-save.

![The Dictionary profiles settings section listing the saved glossaries with their term counts](images/settings-dictionary-profiles.png)
_Figure: the Dictionary profiles section under Settings > Advanced Audio Recorder > Transcription, listing the saved glossaries._

![The Transcribe audio dialog with a Dictionary dropdown for choosing a named profile or None](images/transcribe-dialog-dictionary.png)
_Figure: the per-run Transcribe audio dialog, where the Dictionary control selects which profile biases that run, or None._

Each engine consumes the list the way its own API supports:

- **Deepgram Nova-3** sends each term as a `keyterm` query parameter, Deepgram's keyterm prompting.
- **Deepgram Nova-2 and older** (Nova, Enhanced, Base) send each term as a `keywords` parameter, Deepgram's keyword boosting. Keyword boosting favors single words, so multi-word entries bias most reliably on Nova-3, Gemini, and Whisper rather than here.
- **Whisper API and local whisper.cpp** send the terms as the recognition prompt, the OpenAI `prompt` field and the whisper.cpp `--prompt` flag respectively; for the local engine that flag is placed before your extra args, so a `--prompt` you supply yourself still wins.
- **Google Gemini** folds the terms into the instruction text sent alongside the audio.

Provider request limits are enforced so a request never carries terms the engine would reject or silently ignore, and whenever some terms are left out a notice tells you it happened:

- **Deepgram Nova-3 accepts at most 100 keyterms and 500 keyterm tokens** in one request, so a longer glossary is trimmed to the first terms that fit both bounds; several long multi-word terms can reach the token limit well before 100 entries.
- **Deepgram Nova-2 and older accept at most 100 keywords** in one request, so a longer glossary is trimmed to the first 100 terms.
- **The Whisper prompt holds only about 224 tokens**, so a long list is trimmed to the terms that fit; the OpenAI API and local whisper.cpp share this bound.

Term length is measured conservatively (by byte count) so a glossary is never reported as applied while the engine quietly rejects or drops it. Short abbreviations, punctuation, and non-Latin scripts such as Cyrillic cost more tokens than their character count suggests, so with those a few terms fewer may fit than a plain character count would imply.

Deepgram's biasing depends on the selected **Deepgram model**, which is worth remembering when you change it:

- **The hosted Whisper models on Deepgram** (for example `whisper`, `whisper-medium`) support neither keyterm nor keywords, so the dictionary is not applied and a notice says so; choose a Nova model to bias recognition.
- **Keyterm prompting on Nova-3 targets English and Deepgram's multilingual configuration**, so biasing a specific non-English **Language** on Nova-3 may have no effect. See the [Deepgram keyterm documentation](https://developers.deepgram.com/docs/keyterm) for the current language coverage.

---

## Advanced two-pass transcription

**Advanced two-pass transcription (experimental)** is a sub-toggle of the **Advanced settings** master switch (**Settings > Advanced Audio Recorder > Transcription > Advanced settings**), sitting just below the dictionary profiles it reuses. It applies the method from *Whisper: Courtside Edition* (arXiv:2602.18966) inside the plugin: instead of one recognition pass, the recording is transcribed twice. Between the passes a team of LLM agents mines the first (draft) transcript for the meeting's domain context - the topic, proper names, domain jargon, and especially English technical terms and acronyms spoken inside another language - and assembles it into a compact hint that the second pass receives as a decoding bias. The second pass re-decodes the same audio leaning toward the right names and spellings while still checking against the acoustics; unlike an LLM edit of the text, it actually re-listens to the recording.

The mode targets the words a single pass gets wrong most stubbornly in, for example, Russian technical meetings: Russian proper names (rare, inflected, easily invented), professional jargon, and English terms and acronyms that a single pass transliterates ("кубернетис", "си ай си ди") or spells out. The agents put the canonical spellings (`Kubernetes`, `CI/CD`) into the second pass's hint, and the second pass's language is always pinned to the language detected on the first pass, so an English-heavy hint can never flip a Russian recording into English.

**It is off by default and costs real money and time when on:** every file runs two engine passes (roughly 2x the engine cost and duration) plus four to six sequential LLM calls on the engine its own **Context agents engine** row names, which sits beside the two-pass toggle so this mode can run on a different service from post-processing, and because a keyword-biased engine such as Deepgram reads only a keyterm list it runs two fewer of them, skipping the topic and sentence agents it does not need. On a cheap LLM model the money is small, but the sequential calls add latency. Turn it on for the recordings where names and terminology matter, and leave the normal single pass for everything else. The regular LLM post-processing still runs afterwards, on top of whichever pass won. Because that choice is usually made per recording, the **Transcribe audio** dialog carries its own **Advanced two-pass transcription** toggle that overrides this saved setting for a single run: enable the pricier pass for one important meeting, or skip it for a routine file, without changing the default. The toggle defaults from your saved setting, and the length safeguard stays in the settings tab.

How the engines receive the bias mirrors the [dictionary](#biasing-recognition-toward-your-own-terms) plumbing: the Whisper API and local whisper.cpp get one natural sentence in the audio's language (their prompt weights its last tokens most, so the most valuable terms go at the end), Deepgram Nova models get the terms as keyterms/keywords ahead of your dictionary profile's terms, and Gemini gets the context folded into its instruction text. A Deepgram hosted Whisper model cannot bias at all, so the mode degrades to a normal single pass and a notice says so - before any LLM is called.

The advanced mode is the two-pass form of the same dictionary biasing, not a separate feature: it reuses the terms from your selected [Dictionary profile](#biasing-recognition-toward-your-own-terms) as its context candidates rather than a second glossary, so curating one dictionary improves both the single pass and the advanced mode. Only the terms the first draft gives evidence for are kept, so an off-topic dictionary cannot inject words into a transcript.

One sub-setting appears while the mode is on:

- **Second-pass length safeguard** - the biased pass is kept only when its text is at least this fraction (default 0.8) of the first pass's. Over-correction - a biased decode dropping content - is the method's main failure mode, and a suspiciously short second pass is discarded in favor of the baseline.

The whole mode is best-effort by construction: a failed agent, a failed second pass, or a too-short result all keep the first pass's transcript, so it can never lose a completed (and paid) transcription. Diarization, speaker grouping, and `#t=` timecode links work on top of whichever transcript is kept.

---

## Output: where the transcript goes

Pick where the transcript lands with **Destination**:

| Destination option                       | What it does                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Insert into note**                     | Render the full transcript Markdown into the active note at the cursor.                                 |
| **Save to file**                         | Write a sidecar transcript file next to the audio.                                                      |
| **Note and file**                        | Do both - insert the Markdown and write the sidecar file.                                               |
| **Save to file and link it in the note** | Write the sidecar file and insert a link to it into the note (instead of pasting the whole transcript). |

When you ask for in-note output but the note is not open in an editable view (reading mode, or not open at all), a completed transcript is **never silently dropped**: the plugin writes a sidecar file as a fallback and the notice tells you what happened. If the audio file itself is the active pane (as with the **Transcribe audio** command), an in-note-only destination is downgraded to a file up front, so the run does what it can without a misleading "could not insert" outcome.

**File formats** (shown when the destination is anything other than note-only):

| Format option                   | Extension          | Contents                                                                     |
| ------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| **JSON (full data + speakers)** | `.transcript.json` | Full structured data: segments, speakers, and word-level timings.            |
| **SubRip (.srt)**               | `.srt`             | Standard subtitle cues with `HH:MM:SS,mmm` timing; speaker as a line prefix. |
| **WebVTT (.vtt)**               | `.vtt`             | WebVTT cues with `HH:MM:SS.mmm` timing; speaker as a line prefix.            |
| **Plain text (.txt)**           | `.txt`             | Readable lines, each prefixed with `[timecode]` and the speaker.             |

The sidecar is written **next to the audio file**, sharing its base name (JSON uses a `.transcript.json` suffix so it is not mistaken for other JSON). If a file with that name already exists, a numeric suffix is appended to avoid overwriting it. **Word-level timestamps** only appear in the **JSON** output, and which engine gives them is not the toggle's to decide: **Whisper API** requests per-word timings when it is on, **Deepgram** returns them on every run whatever it says, and **Google Gemini** and **local whisper.cpp** return segment-level timing only. The toggle is therefore live on Whisper API alone; on the other three it is shown disabled, sitting in the position that engine will actually produce and with that engine's own behaviour named under it, so a run never promises a words array it will not produce. Your choice is kept while another engine is selected and takes effect again on Whisper API.

With the default templates and timestamp links on, a diarized transcript renders like this:

```markdown
## Transcript

[[recording.webm#t=0:00]] **Speaker 1** Thanks everyone for joining today's sync.
[[recording.webm#t=0:04]] **Speaker 2** Happy to be here, let's get started.
```

Each timestamp is a clickable link that seeks the [enhanced player](audio-player.md#timecode-links) embedded above it to that position.

---

## In-note formatting

When the transcript is rendered into a note (**Insert into note** or **Note and file**), its layout is fully configurable under **Transcript output**:

| Setting                        | Description                                                                                             | Default                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Note heading**               | Heading inserted above the transcript. Leave empty for none.                                            | `## Transcript`                |
| **Include timestamps**         | Render a timestamp at the start of each line.                                                           | On                             |
| **Timestamps as player links** | Render each timestamp as a `#t=` link that jumps the [enhanced player](audio-player.md#timecode-links). | On                             |
| **Include speakers**           | Render the speaker label on each line (diarization-gated).                                              | On                             |
| **Merge speaker turns**        | Combine consecutive segments from the same speaker into one line (diarization-gated).                   | On                             |
| **Timestamp format**           | Template wrapping the timecode; `{time}` is the (possibly linked) code.                                 | `{time}`                       |
| **Speaker format**             | Template wrapping the speaker label; `{speaker}` is the name (diarization-gated).                       | `**{speaker}**`                |
| **Line format**                | Arrangement of the three parts; tokens `{timestamp}`, `{speaker}`, `{text}`.                            | `{timestamp} {speaker} {text}` |

How the templates compose: each line takes its **timestamp** (wrapped by **Timestamp format**) and its **speaker** (wrapped by **Speaker format**), then arranges them with the **text** using **Line format**. Empty fragments disappear cleanly and surrounding whitespace is collapsed, so a missing speaker or a disabled timestamp leaves no stray gap.

- **Timestamps as player links** turns each timecode into a vault link with a `#t=` offset that jumps the enhanced player to that position - click a line to hear it. See [timecode links](audio-player.md#timecode-links). Avoid wrapping `{time}` in `[ ]` in the timestamp format while links are on, since the link already delimits the timecode.
- Any `[[…]]` or `![[…]]` that appears inside transcribed text or a speaker label is escaped, so transcript content never renders as an unintended link or embed.

---

## The Transcribe dialog (per-run overrides)

When you run **Transcribe audio** from the context menu or the command palette, the dialog lets you override the global defaults **for that run only** - your saved settings are never changed. The dialog shows the source file name and these editable options:

- **Engine** - switch engine for this run.
- **Language** - `auto` or an ISO code.
- **Speaker diarization** - request speaker labels (enabled only when the chosen engine can diarize).
- **Participant profile** - shown only when the run will actually produce speaker labels. Picks the roster of names stored with this recording, so **Rename speakers** suggests the right people afterwards. The last pick is remembered and also applies to transcribe-on-save; profiles are created in the rename dialog. See [Naming speakers](#naming-speakers).
- **Word-level timestamps** - per-word timing (JSON output only). Live on Whisper API; on the other engines it shows what that engine will do and cannot be changed.
- **Advanced settings** - a master switch (off by default) that reveals the term-biasing controls for this run; with it off the recording transcribes in one plain pass with no biasing. When on it shows a **Dictionary** picker (choose a named profile to bias this run, or None) and an **Advanced two-pass transcription** toggle (the experimental context-biased two-pass mode, roughly 2x the engine cost plus LLM calls, reusing the Dictionary terms above and leaving its length safeguard in the settings tab).
- **Destination** - Insert into note / Save to file / Note and file / Save to file and link it in the note.
- **File format** - shown when the destination is not note-only.
- **Include timestamps** and **Include speakers** - shown only when the destination renders Markdown into the note (Insert into note / Note and file); **Include speakers** is diarization-gated.
- **LLM post-processing** - toggle it on, and pick the **LLM task** (Clean up / Summarize / Custom) for this run.

The detailed in-note templates (note heading, timestamp/speaker/line format) stay in the **settings tab**, and so does everything about a service itself, since a credential cannot be entered safely in a transient dialog: each engine's endpoint, key, model catalogue, and token ceiling belong on its page under **Engines**. Whatever you set in those template and provider fields is applied as configured.

Options toggled mid-run do **not** change an in-flight job: the run snapshots its options when you press **Transcribe**, so edits only affect the next attempt after a failure.

![The Transcribe audio dialog with per-run Engine, Language, diarization, Destination, and File format controls](images/transcription-dialog.png)
_Figure: the Transcribe audio dialog with the per-run overrides above the progress area._

---

## Progress and minimizing

While a transcription runs, the dialog shows a **progress bar**, a live **elapsed-time counter**, and a status label that reports the current stage (preparing audio, transcribing a part, post-processing). The buttons let you control the run:

- **Cancel** - stops the run. For endpoints that accept direct browser requests (the normal case), pressing **Cancel** aborts the in-flight request immediately and releases the connection. Only when an endpoint refuses browser (CORS) requests and the plugin falls back to Obsidian's own request channel does cancellation wait until that request returns or hits the timeout. Every model call the run makes answers the same signal, so a Cancel pressed during [LLM post-processing](llm-post-processing.md), the context agents, or a pause between retries ends the call in flight rather than paying for it to finish.
- **Minimize** - sends the job to the status bar so you can keep working. The status bar then shows live transcription progress; **click it** (or focus it and press Enter) to reopen the dialog. **Closing** the dialog instead of minimizing **cancels** the running job.
- **Recording takes precedence** in the status bar, so an active recording's status is shown first and the transcription progress reappears once recording finishes.

Each network request - one part of a long recording, or a whole-file upload - is bounded by the **Request timeout** (default **10 minutes**, range **1-60**), so a stalled request fails that part and is reported rather than hanging the run. Underneath this cap, a whole-file upload scales its own timeout with payload size, so a large but healthy upload is not aborted prematurely; the **Request timeout** value is the ceiling.

When a long recording is split into several parts, parts that fail are reported and the parts that succeeded are still kept - a `> [!warning]` callout names the missing stretch in the inserted Markdown, and a notice explains what was lost. Only if **every** part fails does the whole run fail with the first error.

A part whose transcript overruns the model's **output-token limit** (which Gemini can hit on dense speech) is not discarded: it is automatically split into smaller halves and retried, down to a minimum segment length of one minute. Each retry is a separate, normally billed API request; only a segment that is truncated even at the minimum length is reported as missing.

---

## Cost estimates

Cloud transcription is a paid API call, and nobody likes a surprise bill. With **Show cost estimates** on (the default, under **Settings > Advanced Audio Recorder > Transcription**), the **Transcribe audio** dialog makes the spending visible:

- **Before the run**, the dialog shows an **Estimated cost** breakdown priced from the recording's duration. That duration is read from the container headers, which costs almost nothing; a file whose headers carry no duration, as a recording written live often does, is decoded instead, so the estimate appears either way. It lists one line per billed step of the run, assembled automatically from the features you have enabled: the transcription pass itself, a second transcription pass when the **Advanced two-pass** mode is on (so the transcription roughly doubles), the LLM **context agents** that run between those passes, the [LLM post-processing](llm-post-processing.md) pass, and the **auto chapters** generation, each shown only when it will actually run. The priced lines are summed into an estimated total, so the number reflects the whole run rather than one stage, and toggling a feature changes it. Deepgram and the Whisper API are priced per audio minute; Gemini is priced from its audio-token rate (about 32 tokens per second of audio); the LLM steps are priced from the transcript's token size and the selected model. Switching the engine, model, or an enabled feature in the dialog re-prices the estimate immediately.
- **During a long multi-part run**, a live "Cost so far" line accumulates what the completed transcription parts actually billed.
- **After the run**, a notice reports the transcription cost together with the running session total, and the dialog shows **"Spent this session"** - a per-session counter of everything transcribed since Obsidian started, kept per engine. The line names what the total is made of: runs that could not be priced at all, and steps whose figure is an estimate rather than a count the vendor reported.

Below the breakdown, a **Check current pricing** line links straight to the pricing page of each provider the run uses, so the built-in rates are one click from the authoritative numbers. The transcription cost is computed from what the provider **actually reported billing for** - Deepgram's and OpenAI's billed audio duration, Gemini's token counts split by modality (audio input and the text prompt are billed at different rates) - and falls back to the duration-based estimate when a provider reports nothing. Estimates use **built-in, approximate pay-as-you-go rates** for the common models (`whisper-1`, Groq's `whisper-large-v3`(-turbo) and `distil-whisper`, Deepgram `nova`/`enhanced`/`base`, Gemini 2.x, and the OpenAI, Anthropic, and Gemini post-processing models); providers change prices, so always verify against the linked pricing page. A model the plugin has no rate for shows "no built-in rate" instead of a wrong number, and such runs are counted separately in the session total rather than silently added as zero. The **local whisper.cpp engine is free** and shows no cost. The LLM steps (context agents, post-processing, auto chapters) are counted in the session total too, and they are priced the same way the transcription is: OpenAI, Anthropic, and Gemini all return the token counts they billed in the same response the text comes from, so a completed step is recorded at **what it cost** rather than at what it was expected to cost. Reasoning tokens, which the models that produce them report separately, are billed at the output rate. The pre-run estimate is the fallback, used for a model with no built-in rate and for a vendor that reported no counts, and the session line says how many steps were priced that way, so an estimate is never presented as a measurement.

---

## LLM post-processing

After transcription, you can optionally pass the transcript through an LLM to **clean up** punctuation and formatting (preserving wording, timestamps, and speakers), **summarize** it into key points and action items, or apply a **custom instruction**. The provider defaults to OpenAI (`gpt-5.6-sol`), with Anthropic (`claude-opus-4-8`) and Google Gemini (`gemini-3.5-flash`) also available; the OpenAI and Gemini keys are shared with the matching transcription engines.

LLM post-processing is **best-effort**: a failure (bad key, network, timeout) falls back to the raw transcript rather than discarding completed work.

This is a feature in its own right - see the full guide: **[LLM post-processing](llm-post-processing.md)**.

---

## Auto chapters

With **Auto chapters** enabled (under **Settings > Advanced Audio Recorder > Transcription > Auto chapters**), the plugin can ask the configured LLM to divide a transcribed recording into titled chapters. The chapters are written to the recording's marker sidecar and appear in the enhanced player's [markers and chapters](audio-player.md#markers-and-chapters) window, where they behave exactly like chapters you add by hand (seek-bar boundaries, prev/next navigation, rename, delete).

Two ways to run it:

- **On demand** - the **Generate chapters from transcript** action in the recording's context menu, the editor menu of its embed, and the command palette. It opens a dialog where you pick the chapter guidance profile and the chapters engine and model for this run, and see an up-front estimate of the LLM cost before generating. It requires an existing transcript: the outputs recorded in the recording's sidecar are consulted first (transcript files in JSON, SRT, VTT, or plain text, then recorded notes scoped by their timecode links). A note that went through an LLM **Clean up** or **Custom** pass is read like any other, because that pass is asked to keep the timestamps on their original lines and its note therefore still parses; one that was truly restructured simply yields no timecoded lines and loses to whichever note has more of them. When the recorded outputs yield nothing - none recorded, or every one since deleted, unreadable, or left without a single timecoded line - the plugin falls back to scanning for transcript files next to the audio and referencing notes, so a transcript that exists on disk is still found. Without one, the dialog explains there is nothing to chapter and asks you to transcribe first.
- **After each transcription** - turn on **Generate after transcription** (also offered as a per-run toggle in the Transcribe dialog, where a compact **Chapter profile** picker appears next to it). Chapters are then generated in the background from the fresh transcript once each run finishes, without delaying the transcript output.

How the recording is divided is steered by a selected **chapter guidance profile**. The plugin ships a **Default** profile with general splitting guidance, and you can edit it, add profiles for specific cases (a meeting split by agenda item, a lecture by topic, an interview by question), and pick the one that fits the recording before generating. The selected profile's text is appended to the fixed chapter prompt, so it shapes the division and the titles without being able to change the strict response format the plugin validates. Selecting **None** leaves the base prompt alone.

The LLM's response is validated before anything is written, and the validation is a real check on the times rather than blind trust in the model. Chapter times must fall inside the recording's transcript, and the model is told the recording's length so it spreads chapters across the whole timeline instead of bunching them at the start. Chapters that land closer together than a minimum spacing (about twenty seconds on a normal recording, relaxed for a short clip) are dropped, so a model that returns a run of one- or two-second chapters cannot produce them. Empty or malformed entries are dropped, and an unusable response leaves the markers untouched. Re-running replaces only the previously **generated** chapters - bookmarks and chapters you created manually are never modified, and a generated chapter landing on top of a manual one is skipped.

Auto chapters names its own engine on the **Chapters engine** row beside its switch, so it can run on a different service from [LLM post-processing](llm-post-processing.md); that service is set up once on its page under **Engines**, where its key, model, and token ceiling live. The on-demand dialog exposes the same engine and model, so you can switch them for a run without leaving the dialog; generating keeps that choice as the chapters engine and saves the model on the engine it generated with, while cancelling leaves both unchanged and post-processing untouched either way. Only the engine that ran is saved, so a provider you merely switched through keeps the id it had. The dialog stays open while the generation is in flight and offers a **Cancel**, because chaptering is a paid call over a transcript that can run to thousands of lines. Dismissing the dialog with Escape or its close control stops the run exactly as the button does, and a run stopped either way writes no chapters and reports itself as cancelled.

The engine that does run is a different matter, and the dialog says so before you choose. An engine serves one model catalogue, and an engine that both transcribes and answers prompts therefore serves one catalogue for both jobs, which is what Gemini does: the model you pick for a chaptering run is literally the field transcription reads, so choosing a cheaper one to title some chapters also changes what the next recording is transcribed with. Where that applies, the engine row spells it out; an engine that only answers prompts, such as OpenAI or Anthropic, has a catalogue nothing else reads and the row stays silent.

The **Auto chapters** block and the **Engines** entry stay in settings when **Enable transcription** is turned off, because the chapters action is offered on any recording that already carries a transcript. A vault that has stopped transcribing new recordings can still chapter the old ones, and the engine that does it still needs a key, an endpoint, and a model, so the rows that hold them stay reachable. Only **Generate after transcription** goes away, since there are no transcriptions left for it to follow.

---

## Security and storage

- **API keys** are stored in the plugin's `data.json` **on this device** and are **never written to diagnostics** output.
- **Avoid syncing `data.json`** to untrusted locations, since it holds your keys in plain text.
- **Local whisper.cpp keeps everything offline** - no key, no upload, no network request - for the most privacy-sensitive recordings.

---

## Settings reference

All transcription settings live under **Settings > Advanced Audio Recorder > Transcription**. The global and output settings:

| Setting                             | Description                                                                                             | Default                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Enable transcription**            | Master toggle that reveals the rest of the section.                                                     | Off                            |
| **Transcribe after recording**      | Auto-transcribe each saved recording (first file only).                                                 | Off                            |
| **Transcription engine**            | Whisper API / Deepgram / Google Gemini / Local whisper.cpp.                                             | Whisper API                    |
| **Language**                        | `auto` to detect, or an ISO code (`en`, `ru`, `es`).                                                    | `auto`                         |
| **Speaker diarization**             | Request speaker labels (Deepgram and Gemini only).                                                      | Off                            |
| **Word-level timestamps**           | Per-word timing in JSON file output. Selectable on Whisper API; the other engines decide it themselves. | Off                            |
| **Request timeout**                 | Minutes before one request is aborted and reported (cloud engines only). Range 1-60.                    | 10                             |
| **Local run timeout**               | Minutes before the local whisper.cpp process is stopped (that engine only). Range 1-720.                | 120                            |
| **Advanced settings**               | Master switch revealing the dictionary and the two-pass mode; off keeps one plain pass with no biasing. | Off                            |
| **Advanced two-pass transcription** | Two engine passes with LLM-generated context biasing the second (roughly 2x cost; experimental).        | Off                            |
| **Second-pass length safeguard**    | Keep the biased second pass only when its text is at least this fraction of the first pass.             | 0.8                            |
| **Destination**                     | Insert into note / Save to file / Note and file / Save to file and link it in the note.                 | Insert into note               |
| **File format**                     | JSON / SubRip (.srt) / WebVTT (.vtt) / Plain text (.txt). Shown when destination is not note-only.      | JSON                           |
| **Note heading**                    | Heading inserted above the transcript (empty for none).                                                 | `## Transcript`                |
| **Include timestamps**              | Render timestamps on each line.                                                                         | On                             |
| **Timestamps as player links**      | Render each timestamp as a `#t=` player link.                                                           | On                             |
| **Include speakers**                | Render speaker labels (diarization-gated).                                                              | On                             |
| **Merge speaker turns**             | Merge consecutive same-speaker segments (diarization-gated).                                            | On                             |
| **Timestamp format**                | Template wrapping `{time}`.                                                                             | `{time}`                       |
| **Speaker format**                  | Template wrapping `{speaker}` (diarization-gated).                                                      | `**{speaker}**`                |
| **Line format**                     | Arrangement of `{timestamp} {speaker} {text}`.                                                          | `{timestamp} {speaker} {text}` |

Per-engine fields (base URL, key, model picker, upload chunk size) are documented in [Engines](#engines) above.

**Related docs:**

- [Recording](recording.md) - capture audio and auto-transcribe on save.
- [Multi-track recording](multi-track-recording.md) - why only the first file auto-transcribes.
- [Audio player](audio-player.md#timecode-links) - how timestamp player links work.
- [LLM post-processing](llm-post-processing.md) - clean up, summarize, or rewrite the transcript.
- [Settings reference](settings-reference.md) - every plugin setting in one place.
- Use-case guides for getting keys: [OpenAI](use-cases/openai-whisper-api-key.md) · [Groq](use-cases/groq-whisper-setup.md) · [Deepgram](use-cases/deepgram-api-key.md) · [Gemini](use-cases/gemini-api-key.md) · [Anthropic](use-cases/anthropic-api-key.md) · [Local whisper.cpp](use-cases/local-whisper-cpp.md) · [Transcribe after recording](use-cases/transcribe-after-recording.md) · [Meeting notes workflow](use-cases/meeting-notes-workflow.md).

---

## Troubleshooting

- **"Transcribe audio" is missing from the menu** - enable **Enable transcription** in settings first.
- **The Transcribe audio palette command does nothing** - it runs only when the active file is an audio file and transcription is enabled. Open the audio file (or its note) and try again.
- **Speaker labels never appear** - only Deepgram and Gemini diarize; the toggle is disabled for Whisper API and local whisper.cpp. With a diarizing engine, make sure **Speaker diarization** and **Include speakers** are on. Without diarization in effect, labels are stripped everywhere, including the JSON file.
- **Speaker numbers change partway through a Gemini transcript** - a recording longer than 15 minutes is split into parts and Gemini renumbers speakers per part. Use **Deepgram** (sends the whole file) or split the recording for consistent speakers. A recording of exactly 15 minutes is not split and shows no such warning.
- **"Could not insert the transcript into the note"** - the note was not open in editing mode. The transcript is saved as a sidecar file as a fallback; the notice shows its path. Open the note in editing mode to insert there.
- **A request times out** - raise **Request timeout** (up to 60 minutes) for slow connections or very large uploads, or split the file first.
- **A local whisper.cpp run is stopped before it finishes** - the process outlived **Local run timeout**. Raise it (up to 720 minutes) or point the engine at a smaller model; a large model on a slow CPU can take longer than the recording itself.
- **A part of a long recording is missing** - that part failed; a `> [!warning]` callout names the stretch and a notice explains the cause. Re-run the failed file, or check the engine's quota and key.
- **A large file uploaded to Whisper** - there is no "file too large" error. Whisper has a hard 25 MB limit, but files over it are resampled to 16 kHz mono and split into chunks automatically, so the run proceeds without an error. If a chunk still fails, lower **Upload chunk size**.
- **API errors (401/403/quota)** - verify the **API key** and **base URL** for the engine, and check the account's billing or starter credit. A key is only required while the **Base URL** points at the vendor's own host, so a `401` from an endpoint you pointed elsewhere means that endpoint wants a key after all. See the per-engine use-case guides for getting and checking keys, and the [Engines reference](settings-reference.md#transcription) for when the key field may be left empty.
- **A run pauses and says it is retrying** - the provider refused that request for now, with a rate limit or a fault of its own, and the part is sent again rather than lost. Each part is tried up to three times, honouring the pause the provider asks for through `Retry-After` and otherwise backing off from two seconds. A provider asking to wait longer than a minute is telling you to come back later, so the part is reported missing instead of freezing the run, and **Cancel** ends a pause at once.
