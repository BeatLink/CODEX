# Mascot emotions

The CODEX icon's robot can show an emotion by animating its eyes, mouth and antenna. Nothing in the UI uses them yet; this page lists what exists and where each emotion could be used.

## What exists

[resources/mascot/mascot.css](../resources/mascot/mascot.css) holds every animation, chosen by the `data-state` attribute on the mascot's `svg`. [resources/mascot/preview.html](../resources/mascot/preview.html) shows all of them side by side and holds the markup to copy into the UI. Open it in a browser; a `replay` button restarts one emotion, and `?t=<milliseconds>` in the address freezes every animation at that time.

The renderer's content security policy allows only stylesheets from the app itself, so the animations are plain CSS keyed by `data-state`, with nothing inline. A reduced-motion setting keeps each pose and stops the movement.

| Emotion | Eyes | Mouth | Extra |
| --- | --- | --- | --- |
| `calm` | Plain, slow blink | Smirk | Gentle breathing |
| `thinking` | Glancing up and from side to side | Wavering line | Antenna pulses |
| `curious` | Wide | Small round "o" | Head tilts |
| `happy` | Arched `^ ^` | Widening smile | Sways, antenna hops |
| `sad` | Drooping and tilted | Trembling frown | A tear falls, head sinks |
| `asleep` | Closed | Slow breathing line | Floating z's, head nods |
| `worried` | Tilted, darting | Fidgeting line | Head shivers |
| `excited` | Big, bulging | Open grin that talks | Hops, ears jiggle, antenna flashes |
| `focused` | Narrowed, scanning | Flat | Leans in |
| `startled` | Wide, trembling | Small round "o" | A jolt on entry |
| `waking` | Open slowly | Yawn, then smirk | Stretch; ends as `calm` |

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

## Checked

Every emotion was viewed in Firefox. It has not been viewed in Electron, whose Chromium also supports the CSS `d` property that morphs the mouths and eyes.
