"""Generates the eye and mouth shapes for mascot.css.

Run `python3 shapes.py` next to mascot.css: it rewrites the block between the "generated" markers.

Eyes follow the model shared by RoboEyes, esp32-eyes and Irisoled: one filled rounded square,
with emotion coming only from covering parts of it.
  - h, oy:        height and vertical offset (energy and mood: short or low reads tired, sad, happy)
  - tilt_top:     the straight top lid; positive drops the INNER corner (determined), negative the OUTER (sad, worried)
  - tilt_bottom:  the same for the bottom edge
  - r_top, r_bot: corner radius; a lidded edge goes sharp, an open edge keeps the round corner
  - curve_bot:    the rounded bottom lid of happy eyes; positive bows the bottom edge up into a crescent
  - w:            width, which only grows for surprise
Values are for the LEFT eye; the right eye is its mirror image.

Every eye and every mouth is drawn with the same number of curve segments, so CSS can morph any pose into any other.
"""
import math

BASE = dict(w=6.5, h=6.5, oy=0, tilt_top=0, tilt_bottom=0, r_top=1.8, r_bot=1.8, curve_bot=0)

EYES = {
    'calm':     {},
    'thinking': dict(h=5.4, oy=0.55, r_top=0.9),
    'focused':  dict(h=3.4, oy=1.55, tilt_top=0.7, r_top=0.4, r_bot=1.2),
    'curious':  dict(w=6.8, h=7.3, oy=-0.4, r_top=2, r_bot=2),        # left eye only; right uses calm
    'happy':    dict(h=3.4, oy=-1.5, r_top=1.7, r_bot=0.3, curve_bot=0.9),
    'excited':  dict(w=6.9, h=4.2, oy=-1.9, r_top=1.9, r_bot=0.3, curve_bot=1.1),
    'sad':      dict(h=3.8, oy=1.9, tilt_top=-1.4, r_top=0.4, r_bot=1.6),
    'worried':  dict(h=5.6, oy=0.45, tilt_top=-0.9, r_top=0.6, r_bot=1.8),
    'startled': dict(w=7.3, h=7.3, r_top=2.3, r_bot=2.3),
    'asleep':   dict(h=1.1, oy=2.6, tilt_top=-0.4, tilt_bottom=-0.4, r_top=0.5, r_bot=0.5),
}

K = 0.552  # cubic handle length for a quarter circle


def fmt(*points):
    return ' '.join(f'{x:.2f} {y:.2f}' for x, y in points)


def straight(a, b):
    """A straight edge written as a cubic, so it can morph into a curve."""
    return (a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3), (a[0] + 2 * (b[0] - a[0]) / 3, a[1] + 2 * (b[1] - a[1]) / 3), b


def eye_path(p, mirror=False):
    w, h, oy = p['w'], p['h'], p['oy']
    r_t, r_b = p['r_top'], p['r_bot']
    if r_t + r_b > h:  # keep the corners from overlapping on short eyes
        r_t, r_b = r_t * h / (r_t + r_b), r_b * h / (r_t + r_b)
    xo, xi = -w / 2, w / 2                      # outer and inner sides of the left eye
    yt_o, yt_i = oy - h / 2 - p['tilt_top'] / 2, oy - h / 2 + p['tilt_top'] / 2
    yb_o, yb_i = oy + h / 2 - p['tilt_bottom'] / 2, oy + h / 2 + p['tilt_bottom'] / 2
    st, sb = (yt_i - yt_o) / w, (yb_i - yb_o) / w

    top_a, top_b = (xo + r_t, yt_o + st * r_t), (xi - r_t, yt_i - st * r_t)
    right_a, right_b = (xi, yt_i + r_t), (xi, yb_i - r_b)
    bot_a, bot_b = (xi - r_b, yb_i - sb * r_b), (xo + r_b, yb_o + sb * r_b)
    left_a, left_b = (xo, yb_o - r_b), (xo, yt_o + r_t)

    c = p['curve_bot'] * 4 / 3
    bottom = ((bot_a[0] + (bot_b[0] - bot_a[0]) / 3, bot_a[1] + (bot_b[1] - bot_a[1]) / 3 - c),
              (bot_a[0] + 2 * (bot_b[0] - bot_a[0]) / 3, bot_a[1] + 2 * (bot_b[1] - bot_a[1]) / 3 - c), bot_b)

    segs = [
        straight(top_a, top_b),
        ((top_b[0] + K * r_t, top_b[1] + K * r_t * st), (right_a[0], right_a[1] - K * r_t), right_a),
        straight(right_a, right_b),
        ((right_b[0], right_b[1] + K * r_b), (bot_a[0] + K * r_b, bot_a[1] + K * r_b * sb), bot_a),
        bottom,
        ((bot_b[0] - K * r_b, bot_b[1] - K * r_b * sb), (left_a[0], left_a[1] + K * r_b), left_a),
        straight(left_a, left_b),
        ((left_b[0], left_b[1] - K * r_t), (top_a[0] - K * r_t, top_a[1] - K * r_t * st), top_a),
    ]
    if mirror:
        flip = lambda pt: (-pt[0], pt[1])
        top_a = flip(top_a)
        segs = [tuple(flip(pt) for pt in seg) for seg in segs]
    return 'path("M' + fmt(top_a) + ''.join('C' + fmt(*seg) for seg in segs) + 'Z")'


# Mouths: a filled, lit bar like the eyes, centred on x 32. It can change length (`len`), curl each end
# up or down (`left`, `right`, negative is up), open downward into a rounded shape (`open`), or shrink to
# nothing (`none`, which CSS also fades out). Same eight segments every time.
MOUTH_BASE = dict(len=10, y=41.9, left=0, right=0, thick=1.3, open=0)

MOUTHS = {
    'smirk':  dict(len=8, left=-0.8),                             # calm: one end up
    'dash':   dict(len=5),                                        # thinking: short and neutral
    'flat':   dict(len=6.5),                                      # focused
    'smile':  dict(len=10, left=-0.9, right=-0.9),                # happy: widest
    'grin':   dict(len=8, y=41.1, thick=0.9, open=2),                 # excited: an open smile
    'frown':  dict(len=7, left=0.8, right=0.8),                   # sad: shorter and down
    'uneasy': dict(len=7, left=0.8, right=-0.8),                  # worried: one end down, one up
    'o':      dict(len=3, y=41.2, thick=1.2, open=1.3),           # startled: small open mouth
    'small-o': dict(len=2.2, y=41.5, thick=0.9, open=0.9),        # curious: smaller still
    'none':   dict(len=0.2, thick=0.2),                           # asleep: shrinks away (and fades in CSS)
}


def mouth_path(p):
    x0, x1, y, t = 32 - p['len'] / 2, 32 + p['len'] / 2, p['y'], p['thick']
    curl = (x1 - x0) * 0.3
    yl, yr = y + p['left'], y + p['right']

    def open_edge(top, depth):
        # An open mouth's lower edge is half an ellipse, drawn as three arcs of 60 degrees each.
        cx, rx, k = (x0 + x1) / 2, (x1 - x0) / 2, 4 / 3 * math.tan(math.pi / 12)
        point = lambda a: (cx + rx * math.cos(a), top + depth * math.sin(a))
        slope = lambda a: (-rx * math.sin(a), depth * math.cos(a))
        angles = [math.pi, 2 * math.pi / 3, math.pi / 3, 0]
        segs = []
        for a1, a2 in zip(angles, angles[1:]):
            p1, p2, d1, d2 = point(a1), point(a2), slope(a1), slope(a2)
            segs.append(((p1[0] - k * d1[0], p1[1] - k * d1[1]), (p2[0] + k * d2[0], p2[1] + k * d2[1]), p2))
        return point(math.pi), segs

    def edge(dy, sag):
        a, b = (x0, yl + dy), (x0 + curl, y + dy)
        c, d = (x1 - curl, y + dy), (x1, yr + dy)
        return a, [
            ((a[0] + curl * 0.2, a[1] + 0.78 * (b[1] - a[1])), (a[0] + curl * 0.53, b[1]), b),
            ((b[0] + (c[0] - b[0]) / 3, b[1] + sag), (b[0] + 2 * (c[0] - b[0]) / 3, c[1] + sag), c),
            ((d[0] - curl * 0.53, c[1]), (d[0] - curl * 0.2, d[1] + 0.78 * (c[1] - d[1])), d),
        ]

    up_start, upper = edge(-t / 2, 0)
    low_start, lower = edge(t / 2, 0) if not p['open'] else open_edge(yl + t / 2, p['open'])
    starts = [low_start] + [seg[2] for seg in lower[:-1]]
    lower_back = [(seg[1], seg[0], start) for seg, start in zip(reversed(lower), reversed(starts))]
    h = K * 1.33 * t / 2
    cap_r = ((upper[-1][2][0] + h, upper[-1][2][1]), (lower[-1][2][0] + h, lower[-1][2][1]), lower[-1][2])
    cap_l = ((low_start[0] - h, low_start[1]), (up_start[0] - h, up_start[1]), up_start)
    segs = upper + [cap_r] + lower_back + [cap_l]
    return 'path("M' + fmt(up_start) + ''.join('C' + fmt(*seg) for seg in segs) + 'Z")'


def generated_block():
    lines = []
    for name, over in EYES.items():
        p = {**BASE, **over}
        lines.append(f'    --eye-{name}-l: {eye_path(p)};')
        lines.append(f'    --eye-{name}-r: {eye_path(p, mirror=True)};')
    for name, over in MOUTHS.items():
        lines.append(f'    --mouth-{name}: {mouth_path({**MOUTH_BASE, **over})};')
    return '\n'.join(lines)


if __name__ == '__main__':
    import pathlib, re
    css_file = pathlib.Path(__file__).with_name('mascot.css')
    css = css_file.read_text()
    start, end = '/* generated:start (shapes.py) */', '    /* generated:end */'
    css, found = re.subn(re.escape(start) + '.*?' + re.escape(end), lambda m: start + '\n' + generated_block() + '\n' + end, css, flags=re.S)
    assert found == 1, 'generated markers not found in mascot.css'
    css_file.write_text(css)
    print('updated', css_file)
