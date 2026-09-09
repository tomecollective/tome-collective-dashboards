#!/usr/bin/env python3
"""Re-stamp the date line on the NFL preview / recap banners.

Usage:  python3 stamp_banner_date.py <template.png> <YYYY-MM-DD> <out.png> [--font Roboto-Medium.ttf]

The templates (banners/nfl-preview-2026-09-09.png, banners/nfl-recap-2026-09-09.png) carry
"GAME(S) ON SEPTEMBER 09, 2026" in blue at the bottom-left. This erases that line with a
background patch taken from the empty rows just below it and renders the new date in the
same face, size, color, and tracking, left-aligned at the original x.
"""
import sys, argparse
from datetime import date
from PIL import Image, ImageDraw, ImageFont

# Measured from the 2026-09-09 templates (1824x608): text box y 514..530, x starts 512.
TEXT_X, TEXT_TOP, TEXT_BOTTOM = 512, 515, 527
ERASE_BOX = (490, 506, 1080, 540)          # generous box around the old line
PATCH_SRC_Y = 548                          # empty rows below the line, same x range
COLOR = (40, 96, 180)                      # sampled median of the original glyph pixels
FONT_SIZE = 18                             # Roboto Medium: 13px cap height, matches the template
TRACKING = 4.49                            # extra px between glyphs; calibrated so the template string spans x 512..922

def label_for(d: date) -> str:
    return f"GAME(S) ON {d.strftime('%B').upper()} {d.day:02d}, {d.year}"

def draw_tracked(draw, xy, text, font, fill, tracking):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += font.getlength(ch) + tracking
    return x

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('template'); ap.add_argument('date'); ap.add_argument('out')
    ap.add_argument('--font', default='Roboto-Medium.ttf')
    a = ap.parse_args()
    d = date.fromisoformat(a.date)
    im = Image.open(a.template).convert('RGB')
    x0, y0, x1, y1 = ERASE_BOX
    patch = im.crop((x0, PATCH_SRC_Y, x1, PATCH_SRC_Y + (y1 - y0)))
    im.paste(patch, (x0, y0))
    font = ImageFont.truetype(a.font, FONT_SIZE)
    draw = ImageDraw.Draw(im)
    text = label_for(d)
    # Align the cap top to TEXT_TOP: measure the bbox of a capital at y=0.
    cap_top = draw.textbbox((0, 0), 'G', font=font)[1]
    end_x = draw_tracked(draw, (TEXT_X, TEXT_TOP - cap_top), text, font, COLOR, TRACKING)
    im.save(a.out, optimize=True)
    print(f"{a.out}: '{text}' x {TEXT_X}..{int(end_x)}")

if __name__ == '__main__':
    main()
