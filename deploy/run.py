"""SolutionDeploy entry point. Configuration comes from the protected app.env.

SolutionDeploy asks the app to stop by creating the file named in
SOLUTIONDEPLOY_STOP_FILE; uvicorn then shuts down gracefully.
"""
import logging
import os
import sys
import threading
import time
from pathlib import Path

import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))

server = uvicorn.Server(uvicorn.Config("app.main:app", host="127.0.0.1", port=8791))
stop_file = os.environ.get("SOLUTIONDEPLOY_STOP_FILE")


def watch_stop_file(path: Path) -> None:
    while not server.should_exit:
        if path.exists():
            server.should_exit = True
            return
        time.sleep(1)


if stop_file:
    threading.Thread(target=watch_stop_file, args=(Path(stop_file),), daemon=True).start()
server.run()
