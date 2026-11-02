"""Shared image-verification fixture (no new dependencies).

A deterministic, stdlib-generated PNG: a solid red square on a white
field. Unlike a 1x1 transparent pixel, this is an unambiguous,
well-formed image for any vision endpoint, and the accompanying prompt
asks about visible content so a successful check proves the model
actually received image input — an HTTP 200 alone is never enough.
"""

import struct
import zlib


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    chunk = chunk_type + data
    return (
        len(data).to_bytes(4, "big")
        + chunk
        + (zlib.crc32(chunk) & 0xFFFFFFFF).to_bytes(4, "big")
    )


def build_verify_png(width: int = 96, height: int = 64) -> bytes:
    """Generate a deterministic RGB PNG: white field, solid red square."""
    red = (220, 20, 20)
    white = (255, 255, 255)
    margin_x = width // 4
    margin_y = height // 4
    rows = []
    for y in range(height):
        row = bytearray(b"\x00")
        for x in range(width):
            inside = margin_x <= x < width - margin_x and margin_y <= y < height - margin_y
            row += bytes(red if inside else white)
        rows.append(bytes(row))
    raw = b"".join(rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(raw))
        + _png_chunk(b"IEND", b"")
    )


def build_verify_data_url() -> str:
    """Encode the fixture as a ``data:image/png;base64,`` URL."""
    import base64

    return "data:image/png;base64," + base64.b64encode(build_verify_png()).decode("ascii")


VERIFY_IMAGE_DATA_URL = build_verify_data_url()

VERIFY_PROMPT = (
    "What color is the solid square in this image? "
    "Reply with a single short phrase naming the color."
)


def validate_verify_text(text, provider: str):
    """Require a meaningful non-empty answer; never accept silence."""
    from ..errors import ObservationError

    if not isinstance(text, str) or not text.strip():
        raise ObservationError(f"{provider} returned no text content.")
    if len(text.strip()) < 2:
        raise ObservationError(f"{provider} returned no usable content.")
    return text.strip()
