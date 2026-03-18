import asyncio
import json
import os
import re
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

OP25_URL       = os.getenv("OP25_URL", "http://127.0.0.1:8080")
WEB_DIR        = Path(__file__).parent.parent / "web"
RECORDINGS_DIR = Path(__file__).parent.parent / "recordings"

ws_clients: list[WebSocket] = []

# Recording state (single active recording)
_rec_proc:  Optional[asyncio.subprocess.Process] = None
_rec_file:  Optional[str]  = None
_rec_start: Optional[float] = None
_rec_lock   = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_broadcast_status())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Squelch", lifespan=lifespan)


async def _broadcast_status():
    """Poll OP25 status every second and push to all connected WebSocket clients."""
    async with httpx.AsyncClient() as client:
        while True:
            if ws_clients:
                try:
                    r = await client.get(f"{OP25_URL}/status.json", timeout=2.0)
                    payload = r.text
                except Exception:
                    payload = json.dumps({"error": "op25_unavailable"})

                dead = []
                for ws in list(ws_clients):
                    try:
                        await ws.send_text(payload)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    ws_clients.remove(ws)

            await asyncio.sleep(1)


# ── OP25 API proxy ────────────────────────────────────────────────────────────

@app.get("/api/status")
async def get_status():
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(f"{OP25_URL}/status.json", timeout=5.0)
            return r.json()
        except Exception:
            raise HTTPException(503, detail="OP25 not available")


@app.get("/api/talkgroups")
async def get_talkgroups():
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(f"{OP25_URL}/talkgroups", timeout=5.0)
            return r.json()
        except Exception:
            raise HTTPException(503, detail="OP25 not available")


@app.post("/api/hold")
async def hold_current():
    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{OP25_URL}/hold", timeout=5.0)
            return {"ok": True}
        except Exception:
            raise HTTPException(503, detail="OP25 not available")


@app.post("/api/hold/{tgid}")
async def hold_talkgroup(tgid: int):
    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{OP25_URL}/hold?tgid={tgid}", timeout=5.0)
            return {"ok": True}
        except Exception:
            raise HTTPException(503, detail="OP25 not available")


@app.post("/api/skip")
async def skip_call():
    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{OP25_URL}/skip", timeout=5.0)
            return {"ok": True}
        except Exception:
            raise HTTPException(503, detail="OP25 not available")


@app.post("/api/lockout")
async def lockout_call():
    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{OP25_URL}/lockout", timeout=5.0)
            return {"ok": True}
        except Exception:
            raise HTTPException(503, detail="OP25 not available")


@app.post("/api/scan")
async def resume_scan():
    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{OP25_URL}/scan", timeout=5.0)
            return {"ok": True}
        except Exception:
            raise HTTPException(503, detail="OP25 not available")


# ── Audio stream ──────────────────────────────────────────────────────────────

@app.get("/stream")
async def audio_stream():
    """
    Pull raw PCM from OP25's /feed (s16le, 8kHz, mono) and transcode
    to MP3 via ffmpeg so iOS Safari can play it natively.
    """
    async def generate():
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-f", "s16le", "-ar", "8000", "-ac", "1",
            "-i", f"{OP25_URL}/feed",
            "-f", "mp3", "-ar", "22050", "-b:a", "32k",
            "-loglevel", "quiet",
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            while True:
                chunk = await proc.stdout.read(4096)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                proc.terminate()
                await proc.wait()
            except ProcessLookupError:
                pass

    return StreamingResponse(
        generate(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Content-Type-Options": "nosniff",
        },
    )


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    ws_clients.append(websocket)
    try:
        # Send current status immediately on connect
        async with httpx.AsyncClient() as client:
            try:
                r = await client.get(f"{OP25_URL}/status.json", timeout=3.0)
                await websocket.send_text(r.text)
            except Exception:
                await websocket.send_text(json.dumps({"error": "op25_unavailable"}))

        while True:
            # Keep socket open; client sends pings
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in ws_clients:
            ws_clients.remove(websocket)


# ── RadioReference lookup ─────────────────────────────────────────────────────

RR_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    "Accept": "text/html,application/xhtml+xml",
}

@app.get("/api/rr/lookup")
async def rr_lookup(url: str):
    """
    Fetch a RadioReference trunking system page and extract:
      - system name
      - NAC (hex)
      - WACN / System ID
      - control channel frequencies (MHz)
    """
    if "radioreference.com" not in url:
        raise HTTPException(400, "URL must be a radioreference.com link")

    async with httpx.AsyncClient(follow_redirects=True, headers=RR_HEADERS) as client:
        try:
            r = await client.get(url, timeout=15.0)
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"RadioReference returned {e.response.status_code}")
        except Exception as e:
            raise HTTPException(502, f"Failed to fetch page: {e}")

    soup = BeautifulSoup(r.text, "lxml")

    # ── System name ───────────────────────────────────────────────────────────
    name = ""
    h1 = soup.find("h1")
    if h1:
        name = h1.get_text(strip=True)
    if not name:
        title = soup.find("title")
        if title:
            name = title.get_text(strip=True).split("|")[0].strip()

    # ── Scrape all table cells for known fields ────────────────────────────────
    nac = ""
    wacn = ""
    sysid = ""
    control_channels: list[str] = []

    # Frequencies: any cell that looks like NNN.NNNN MHz in the 806-869 band
    freq_pattern = re.compile(r'\b(7\d{2}|8[0-6]\d|86[0-9])\.\d{3,4}\b')

    for row in soup.find_all("tr"):
        cells = [td.get_text(" ", strip=True) for td in row.find_all(["td", "th"])]
        if not cells:
            continue
        key = cells[0].lower()

        if "nac" in key and len(cells) > 1:
            m = re.search(r'0x[0-9a-fA-F]+|\b[0-9a-fA-F]{3,4}\b', cells[1])
            if m:
                nac = m.group(0)

        if "wacn" in key and len(cells) > 1:
            m = re.search(r'[0-9a-fA-F]+', cells[1])
            if m:
                wacn = m.group(0)

        if ("system id" in key or "sys id" in key) and len(cells) > 1:
            m = re.search(r'[0-9a-fA-F]+', cells[1])
            if m:
                sysid = m.group(0)

        # Control channel rows typically have "Control Channel" or "CC" in first cell
        if re.search(r'\bcc\b|control.?chan', key, re.I):
            for cell in cells[1:]:
                for m in freq_pattern.finditer(cell):
                    f = m.group(0)
                    if f not in control_channels:
                        control_channels.append(f)

    # Fallback: scrape every frequency on the page that looks like a CC range
    if not control_channels:
        for m in freq_pattern.finditer(r.text):
            f = m.group(0)
            if f not in control_channels:
                control_channels.append(f)
        # Limit fallback to first 20 to avoid pulling voice freqs
        control_channels = control_channels[:20]

    return {
        "name": name,
        "nac": nac,
        "wacn": wacn,
        "sysid": sysid,
        "control_channels": control_channels,
    }


# ── Save config to trunk.tsv ──────────────────────────────────────────────────

class TrunkConfig(BaseModel):
    name: str
    control_channels: list[str]
    nac: Optional[str] = "0"
    wacn: Optional[str] = "0"
    sysid: Optional[str] = "0"


@app.post("/api/config")
async def save_config(cfg: TrunkConfig):
    tsv_path = Path(__file__).parent.parent / "config" / "trunk.tsv"
    tsv_path.parent.mkdir(exist_ok=True)

    # Convert NAC/WACN/SYSID to decimal for OP25.
    # Accepts "0x293" (hex with prefix), "293" (plain decimal), or "293" (bare hex — ambiguous,
    # treated as decimal to match what users typically type).
    def to_dec(val: str) -> str:
        val = val.strip()
        if not val:
            return "0"
        try:
            if val.lower().startswith("0x"):
                return str(int(val, 16))   # explicit hex: 0x293 → 659
            return str(int(val, 10))       # decimal: 659 → 659
        except ValueError:
            return "0"

    nac_dec  = to_dec(cfg.nac)  if cfg.nac  else "0"
    wacn_dec = to_dec(cfg.wacn) if cfg.wacn else "0"
    sys_dec  = to_dec(cfg.sysid) if cfg.sysid else "0"
    freqs    = ",".join(cfg.control_channels)

    header = "Sys Name\tControl Channel List\tOffset\tNAC\tWACN\tSYSID\tSites File\tUnit Id File\tWhitelist\tBlacklist\tCenter Frequency"
    row    = f"{cfg.name}\t{freqs}\t0\t{nac_dec}\t{wacn_dec}\t{sys_dec}"

    tsv_path.write_text(f"{header}\n{row}\n")
    return {"ok": True, "path": str(tsv_path)}


# ── Service status & control ──────────────────────────────────────────────────

_KNOWN_SERVICES = ("op25", "op25-web")


def _svc_status(name: str) -> str:
    try:
        r = subprocess.run(
            ["systemctl", "is-active", name],
            capture_output=True, text=True, timeout=3,
        )
        return r.stdout.strip()          # "active" | "inactive" | "failed" | …
    except Exception:
        return "unknown"


@app.get("/api/services")
async def get_services():
    # Run blocking systemctl calls in thread pool so we don't block the loop
    loop = asyncio.get_running_loop()
    svc_statuses = {}
    for name in _KNOWN_SERVICES:
        svc_statuses[name] = await loop.run_in_executor(None, _svc_status, name)

    # OP25 HTTP API reachable?
    op25_api = False
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(f"{OP25_URL}/status.json", timeout=2.0)
            op25_api = r.status_code < 400
        except Exception:
            pass

    # RTL-SDR USB present? (vendor 0bda, product 2832 or 2838)
    rtlsdr = False
    try:
        lsusb = await loop.run_in_executor(
            None, lambda: subprocess.run(["lsusb"], capture_output=True, text=True, timeout=3)
        )
        rtlsdr = "0bda:2832" in lsusb.stdout or "0bda:2838" in lsusb.stdout
    except Exception:
        pass

    return {
        "services": svc_statuses,
        "op25_api": op25_api,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "rtlsdr": rtlsdr,
        "recording": _rec_file is not None,
        "recording_file": _rec_file,
        "recording_duration": int(time.time() - _rec_start) if _rec_start else 0,
    }


@app.post("/api/services/{name}/restart")
async def restart_service(name: str):
    if name not in _KNOWN_SERVICES:
        raise HTTPException(400, "Unknown service")
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["sudo", "systemctl", "restart", name],
                capture_output=True, text=True, timeout=15,
            ),
        )
        return {"ok": result.returncode == 0, "output": result.stderr.strip()}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Recording ─────────────────────────────────────────────────────────────────

@app.post("/api/record/start")
async def record_start():
    global _rec_proc, _rec_file, _rec_start
    async with _rec_lock:
        if _rec_proc is not None:
            raise HTTPException(400, "Already recording")

    RECORDINGS_DIR.mkdir(exist_ok=True)
    ts       = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"op25_{ts}.mp3"
    filepath = RECORDINGS_DIR / filename

    _rec_proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-f", "s16le", "-ar", "8000", "-ac", "1",
        "-i", f"{OP25_URL}/feed",
        "-f", "mp3", "-ar", "22050", "-b:a", "32k",
        "-loglevel", "quiet",
        str(filepath),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    _rec_file  = filename
    _rec_start = time.time()
    return {"ok": True, "file": filename}


@app.post("/api/record/stop")
async def record_stop():
    global _rec_proc, _rec_file, _rec_start
    async with _rec_lock:
        if _rec_proc is None:
            raise HTTPException(400, "Not recording")

    try:
        _rec_proc.terminate()
        await asyncio.wait_for(_rec_proc.wait(), timeout=5)
    except Exception:
        pass

    saved      = _rec_file
    _rec_proc  = None
    _rec_file  = None
    _rec_start = None
    return {"ok": True, "file": saved}


@app.get("/api/record/list")
async def record_list():
    RECORDINGS_DIR.mkdir(exist_ok=True)
    files = sorted(
        RECORDINGS_DIR.glob("*.mp3"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    return [
        {"name": f.name, "size": f.stat().st_size, "mtime": f.stat().st_mtime}
        for f in files[:30]
    ]


def _safe_recording_path(filename: str) -> Path:
    """Resolve path and confirm it stays inside RECORDINGS_DIR."""
    if not filename or "/" in filename or ".." in filename:
        raise HTTPException(400, "Invalid filename")
    filepath = (RECORDINGS_DIR / filename).resolve()
    if not filepath.is_relative_to(RECORDINGS_DIR.resolve()):
        raise HTTPException(400, "Invalid filename")
    return filepath


@app.get("/api/record/download/{filename}")
async def record_download(filename: str):
    filepath = _safe_recording_path(filename)
    if not filepath.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(filepath, media_type="audio/mpeg", filename=filename)


@app.delete("/api/record/{filename}")
async def record_delete(filename: str):
    filepath = _safe_recording_path(filename)
    try:
        filepath.unlink(missing_ok=True)
    except OSError as e:
        raise HTTPException(500, f"Could not delete file: {e}")
    return {"ok": True}


# ── Static web UI (must be last) ──────────────────────────────────────────────
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="static")
