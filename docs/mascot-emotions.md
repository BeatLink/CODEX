# Mascot emotions

The CODEX icon's robot can show an emotion by animating its eyes, mouth and antenna. Nothing in the UI uses them yet; this page lists what exists and where each emotion could be used.

## What exists

[resources/mascot/mascot.css](../resources/mascot/mascot.css) holds every animation, chosen by the `data-state` attribute on the mascot's `svg`. [resources/mascot/preview.html](../resources/mascot/preview.html) shows all of them side by side and holds the markup to copy into the UI. Open it in a browser; a `replay` button restarts one emotion, and `?t=<milliseconds>` in the address freezes every animation at that time.

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

CODEX is moving from these CSS animations to [RoboEyes](https://github.com/x-tech-laboratories/RoboEyes), which draws the face on a canvas. [resources/mascot/roboeyes.json](../resources/mascot/roboeyes.json) holds the same 11 emotions as RoboEyes moods, with the eye states, mouth states and looks they need. Nothing loads it yet.

RoboEyes has its own moods called `thinking`, `curious`, `happy`, `sad`, `asleep`, `worried`, `startled` and `waking`, and `configure()` merges into a mood rather than replacing it. So empty those names first, then lay the file over them:

```js
import moods from '../../resources/mascot/roboeyes.json' with { type: 'json' };

face.configure({ moods: Object.fromEntries(Object.keys(moods.moods).map((name) => [name, null])) });
face.configure(moods);
face.setMood('calm');
```

How each emotion carries over:

- The antenna pulse and the floating z's have no RoboEyes equivalent, so `thinking` and `asleep` go without them, and so does the worried mouth's wiggle. The head's slow bob is gone too.
- Tilted eyes (sad, worried) become tilted eyelids, and the `^ ^` arches of `happy` are RoboEyes' happy eyelids.
- `startled` pops its eyes with a mood intro, and `waking` flutters them open with one. Setting the mood again while it is in use doesn't replay the intro.
- The moments (`happy`, `sad`, `excited`) can use `face.setMood('happy', { for: 3000 })`, which goes back to the mood underneath afterwards.
- RoboEyes follows `prefers-reduced-motion` on its own, keeping each pose and stopping the movement, as the CSS does.
- The file sets `mouth.moodWidth`, so each mouth state's own length is used. The face's size and proportions (`begin()`, `eyes` and `mouth`) still need choosing to match the icon.

## Checked

Every emotion was viewed in Firefox. It has not been viewed in Electron, whose Chromium also supports the CSS `d` property that morphs the mouths and eyes.
