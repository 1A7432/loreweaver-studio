#!/usr/bin/env python3
"""Generate the placeholder app icon (1024x1024 RGBA PNG) at assets/icon.png.

Pure stdlib so it runs anywhere; rerun after tweaking, then refresh the
platform icon set with `bun tauri icon assets/icon.png`.
"""

import os
import struct
import zlib

SIZE = 1024
HALF = SIZE / 2

BG = (22, 21, 34, 255)  # dark field
VIOLET = (139, 127, 245, 255)  # accent diamond
MIST = (230, 227, 240, 255)  # center spark
CLEAR = (0, 0, 0, 0)

FIELD_HALF = 448  # half-extent of the rounded-square field
CORNER_R = 120


def inside_field(cx: float, cy: float) -> bool:
    ax, ay = abs(cx), abs(cy)
    if ax > FIELD_HALF or ay > FIELD_HALF:
        return False
    edge = FIELD_HALF - CORNER_R
    if ax > edge and ay > edge:
        return (ax - edge) ** 2 + (ay - edge) ** 2 <= CORNER_R**2
    return True


def pixel(x: int, y: int) -> tuple[int, int, int, int]:
    cx, cy = x - HALF + 0.5, y - HALF + 0.5
    if not inside_field(cx, cy):
        return CLEAR
    d = abs(cx) + abs(cy)  # diamond (L1) metric
    if 236 <= d <= 300:
        return VIOLET
    if d <= 88:
        return MIST if d <= 56 else VIOLET
    return BG


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def main() -> None:
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)  # filter: none
        for x in range(SIZE):
            rows += bytes(pixel(x, y))
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )
    out = os.path.join(os.path.dirname(__file__), "..", "assets", "icon.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as fh:
        fh.write(png)
    print(f"wrote {os.path.normpath(out)} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
