"""Bounded queues for the streaming pipeline (Vision → Script → TTS).

Two queue types, both with backpressure (blocking puts) and cooperative
shutdown (sentinels), so a slow downstream stage slows its producer
instead of growing memory without bound:

- :class:`ObservationQueue`: validated vision observations flowing to
  the script stage (plain FIFO).
- :class:`PrioritySegmentQueue`: worded script utterances flowing to
  TTS (priority order), with app-side supersession: a high-priority
  utterance drops lower-priority utterances still waiting in the queue.
"""

from __future__ import annotations

import heapq
import itertools
import queue
import threading

# Utterance priority: lower sorts first. Event echoes (candidate events)
# outrank developments, which outrank scene/continuity wording.
PRIORITY_HIGH = 0
PRIORITY_NORMAL = 1
PRIORITY_LOW = 2

#: Default bounds. Small on purpose: this is a local desktop app, and a
#: slow stage should apply backpressure quickly, not buffer the video.
DEFAULT_OBSERVATION_QUEUE_SIZE = 16
DEFAULT_SEGMENT_QUEUE_SIZE = 8

#: How long a blocking put/get waits before re-checking the halt flag.
_QUEUE_POLL_S = 0.05


class _Closed(Exception):
    """Raised when a queue operation finds the pipeline halted."""


def utterance_id(seq: int) -> str:
    """Stable streaming id for one worded utterance (``u-0001``, ...)."""
    return f"u-{seq + 1:04d}"


class ObservationQueue:
    """Bounded FIFO of validated observations for the script stage."""

    def __init__(self, maxsize: int = DEFAULT_OBSERVATION_QUEUE_SIZE):
        self._queue: queue.Queue = queue.Queue(maxsize=max(1, maxsize))
        self._halt = threading.Event()

    @property
    def maxsize(self) -> int:
        return self._queue.maxsize

    def halt(self) -> None:
        """Unblock every waiter; the pipeline is shutting down."""
        self._halt.set()

    def put_observation(self, item) -> None:
        """Block until the item fits; raise _Closed when halted."""
        while True:
            if self._halt.is_set():
                raise _Closed()
            try:
                self._queue.put(item, timeout=_QUEUE_POLL_S)
                return
            except queue.Full:
                continue

    def close(self) -> None:
        """Signal end of stream after all observations (sentinel put)."""
        self.put_observation(None)

    def get(self):
        """Return the next item, or None at end of stream; raise _Closed.

        A halted pipeline raises immediately even when items are still
        queued: halt means abnormal shutdown (the worker never
        finalizes after it), so draining would spend paid script
        calls on windows whose utterances are discarded.
        """
        while True:
            if self._halt.is_set():
                raise _Closed()
            try:
                return self._queue.get(timeout=_QUEUE_POLL_S)
            except queue.Empty:
                continue


class PrioritySegmentQueue:
    """Bounded priority queue of utterances awaiting TTS.

    Items are ``(priority, seq, utterance)`` tuples ordered by priority
    then creation order. :meth:`supersede` drops every *waiting* item
    with a numerically larger (less urgent) priority and returns the
    dropped utterances for ledger recording. Items already taken by the
    TTS worker are never recalled: supersession applies at queue
    boundaries only, never to in-flight synthesis.
    """

    def __init__(self, maxsize: int = DEFAULT_SEGMENT_QUEUE_SIZE):
        self._maxsize = max(1, maxsize)
        self._heap: list = []
        self._seq = itertools.count()
        self._condition = threading.Condition()
        self._halt = False
        self._closed = False

    @property
    def maxsize(self) -> int:
        return self._maxsize

    def halt(self) -> None:
        """Unblock every waiter; the pipeline is shutting down."""
        with self._condition:
            self._halt = True
            self._condition.notify_all()

    def put(self, priority: int, utterance: dict) -> int:
        """Block until the utterance fits; return its queue sequence."""
        with self._condition:
            while len(self._heap) >= self._maxsize and not self._halt:
                self._condition.wait(timeout=_QUEUE_POLL_S)
            if self._halt:
                raise _Closed()
            seq = next(self._seq)
            heapq.heappush(self._heap, (priority, seq, utterance))
            self._condition.notify_all()
            return seq

    def supersede(self, priority: int) -> list:
        """Drop waiting items less urgent than ``priority``; return them."""
        with self._condition:
            kept = []
            dropped = []
            for entry in self._heap:
                (dropped if entry[0] > priority else kept).append(entry)
            if dropped:
                self._heap = kept
                heapq.heapify(self._heap)
                self._condition.notify_all()
            return [entry[2] for entry in dropped]

    def close(self) -> None:
        """Signal end of stream after all utterances (sentinel put)."""
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def get(self):
        """Return the most urgent utterance, or None at end of stream.

        A halted pipeline raises immediately even when utterances are
        still queued: halt means abnormal shutdown, so draining would
        spend paid synthesis on audio the cancelled run discards.
        """
        with self._condition:
            while True:
                if self._halt:
                    raise _Closed()
                if self._heap:
                    return heapq.heappop(self._heap)[2]
                if self._closed:
                    return None
                self._condition.wait(timeout=_QUEUE_POLL_S)

    def __len__(self) -> int:
        with self._condition:
            return len(self._heap)
