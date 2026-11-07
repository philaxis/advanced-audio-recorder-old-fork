# Get a Soniox API key

Soniox is one of the six [transcription](../transcription.md) engines. It reads recordings in 60+ languages, Korean among them, labels the speakers, takes every container this plugin records (the default WebM included) without converting it, and bills about **$0.10 per audio hour**. It works only as a transcription engine: it writes no text, so it has no LLM post-processing page. This guide takes you from a blank settings tab to a working transcript.

- [Why Soniox](#why-soniox)
- [Step 1: Create the API key in the Soniox console](#step-1-create-the-api-key-in-the-soniox-console)
- [Step 2: Configure Soniox for transcription](#step-2-configure-soniox-for-transcription)
- [How Soniox handles your audio](#how-soniox-handles-your-audio)
- [Verify it works](#verify-it-works)
- [Troubleshooting](#troubleshooting)
- [Related guides](#related-guides)

## Why Soniox

Soniox is the engine to reach for when the speech is not English, or mixes languages:

- **Languages beyond English.** The `stt-async-v6` model covers 60+ languages. A **Language** hint such as `ko` improves accuracy for that language without stopping other languages being recognised, so a Korean meeting with English terms in it comes back as spoken.
- **No conversion.** AAC, AIFF, AMR, ASF, FLAC, MP3, OGG, WAV, WebM, M4A and MP4 are uploaded untouched, so a default recording is sent as it is with no decode and no memory cost.
- **Up to 300 minutes in one request**, so a whole meeting is transcribed in one piece and speaker numbering stays consistent.
- **Speaker diarization and word timing.** Turn on **Speaker diarization** for per-speaker labels, which you can rename like any other engine's. Every transcript carries per-word timing in the JSON output.
- **Term biasing.** A [custom dictionary](../transcription.md#biasing-recognition-toward-your-own-terms) is sent as context terms, which helps the model spell names, jargon, and acronyms the way you do. Write them in the script people speak them in.

| Property                | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| Engine name in settings | **Soniox**                                              |
| Default base URL        | `https://api.soniox.com/v1`                             |
| Default model           | `stt-async-v6` (`stt-async-v5` is also offered)         |
| Max length per request  | 300 minutes (uploaded whole, no conversion)             |
| Diarization             | Supported (off by default)                              |
| Language hint           | Sent as a hint: the first code of **Language**          |
| Word-level timestamps   | Always in the JSON output; the switch is shown disabled |
| Cost                    | About $0.10 per audio hour                              |

---

## Step 1: Create the API key in the Soniox console

1. Create an account at **[console.soniox.com](https://console.soniox.com)** and log in.
2. API keys belong to a project. Open your project (a new account has **My First Project**) and select **API Keys**.
3. Generate a key and copy it straight away.

> Your usage and billing live in the Soniox console, so check there if a request comes back rejected for balance. A project created in a regional data location (EU, Japan or India) has its own API domain, which goes in **Base URL** below.

---

## Step 2: Configure Soniox for transcription

In Obsidian, open **Settings > Advanced Audio Recorder** and scroll to the **Transcription** section.

1. Turn on **Enable transcription**.
2. Set **Transcription engine** to **Soniox**.
3. Open **Engines** and then the **Soniox** page.
4. Leave **Base URL** at `https://api.soniox.com/v1`, or enter your regional domain (`https://api.eu.soniox.com/v1`, `https://api.jp.soniox.com/v1` or `https://api.in.soniox.com/v1`).
5. On the **Soniox API key** row, click **Link...**. In Obsidian's secret picker choose **Add secret...** (it opens straight away while the keychain is empty), enter an ID such as `soniox-api-key`, paste your key as the secret, and save. The key is kept in Obsidian's keychain on this device; the plugin stores only the ID.
6. Under **Model**, pick `stt-async-v6` (the default). Use the **Model catalogue** entry below it to add another id or drop one.
7. Back in **Transcription**, set **Language** to the language of the recording (for example `ko`), or leave it on `auto`.
8. (Optional) Turn on **Speaker diarization** for meetings and interviews.
9. (Optional) Turn on **Transcribe after recording** to transcribe every new recording automatically.

| Field                    | What to enter                                       |
| ------------------------ | --------------------------------------------------- |
| **Transcription engine** | Soniox                                              |
| **Base URL**             | `https://api.soniox.com/v1` (default)               |
| **Soniox API key**       | The key you copied from the console                 |
| **Model**                | `stt-async-v6` (default)                            |
| **Language**             | `ko` for Korean, or `auto`                          |
| **Speaker diarization**  | On for meetings and interviews, off for one speaker |

For the shared output settings (destination, file format, in-note formatting, timestamps, speaker formatting), see the [transcription guide](../transcription.md#output-where-the-transcript-goes).

---

## How Soniox handles your audio

A few behaviors are specific to this engine:

- **Upload, transcribe, delete.** Soniox works on a file it stores: the plugin uploads the recording, starts a transcription, waits for it, reads the result, and deletes both from your Soniox account afterwards, also when the run fails or is cancelled.
- **Waiting.** The status is checked after one second and then at growing intervals up to ten seconds. The wait is capped by the **Request timeout** setting (default 10 minutes), so raise it for a recording of several hours.
- **Language is a hint.** Only the first code of **Language** is sent, without its region (`pt-BR` becomes `pt`). Soniox still recognises other languages in the audio. With `auto` it detects the language itself.
- **Term biasing is bounded by size.** There is no cap on the number of terms, only on the context of one request, which Soniox limits to 8,000 tokens. The plugin keeps the leading terms that fit about 7,000 tokens and reports the rest in a notice.
- **No speech translation.** **Translate speech to English** is disabled. Use the [translation task](../llm-post-processing.md) of LLM post-processing on the finished transcript instead.
- **`stt-async-v5` is deprecated.** Soniox removes it on December 15, 2026 and runs requests for it on v6 from then.

---

## Verify it works

1. Open a note and record a short clip, or open an existing audio file in your vault.
2. Make sure **Soniox** is the selected engine and its key is linked.
3. With an audio file active, run **Transcribe audio** from the command palette (this command appears only when transcription is enabled and the active file is audio).
4. Watch the progress dialog. When it finishes, the transcript is inserted into the note and written to a sidecar file, depending on your **Transcript output** settings.

If a transcript appears with clickable timecodes, and with speaker labels when diarization is on, Soniox is working.

---

## Troubleshooting

| Symptom                                      | Likely cause and fix                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `401` / `Unauthorized`                       | The key is wrong or belongs to a project in another region. Create a fresh one in the console and store it in the secret linked on **Soniox API key**, and match **Base URL** to the project's region. |
| `402` / balance or budget exhausted          | The project has no balance left or has reached its spending limit. Top it up or raise the limit in the [Soniox console](https://console.soniox.com).                                                   |
| `429` / rate-limit error                     | Too many requests or too many pending transcriptions at once. Wait and retry.                                                                                                                          |
| `Soniox could not transcribe the recording`  | Soniox rejected the audio and says why after the colon, for example a file it cannot decode or one longer than 300 minutes. Convert the file or [split it](../splitting.md).                           |
| `Timed out waiting for Soniox`               | A long recording needs more time than **Request timeout** allows. Raise it (up to 60 minutes).                                                                                                         |
| Words in the dictionary are still misspelled | Context only leans the model toward a term where it fits the sentence. Write the term in the script and spelling people use, and keep the dictionary to the words that matter.                         |
| Connection or network errors                 | Soniox is a cloud engine and needs internet. For fully offline transcription, use [local whisper.cpp](local-whisper-cpp.md).                                                                           |

> **Key privacy.** Your Soniox API key is kept in Obsidian's keychain (**Settings > Keychain**) on this device, not in the plugin's `data.json`, and is never written to diagnostics. The keychain does not sync, so on another device link the key once more under the same ID. Your audio is sent to Soniox for the length of the run and deleted from your account afterwards.

---

## Related guides

- [Transcription](../transcription.md) - engines, diarization, output formats, and destinations.
- [Get a Mistral API key](mistral-api-key.md) and [Get a Deepgram API key](deepgram-api-key.md) - the other engines that diarize a whole file in one request.
- [Transcribe after recording](transcribe-after-recording.md) - run the engine automatically on every new recording.
- [Local whisper.cpp](local-whisper-cpp.md) - fully offline transcription.
