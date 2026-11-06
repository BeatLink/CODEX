# Mascot emotions

The CODEX icon's robot can show an emotion by animating its eyes, mouth and antenna. This page is the research behind the mascot; what was built is in doc 2, "Mascot emotions".

## What exists

The first version was a CSS-only mascot (`resources/mascot/mascot.css` and `preview.html`, since removed; see git history), with every animation chosen by the `data-state` attribute on the mascot's `svg`.

The renderer's content security policy allows only stylesheets from the app itself, so the animations are plain CSS keyed by `data-state`, with nothing inline. A reduced-motion setting keeps each pose and stops the movement.

| Emotion | Eyes | Mouth | Extra |
| --- | --- | --- | --- |
| `calm` | Plain, slow blink | Smirk, as in the icon | |
| `thinking` | Glancing up and from side to side | Flat | Antenna pulses gently |
| `curious` | Slightly wide, glancing up | Flat | |
| `happy` | Thin arches `^ ^` | Faint smile | |
| `sad` | Drooping and slightly tilted | Faint frown | |
| `asleep` | Closed lines | Short flat | Floating z's |
| `worried` | Slightly tilted, darting | Wiggly line | |
| `excited` | Slightly big, bouncing quickly | Flat | |
| `focused` | Narrowed, scanning | Flat | |
| `startled` | Slightly wide | Flat | Eyes pop wider once on entry |
| `waking` | Open slowly from lines | Smirk | Ends as `calm` |

Only one head movement exists, a slow vertical bob, and it is the same in every emotion. Eyes are drawn with a rounded outline, so any eye that blinks or is nearly closed becomes a line.

`startled` and `waking` play their opening once and then hold, so they suit a short moment before moving on to another emotion.

## Potential use cases

These are suggestions, not decisions. The state they would read from is in `src/renderer/runState.ts`.

| Emotion | Possible use | State to read |
| --- | --- | --- |
| `calm` | Connected with nothing running | `connection: 'connected'` and not `running` |
| `thinking` | A run is in progress | `running` |
| `curious` | CODEX asks a question or wants approval | `clarifications` not empty |
| `happy` | A run finished successfully | A run ends with status `Complete` |
| `sad` | A run failed, or an error notification appears | A `notify` effect with `error` |
| `asleep` | The daemon is suspended and has freed the GPU | `suspended` |
| `worried` | The daemon is unreachable | `connection: 'unavailable'` |
| `excited` | A final answer arrives, or a task starts | `phase: 'final'`, or a new run |
| `focused` | Background research is working | `backgroundStatus` is not `Idle` |
| `startled` | The user cancels a run | `cancelling` |
| `waking` | Resuming from suspend, or connecting at launch | `suspended` turns false, or `connection: 'connecting'` |

Some of these would need decisions first:

- **Priority.** Several states can hold at once, for example a run in progress while background research works. Pick an order, for example `worried`, `asleep`, `startled`, `curious`, `thinking`, `focused`, `calm`.
- **Moments versus states.** `happy`, `sad` and `excited` fit a few seconds after an event better than a lasting state, so the UI would fall back to `calm` after a delay.
- **Other places.** The tray icon is a still image, so only a single pose could be exported for it. The animations suit the window's top bar, an empty workbench, or the place where an answer will appear.

## RoboEyes

CODEX now draws only the icon's hexagon with a black robot head, and [RoboEyes](https://github.com/x-tech-laboratories/RoboEyes) draws the eyes and mouth over the head exactly as it ships. The emotions above became RoboEyes' own moods chosen by state, in [src/renderer/mascot.ts](../../src/renderer/mascot.ts): `worried`, `asleep`, `thinking` and `default`, with `happy` or `sad` briefly when a run ends. The antenna pulse, z's, head bob and the other emotions are not carried over.

## Checked

Viewed in Electron with a stand-in daemon, in the light and dark themes; the white face reads on the black head in both.
