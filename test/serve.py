#!/usr/bin/env python3
"""
Serve ZID test page on localhost.

Usage:
    python test/serve.py [--port 8888]

Then open http://localhost:8888/test-zid.html in Chrome
(with zafu extension installed).
"""

import http.server
import argparse
import os

def main():
    parser = argparse.ArgumentParser(description="Serve ZID test page")
    parser.add_argument("--port", type=int, default=8888)
    args = parser.parse_args()

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    handler = http.server.SimpleHTTPRequestHandler
    server = http.server.HTTPServer(("localhost", args.port), handler)

    print(f"serving ZID test page at http://localhost:{args.port}/test-zid.html")
    print("press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")

if __name__ == "__main__":
    main()
