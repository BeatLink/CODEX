# Mascot redesign (for review)

A redesign of the CODEX mascot: a dark "visor" screen with lit eyes and mouth, so the face no longer depends on the
page behind it. The app does not use it: it draws the robot in the theme colour around a black screen, and RoboBuddy draws the eyes
and mouth.

- `mascot.css`: the animated mascot, its rules and its states (asleep, curious, excited, focused, happy, sad, startled,
  thinking, waking, worried). The block between the `generated` markers is written by `shapes.py`.
- `shapes.py`: generates the eye and mouth paths. Run `python3 shapes.py` next to `mascot.css`.
- `preview.html`: every state, with size tests (24 to 72 px, light and dark).
- `styles.html`: the style directions compared, from the current hexagon cut-out (A) to the visor.
- `style-directions.png`, `before-after.png`: screenshots of those two pages.
