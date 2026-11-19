"""Serve a synthetic HLS fixture on loopback for the macOS AVFoundation test."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import signal
import subprocess
import tempfile


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def stop(*_):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
with tempfile.TemporaryDirectory() as path:
    directory = Path(path)
    subprocess.run([
        "ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
        "color=c=navy:s=320x180:r=25", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
        "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "50",
        "-sc_threshold", "0", "-c:a", "aac",
        "-hls_time", "2", "-hls_playlist_type", "vod", "fixture.m3u8",
    ], check=True, cwd=directory)
    playlist = directory / "fixture.m3u8"
    tags = [
        '#EXT-X-PROGRAM-DATE-TIME:2026-01-15T12:00:00.000Z',
        '#EXT-X-DATERANGE:ID="super-1",CLASS="com.interactivelayers.overlay",'
        'START-DATE="2026-01-15T12:00:01.000Z",DURATION=3.250,X-IL-FORMAT="super",'
        'X-ASSET-URI="https://media.example/s.png",X-ASSET-MIMETYPE="image/png",'
        'X-IL-IMPRESSION-URI="https://measure.example/i"',
        '#EXT-X-DATERANGE:ID="l-2",CLASS="com.interactivelayers.overlay",'
        'START-DATE="2026-01-15T12:00:06.000Z",END-DATE="2026-01-15T12:00:08.000Z",'
        'X-IL-FORMAT="l",X-ASSET-URI="https://media.example/l.jpg"',
        '#EXT-X-DATERANGE:ID="elsewhere",CLASS="org.example.unrelated",'
        'START-DATE="2026-01-15T12:00:01.000Z",DURATION=3.0,'
        'X-IL-FORMAT="l",X-ASSET-URI="https://media.example/other.png"',
    ]
    content = playlist.read_text().replace("#EXT-X-VERSION:3", "#EXT-X-VERSION:6")
    playlist.write_text(content.replace("#EXTINF:", "\n".join(tags) + "\n#EXTINF:", 1))
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=path))
    print(f"http://127.0.0.1:{server.server_port}/fixture.m3u8", flush=True)
    server.serve_forever()
