"""Regenerate the home-screen icons.

The 512 doubles as the maskable icon, so its glyph stays inside the 80% safe
circle that Android crops to. Run: python tools/make_icons.py
"""

from PIL import Image, ImageDraw

BLUE = (42, 120, 214, 255)  # --s1, light mode
WHITE = (255, 255, 255, 255)
SS = 4  # supersample factor; the whole thing is drawn 4x then downscaled


def icon(size: int, *, maskable: bool) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        d.rectangle([0, 0, s, s], fill=BLUE)  # full bleed; the crop is Android's
        inset, weight = 0.30, 0.075
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BLUE)
        inset, weight = 0.24, 0.085

    # A four-point upward trend line — the same glyph as the favicon.
    lo, hi = s * inset, s * (1 - inset)
    w = hi - lo
    pts = [
        (lo, hi),
        (lo + w * 0.33, hi - w * 0.42),
        (lo + w * 0.62, hi - w * 0.24),
        (hi, lo),
    ]
    d.line(pts, fill=WHITE, width=int(s * weight), joint="curve")

    # Round the caps by hand; PIL's line joints don't extend to the ends.
    r = s * weight / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)

    return img.resize((size, size), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    icon(180, maskable=False).save("icon-180.png")
    icon(512, maskable=True).save("icon-512.png")
    print("wrote icon-180.png, icon-512.png")
