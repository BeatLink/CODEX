# Open-source text-to-speech for a talking robot face

Which open-source TTS engine sounds most natural, which respond to emotion, and what they cost to run. Gathered 2026-11-05 for the RoboEyes talking mouth. Written from memory, not from fresh searches, so check licences, versions and memory figures before relying on them.

## Recommendation

- **Kokoro** is the best default. It sounds far better than its size suggests, runs on a CPU or in the browser, and is Apache-2.0.
- **Piper** is the pick for small hardware such as a Raspberry Pi.
- **Chatterbox** is the pick when the voice itself must carry emotion, but it needs a GPU with about 8 GB.

## Candidates

- **Kokoro** (82M parameters, Apache-2.0): runs on a CPU or in the browser through `kokoro-js` (ONNX, WebGPU or WASM). Many voices, strongest in English. Works from espeak-ng phonemes and predicts a duration for each one.
- **Piper**: the lightest and fastest. Clear but flatter and more robotic than Kokoro. Newer builds are GPL, and each voice has its own licence. Also works from phonemes.
- **StyleTTS2** (MIT) and **Chatterbox** (MIT): can sound more natural or expressive than Kokoro, but are heavier and want a GPU for real-time use.
- **Orpheus** (Apache): very human and expressive, but large and GPU-bound.
- **F5-TTS and XTTS**: sound very good, but their model weights are non-commercial, so avoid them for anything shipped.
- **Bark and Parler**: older and slower, no longer the best choice.

## Kokoro against Piper

| | Kokoro | Piper |
|---|---|---|
| Naturalness | Better: smoother rhythm and intonation | Clear but flatter |
| Size | About 300 MB at full precision, less quantised | Roughly 15-75 MB per voice |
| Speed | Real time or faster on a CPU, fast on WebGPU | Very fast, even on a Raspberry Pi |
| Browser | Yes, through `kokoro-js` | Possible through ONNX/WASM ports, less polished |
| Languages | Best at English | Many languages and voices |
| Emotion | None beyond voice and speed | None |
| Phonemes and timing | espeak-ng phonemes with predicted durations | espeak-ng phonemes, can report them |

## Emotion control

- **Chatterbox**: an "exaggeration" control makes delivery flatter or more dramatic, and it can clone a voice from a reference clip.
- **Orpheus**: inline tags such as `<laugh>` and `<sigh>`, and it infers tone from the text.
- **Dia** (Apache): dialogue-focused, with non-verbal tags such as laughs and coughs. GPU-hungry.
- **StyleTTS2**: copies the style of a reference clip, so keep one clip per emotion and pick it at speech time.
- **Parler-TTS** (Apache): the voice is described in plain text, such as "sad, slow, quiet". Flexible but less polished.
- **Kokoro and Piper**: no mood control.

## Chatterbox resource needs

- About 0.5B parameters on a Llama-style backbone, with weights of roughly 2-3 GB on disk.
- Reported VRAM use is around 6-8 GB in the default setup.
- On a recent GPU it runs at or faster than real time.
- On a CPU it works but takes several seconds per sentence, too slow for conversation.
- It needs Python and PyTorch with CUDA, so it cannot run in the browser and would sit behind a small local server.
- A smaller "Turbo" variant of around 350M parameters exists; its availability and memory use are unchecked.
- A 4 GB GPU is probably too small for the standard model at full precision.

## Using it with RoboEyes

- Kokoro and Piper both expose phonemes and timing, so either can feed `speakVisemes` with real phonemes and durations instead of the spelling rules guessing both.
- A mood value could drive the eyes, the mouth and the voice together. With Kokoro only the speed and mouth change. With Chatterbox the voice changes as well.
- Suggested path: a browser-only Kokoro demo first, then a Chatterbox server as an optional backend on a machine with enough VRAM.
