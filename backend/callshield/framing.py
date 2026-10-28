"""Binary media framing: [uint32 big-endian header length][JSON envelope][raw media bytes]."""

import json
import struct

MAX_HEADER_BYTES = 16 * 1024


class FrameError(ValueError):
    pass


def encode(header: dict, payload: bytes) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(h)) + h + payload


def decode(frame: bytes) -> tuple[dict, bytes]:
    if len(frame) < 4:
        raise FrameError("frame shorter than length prefix")
    (n,) = struct.unpack(">I", frame[:4])
    if n == 0 or n > MAX_HEADER_BYTES or 4 + n > len(frame):
        raise FrameError(f"bad header length {n}")
    try:
        header = json.loads(frame[4:4 + n].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise FrameError(f"bad header json: {e}") from e
    if not isinstance(header, dict):
        raise FrameError("header is not an object")
    return header, frame[4 + n:]
