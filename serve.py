"""Local web server for Lyrics Studio.

Spotify login and the YouTube player need the page to be served from
http://127.0.0.1 (not opened as a file), so this serves this folder there
and opens the browser once the server is ready.

Usage:  python serve.py [port]        (default port 8888)
"""
import http.server
import os
import sys
import threading
import webbrowser

os.chdir(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
port = int(args[0]) if args else 8888


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".html": "text/html; charset=utf-8"}

    def log_message(self, *a):  # keep the window quiet
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


try:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
except OSError:
    print(f"\n  Port {port} is already in use.")
    print("  Close the other program, or run with another port, e.g.  python serve.py 8890")
    print("  (then use that port in your Spotify Redirect URI too)\n")
    sys.exit(1)

url = f"http://127.0.0.1:{port}/"
print(f"\n  Lyrics Studio is running at  {url}")
print("  Keep this window open while you use it. Close it (or press Ctrl+C) to stop.\n")
if "--no-browser" not in sys.argv:
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
