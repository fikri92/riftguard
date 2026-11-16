#!/usr/bin/env python3
"""Replica of make.fun's dossier-view/v1 contact sheet (contactSheet in
server/judging/dossier-view.ts), so we can see the entry exactly as the house
judge sees it before spending a submission slot.

Geometry from the kit bundle (cli/makefun.mjs):
  SHEET_WIDTH = 768, COVER_BOX = 768x480, GAP = 4, JPEG quality 82, 4:2:0
  sheetCell(n): columns = clamp(n, 2, 4); width = floor((768-(c-1)*4)/c);
                height = floor(width*5/8)
  cover is fitted inside COVER_BOX with withoutEnlargement (never upscaled);
  the rest go in one row of cells beneath, each centred in its cell row.

usage: judgeview.py <screenshots-dir> <out.jpg>
"""
import sys, os
from PIL import Image

GAP = 4
SHEET_WIDTH = 768
COVER_BOX = (768, 480)


def fit(im, box):
    im = im.convert("RGB")
    w, h = im.size
    bw, bh = box
    scale = min(bw / w, bh / h, 1.0)  # withoutEnlargement
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    return im.resize((nw, nh), Image.LANCZOS)


def sheet_cell(others):
    columns = min(max(others, 2), 4)
    width = (SHEET_WIDTH - (columns - 1) * GAP) // columns
    return columns, width, (width * 5) // 8


def main():
    src, out = sys.argv[1], sys.argv[2]
    names = sorted(n for n in os.listdir(src) if n.lower().endswith((".jpg", ".jpeg", ".png")))
    if not names:
        raise SystemExit("no screenshots in " + src)
    imgs = [Image.open(os.path.join(src, n)) for n in names]
    cover = fit(imgs[0], COVER_BOX)
    rest = [fit(i, sheet_cell(len(imgs) - 1)[1:]) if False else i for i in imgs[1:]]
    columns, cw, ch = sheet_cell(len(imgs) - 1)
    rest = [fit(i, (cw, ch)) for i in rest]

    rows = [[cover]]
    row = []
    for f in rest:
        row.append(f)
        if len(row) == columns:
            rows.append(row)
            row = []
    if row:
        rows.append(row)

    def rowwidth(r):
        return sum(f.width for f in r) + (len(r) - 1) * GAP

    width = max(rowwidth(r) for r in rows)
    height = -GAP
    placed = []
    for r in rows:
        rh = max(f.height for f in r)
        left = (width - rowwidth(r)) // 2
        top = height + GAP
        for f in r:
            placed.append((f, left, top + (rh - f.height) // 2))
            left += f.width + GAP
        height = top + rh

    canvas = Image.new("RGB", (width, height), (0, 0, 0))
    for f, l, t in placed:
        canvas.paste(f, (l, t))
    canvas.save(out, "JPEG", quality=82, subsampling=2, optimize=True)
    print(f"sheet {width}x{height} -> {out} ({os.path.getsize(out)} B)")
    for n, (f, l, t) in zip(names, placed):
        print(f"  {n}: {f.width}x{f.height} at {l},{t}")


if __name__ == "__main__":
    main()
