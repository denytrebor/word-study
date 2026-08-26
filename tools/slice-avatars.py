"""Slice character avatars out of tools/reference-sheets/ into assets/avatars/.

Each sheet is a 4x6 grid of 24 individually AI-generated characters with REAL
per-pixel alpha transparency, so there is no color-keyed background removal
here at all — the only hard problem is deciding, for each pixel, WHICH
character it belongs to.

    python tools/slice-avatars.py

Requires: pillow, numpy, scipy.

---------------------------------------------------------------------------
WHY THIS IS NOT JUST A GRID CROP
---------------------------------------------------------------------------
Characters overflow their nominal 1/6 x 1/4 cell constantly: raised swords,
staffs, wings, hair, glow auras, and (worst) feet that hang down into the row
below. So a plain grid crop clips characters, and a generously padded crop
drags in pieces of the neighbours — a green sneaker floating over a girl's
cat ear, purple dragon wingtips in another character's flames.

An earlier version tried to fix this per-cell: pad the crop, then erode the
alpha mask by 1px to snap the thin anti-aliased thread joining two characters,
keep the largest connected blob, and dilate back. That works for a hairline
bridge but fails on the real ones. Measured at the cyber-cat-girl /
gamer-headphones-boy boundary, the join is ~13px WIDE, just very FAINT
(alpha 19-67 against the characters' ~250). No amount of 1px erosion breaks a
13px-wide bridge, and eroding hard enough to break it would delete every thin
sword blade on the sheet. A 2026-08-26 audit of all 72 sprites found 9 with
foreign fragments this way, and 0 clipped — the old approach was tuned to
protect against clipping and paid for it in bleed.

---------------------------------------------------------------------------
HOW THIS WORKS INSTEAD
---------------------------------------------------------------------------
The key realisation: a character's own overflow is SOLIDLY connected to it,
while a neighbour's overflow is solidly connected to the NEIGHBOUR. That
relationship is only visible if you look at the entire sheet at once instead
of one padded cell at a time.

  1. SEED on high alpha (> SEED_ALPHA). This is the character's opaque body,
     and it deliberately excludes the faint bridges (max ~67) that merge
     neighbours together. Solid parts stay connected: a sword blade is opaque,
     so it stays attached to the hand holding it.
  2. LABEL those seeds across the WHOLE SHEET, not per cell. Each character
     (plus everything solidly attached, wherever it overflows to) becomes one
     component.
  3. ASSIGN each cell the component with the most pixels inside that cell's
     nominal rect — i.e. the character who actually lives there.
  4. RESOLVE contested soft pixels by nearest seed (a Voronoi split via
     distance_transform_edt with return_indices). Every semi-transparent pixel
     goes to whichever character's solid body is closest. A faint bridge is
     split down the middle: our half stays attached to us, their half leaves
     with them. This is what makes glow/aura survive (it is nearest to its own
     character) while a neighbour's boot does not.

Step 4 is also why the fire-dragon-rider-boy case resolves, where purple wing
pixels from the character below are genuinely interleaved with his own orange
flames inside his cell: they are nearer HER solid body than his, so they go.

DETACHED OWN-PARTS: a floating orb or heart with no opaque link to its owner
becomes its own seed component and would be dropped by step 3. It is re-added
only if its bounding box sits entirely inside the cell (inset by DETACHED_INSET).
A neighbour's intruding boot always crosses the cell edge, so it never
qualifies; a character's own floating prop sits well inside, so it does.
"""

import os
from PIL import Image
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
SHEET_DIR = os.path.join(HERE, "reference-sheets")
DST = os.path.join(HERE, os.pardir, "assets", "avatars")

ROWS, COLS = 4, 6
# Above every measured bridge (max 67) and far below solid body alpha (~250).
SEED_ALPHA = 120
# Anything at or below this is fully transparent and never part of a sprite.
VISIBLE_ALPHA = 10
# A detached component must clear the cell edge by this much to count as ours.
DETACHED_INSET = 6
# Hard bound on how far outside its cell a sprite may reach.
#
# Needed because seed-labelling cannot separate characters whose OPAQUE bodies
# actually touch. Measured on sheet C column 4, the row2/row3 boundary never
# drops below alpha 120 (28+ px still solid at the seam) — cyber-cat-girl and
# soccer-girl are one continuous blob, so both cells picked the merged
# component and produced 493px-tall sprites containing two characters.
#
# Voronoi ownership handles every FAINT bridge; this window is the backstop for
# the genuinely-overlapping case, where geometry is the only separator left.
# 20px comfortably clears real overflow (raised weapons, hair, aura) without
# reaching a neighbour's torso.
WINDOW_MARGIN = 20
# Ignore speckle when picking the owning component / re-adding detached parts.
MIN_COMPONENT_AREA = 120
STRUCT8 = np.ones((3, 3))

SHEETS = {
    "sheet-a-adventure-jobs.png": {
        (0, 0): "paladin-boy", (0, 1): "paladin-girl", (0, 2): "ninja-boy", (0, 3): "ninja-girl",
        (0, 4): "wizard-boy", (0, 5): "witch-girl",
        (1, 0): "astronaut-boy", (1, 1): "astronaut-girl", (1, 2): "robot-buddy",
        (1, 3): "police-boy", (1, 4): "police-girl", (1, 5): "firefighter-boy",
        (2, 0): "safari-boy", (2, 1): "safari-girl", (2, 2): "viking-boy", (2, 3): "viking-girl",
        (2, 4): "samurai-boy", (2, 5): "samurai-girl",
        (3, 0): "pirate-boy", (3, 1): "pirate-girl", (3, 2): "archer-elf-boy", (3, 3): "archer-elf-girl",
        (3, 4): "frost-warrior", (3, 5): "baby-dragon-green",
    },
    "sheet-b-chase-and-hobbies.png": {
        (0, 0): "hoverboard-boy", (0, 1): "skater-girl", (0, 2): "explorer-boy",
        (0, 3): "scientist-girl", (0, 4): "soccer-boy", (0, 5): "wheelchair-girl",
        (1, 0): "painter-girl", (1, 1): "gamer-boy", (1, 2): "baker-girl",
        (1, 3): "musician-boy", (1, 4): "nurse-robot", (1, 5): "martial-artist-girl",
        # rows 2-3 are the "chase" tier — see js/shop-catalog.js
        (2, 0): "angel-knight-boy", (2, 1): "shadow-reaper", (2, 2): "ice-queen-girl",
        (2, 3): "fire-dragon-rider-boy", (2, 4): "mecha-cyber-girl", (2, 5): "elf-druid-girl",
        (3, 0): "space-paladin-boy", (3, 1): "phoenix-rider-girl", (3, 2): "lion-knight-girl",
        (3, 3): "dark-dragon-rider-girl", (3, 4): "cyber-ninja-boy", (3, 5): "angel-priestess-girl",
    },
    "sheet-c-hobbies-and-jobs.png": {
        (0, 0): "basketball-boy", (0, 1): "cheerleader-girl", (0, 2): "cyber-fairy-girl",
        (0, 3): "prince-boy", (0, 4): "robot-heart", (0, 5): "artist-girl",
        (1, 0): "scientist-boy", (1, 1): "doctor-girl", (1, 2): "skater-boy",
        (1, 3): "knight-shield-boy", (1, 4): "gamer-headphones-boy", (1, 5): "forest-girl",
        (2, 0): "pirate-girl-2", (2, 1): "karate-boy", (2, 2): "astronaut-girl-2",
        (2, 3): "green-wizard-boy", (2, 4): "cyber-cat-girl", (2, 5): "football-boy",
        (3, 0): "firefighter-boy-2", (3, 1): "unicorn-onesie-girl", (3, 2): "robot-thumbsup",
        (3, 3): "construction-boy", (3, 4): "soccer-girl", (3, 5): "dragon-rider-blue-boy",
    },
}


def analyze_sheet(path):
    """Returns (image, visible mask, per-pixel owning-seed-label array)."""
    im = Image.open(path).convert("RGBA")
    alpha = np.asarray(im)[:, :, 3]
    visible = alpha > VISIBLE_ALPHA
    seed = alpha > SEED_ALPHA
    labels, _ = ndimage.label(seed, structure=STRUCT8)
    # For every pixel, the label of the nearest seed pixel. Feeding the EDT the
    # complement of the seed makes it walk outward from the seeds, and
    # return_indices hands back the coordinates of the nearest seed pixel.
    _, (iy, ix) = ndimage.distance_transform_edt(labels == 0, return_indices=True)
    owner = labels[iy, ix]
    return im, visible, labels, owner


def cell_mask(labels, owner, visible, y0, y1, x0, x1, has_above, has_below):
    """Pixels in this sheet that belong to the character living in this cell."""
    inside = labels[y0:y1, x0:x1]
    present, counts = np.unique(inside[inside > 0], return_counts=True)
    if len(present) == 0:
        return None
    present, counts = present[counts >= MIN_COMPONENT_AREA], counts[counts >= MIN_COMPONENT_AREA]
    if len(present) == 0:
        return None
    primary = int(present[np.argmax(counts)])

    keep_labels = {primary}
    # Re-add the character's own detached props (floating orb, heart, halo):
    # a component is ours only if it sits wholly inside our cell, which a
    # neighbour's overflowing limb never does.
    for lab in present:
        lab = int(lab)
        if lab == primary:
            continue
        ys, xs = np.where(labels == lab)
        if (ys.min() >= y0 + DETACHED_INSET and ys.max() < y1 - DETACHED_INSET
                and xs.min() >= x0 + DETACHED_INSET and xs.max() < x1 - DETACHED_INSET):
            keep_labels.add(lab)

    mask = visible & np.isin(owner, list(keep_labels))
    # Geometric backstop for opaque-overlap neighbours (see WINDOW_MARGIN).
    window = np.zeros_like(mask)
    h, w = mask.shape
    window[max(0, y0 - WINDOW_MARGIN):min(h, y1 + WINDOW_MARGIN),
           max(0, x0 - WINDOW_MARGIN):min(w, x1 + WINDOW_MARGIN)] = True
    mask = mask & window
    return trim_merged_edges(mask, y0, y1, has_above, has_below)


def trim_merged_edges(mask, y0, y1, has_above, has_below):
    """Cut a merged neighbour off at the narrowest point between the two.

    Only runs when the mask still reaches the far edge of the window, which
    only happens when the neighbour's body is opaquely fused to ours — a
    cleanly separated character has an empty row well before that. In that
    case the fixed WINDOW_MARGIN just relocates the problem (it left a strip
    of cyber-cat-girl's shoes on top of soccer-girl), so instead we look for
    the row where the two are least connected — the natural waist between
    them — and cut there. For a non-merged sprite this row has zero pixels,
    so the cut is a no-op and nothing is ever clipped.
    """
    rows = mask.sum(axis=1)
    h = mask.shape[0]

    if has_above:
        top = max(0, y0 - WINDOW_MARGIN)
        band = rows[top:min(h, y0 + WINDOW_MARGIN)]
        if len(band) and band[0] > 0:
            mask[:top + int(np.argmin(band))] = False

    if has_below:
        bottom = min(h, y1 + WINDOW_MARGIN)
        start = max(0, y1 - WINDOW_MARGIN)
        band = rows[start:bottom]
        if len(band) and band[-1] > 0:
            mask[start + int(np.argmin(band)) + 1:] = False

    return mask


def main():
    os.makedirs(DST, exist_ok=True)
    total = 0
    count = 0
    for sheet_name, cell_ids in SHEETS.items():
        im, visible, labels, owner = analyze_sheet(os.path.join(SHEET_DIR, sheet_name))
        w, h = im.size
        cw, ch = w / COLS, h / ROWS
        rgba = np.asarray(im)
        for (r, c), out_id in sorted(cell_ids.items()):
            y0, y1 = int(r * ch), int((r + 1) * ch)
            x0, x1 = int(c * cw), int((c + 1) * cw)
            mask = cell_mask(labels, owner, visible, y0, y1, x0, x1, r > 0, r < ROWS - 1)
            if mask is None or not mask.any():
                print(f"{out_id:26s} EMPTY — check the cell map for {sheet_name} r{r}c{c}")
                continue
            ys, xs = np.where(mask)
            out = rgba.copy()
            out[:, :, 3] = np.where(mask, out[:, :, 3], 0)
            crop = Image.fromarray(out[ys.min():ys.max() + 1, xs.min():xs.max() + 1], "RGBA")
            path = os.path.join(DST, out_id + ".webp")
            crop.save(path, "WEBP", quality=92, method=6)
            size = os.path.getsize(path)
            total += size
            count += 1
            print(f"{out_id:26s} {crop.size[0]}x{crop.size[1]:<6} {size / 1024:5.1f} KB")
    print(f"TOTAL {total / 1024:.1f} KB across {count} avatars")


if __name__ == "__main__":
    main()
