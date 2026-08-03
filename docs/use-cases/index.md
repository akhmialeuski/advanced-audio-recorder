# Use cases and how-to guides

This is the hub for the step-by-step guides. The reference docs describe _what_ each feature does; the guides here show _how_ to get something done end to end - sign up for a transcription provider, paste an API key into the right field, set up a fully offline engine, or run a complete record-and-summarize workflow. Each guide is self-contained, so start with the one that matches your goal and follow it from top to bottom.

- [Where to start](#where-to-start)
- [Getting API keys](#getting-api-keys)
- [Local and offline](#local-and-offline)
- [Workflows](#workflows)
- [Which engine should I choose?](#which-engine-should-i-choose)
- [Related reference docs](#related-reference-docs)

## Where to start

- **You just want to dictate or record** - you do not need any of these guides. See [Getting started](../getting-started.md) and [Recording](../recording.md).
- **You want to turn speech into text** - pick a transcription engine first using the [comparison table](#which-engine-should-i-choose) below, then follow that engine's API-key guide.
- **You want everything to stay offline** - go straight to [Set up local whisper.cpp](#local-and-offline).
- **You are recording on a phone or tablet** - follow [Record a voice memo or lecture on your phone](record-on-mobile.md).
- **You want a complete real-world workflow** - jump to [Workflows](#workflows).

---

## Getting API keys

Cloud transcription engines (and the LLM post-processing providers) authenticate with an **API key** you generate on the provider's website. Each guide walks you through creating an account, generating the key, and pasting it into the correct field in **Settings > Advanced Audio Recorder > Transcription**. Keys are stored only in the plugin's `data.json` on this device and are never written to diagnostics.

| Guide                                             | Provider                 | Use it for                                                |
| ------------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| [OpenAI / Whisper API](openai-whisper-api-key.md) | OpenAI                   | The default **Whisper API** engine, paid per minute.      |
| [Groq (free tier)](groq-whisper-setup.md)         | Groq (OpenAI-compatible) | The **Whisper API** engine via Groq's fast, free host.    |
| [Deepgram](deepgram-api-key.md)                   | Deepgram                 | The **Deepgram** engine with diarization, free credit.    |
| [Google Gemini](gemini-api-key.md)                | Google AI Studio         | The **Gemini** engine for long files and LLM reuse.       |
| [Anthropic / Claude](anthropic-api-key.md)        | Anthropic                | **LLM post-processing** with Claude (clean up/summarize). |

Every API-key guide follows the same shape: generate the key on the provider's site, then paste it into the matching field in the Transcription settings.

> **Heads-up on shared keys.** A key belongs to the account rather than to the job, so the OpenAI page serves both Whisper API transcription and OpenAI post-processing, and the Gemini page serves transcription and prompts alike. Anthropic/Claude only writes, so it keeps a page and a key of its own. See [LLM post-processing](../llm-post-processing.md) for details.

---

## Local and offline

| Guide                                            | What it covers                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| [Set up local whisper.cpp](local-whisper-cpp.md) | Run a local `whisper.cpp` binary so transcription is fully offline, no key. |

The **Local whisper.cpp** engine runs a binary you install yourself and a GGML model file you download once. Nothing leaves your machine. This guide covers the binary path, the model path (an absolute path to a GGML `.bin` file), extra CLI arguments, and which model size to pick.

![The Transcription settings with the Local whisper.cpp engine selected, showing the binary path, model path, and extra CLI args fields](../images/local-whisper-settings-engine.png)
_Figure: The Local whisper.cpp engine adds binary-path, model-path, and extra-args fields instead of an API key._

---

## Workflows

These guides combine several features into one end-to-end procedure.

| Guide                                                                     | What it covers                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Transcribe automatically after recording](transcribe-after-recording.md) | Turn on **Transcribe after recording** so every clip produces a transcript. |
| [Record and summarize a meeting](meeting-notes-workflow.md)               | Record a meeting, transcribe it with diarization, and add an LLM summary.   |
| [Record a voice memo or lecture on your phone](record-on-mobile.md)       | Record on the Obsidian mobile app and optionally transcribe in the cloud.   |

The meeting-notes workflow produces a single note with the recording, a diarized transcript, and an LLM summary - see the finished example in that guide.

---

## Which engine should I choose?

Pick a transcription engine before you sign up anywhere - the choice decides which API-key guide you need. The table below summarizes the trade-offs; the [Transcription](../transcription.md) reference covers each engine in full, including [speakers and diarization](../transcription.md#speakers-and-diarization).

| Engine                        | Cost                        | Diarization | Max file | Offline | Best for                                |
| ----------------------------- | --------------------------- | ----------- | -------- | ------- | --------------------------------------- |
| **Whisper API** (OpenAI/Groq) | Paid (Groq has a free tier) | No          | 25 MB\*  | No      | Accurate single-speaker transcription   |
| **Deepgram**                  | Free credit, then pay-as-go | Yes         | 2 GB     | No      | Meetings and interviews with speakers   |
| **Google Gemini**             | Free tier, then paid        | Yes         | 2 GB     | No      | Long recordings and reuse for LLM tasks |
| **Local whisper.cpp**         | Free                        | No          | -        | Yes     | Private, offline transcription          |

\* Files over 25 MB are automatically resampled to 16 kHz mono and split into upload-sized chunks, then stitched onto one timeline. See [Transcription](../transcription.md) for the full mechanics.

Quick rules of thumb:

- **One speaker, want it accurate** > Whisper API (use [Groq](groq-whisper-setup.md) for a free tier, or [OpenAI](openai-whisper-api-key.md)).
- **Multiple speakers / meetings** > [Deepgram](deepgram-api-key.md) or [Google Gemini](gemini-api-key.md) - both support speaker diarization.
- **Long recordings, or you also want LLM summaries** > [Google Gemini](gemini-api-key.md).
- **Must stay offline / no API key** > [Local whisper.cpp](local-whisper-cpp.md).

---

## Related reference docs

- [Transcription](../transcription.md) - engines, diarization, output formats, and destinations in full.
- [LLM post-processing](../llm-post-processing.md) - clean up, summarize, or apply a custom instruction to a transcript.
- [Settings reference](../settings-reference.md) - every setting, its options, and its default.
- [Getting started](../getting-started.md) - install the plugin and make your first recording.
- [Troubleshooting](../troubleshooting.md) - diagnostics and fixes for common problems.
