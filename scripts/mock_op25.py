#!/usr/bin/env python3
"""
Mock OP25 HTTP server for local development.
Emulates the endpoints used by op25-web so the UI can be developed
without real hardware or a GNU Radio installation.

Run: python3 scripts/mock_op25.py
Listens on: http://127.0.0.1:8080
"""

import json
import math
import random
import struct
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ── Fake talkgroup pool ───────────────────────────────────────────────────────
TALKGROUPS = [
    (11001, "Fire Dispatch"),
    (11002, "Fire TAC 1"),
    (11003, "Fire TAC 2"),
    (21001, "Police Main"),
    (21002, "Police TAC 1"),
    (21003, "Detective Ops"),
    (31001, "EMS Dispatch"),
    (31002, "EMS TAC"),
    (41001, "Public Works"),
]

# ── Simulated state ───────────────────────────────────────────────────────────
state = {
    "tgid":       11001,
    "tgid_tag":   "Fire Dispatch",
    "call_active": True,
    "du_freq":    851012500,
    "du_nac":     0x293,
    "du_wacn":    0xBEE00,
    "du_sysid":   0x293,
    "src_addr":   1234567,
    "src_tag":    "",
    "pct":        72,
    "ppm":        0.3,
    "rx_sys":     "Demo County P25",
    "phase2_tdma": True,
}

_last_rotate = time.time()


def maybe_rotate():
    """Periodically switch to a different fake talkgroup."""
    global _last_rotate
    if time.time() - _last_rotate > random.uniform(6, 14):
        tgid, tag = random.choice(TALKGROUPS)
        state["tgid"]       = tgid
        state["tgid_tag"]   = tag
        state["src_addr"]   = random.randint(1000000, 9999999)
        state["pct"]        = random.randint(45, 95)
        state["ppm"]        = round(random.uniform(-1.5, 1.5), 2)
        state["call_active"] = True
        _last_rotate = time.time()


def pcm_chunk(num_samples: int = 1600) -> bytes:
    """Generate a chunk of 8kHz mono s16le silence with a faint 1kHz tone."""
    samples = []
    t0 = time.time()
    for i in range(num_samples):
        t = t0 + i / 8000.0
        val = int(2000 * math.sin(2 * math.pi * 1000 * t))
        samples.append(struct.pack("<h", val))
    return b"".join(samples)


# ── HTTP handler ──────────────────────────────────────────────────────────────
class MockOP25Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress per-request noise

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_ok(self):
        self._send_json({"ok": True})

    def do_GET(self):
        path = urlparse(self.path).path
        maybe_rotate()

        if path == "/status.json":
            self._send_json(dict(state))

        elif path == "/talkgroups":
            self._send_json([
                {"tgid": tg, "tag": tag, "active": tg == state["tgid"]}
                for tg, tag in TALKGROUPS
            ])

        elif path == "/feed":
            # Stream 8kHz mono s16le — keeps going until client disconnects
            self.send_response(200)
            self.send_header("Content-Type", "audio/x-raw-signed-int")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                while True:
                    chunk = pcm_chunk(1600)  # 200ms of audio
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    time.sleep(0.18)
            except (BrokenPipeError, ConnectionResetError):
                pass

        elif path in ("/hold", "/skip", "/lockout", "/scan"):
            self._send_ok()

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        # Consume body
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)

        if path in ("/hold", "/skip", "/lockout", "/scan"):
            self._send_ok()
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8080), MockOP25Handler)
    print("Mock OP25 server listening on http://127.0.0.1:8080")
    print("Serving fake P25 status and tone audio for local dev.")
    server.serve_forever()
