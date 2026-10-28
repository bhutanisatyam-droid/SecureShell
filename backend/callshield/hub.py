"""Fan-out of live events to dashboard WebSocket clients."""

from __future__ import annotations

import asyncio
from typing import Any


class Hub:
    def __init__(self, max_queue: int = 1000):
        self._clients: set[asyncio.Queue] = set()
        self._max = max_queue
        self.dropped = 0

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self._max)
        self._clients.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._clients.discard(q)

    def publish(self, message: dict[str, Any]) -> None:
        for q in list(self._clients):
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                self.dropped += 1
