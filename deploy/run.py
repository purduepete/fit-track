"""SolutionDeploy entry point. Configuration comes from the protected app.env."""
import sys
from pathlib import Path

import uvicorn

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))
uvicorn.run("app.main:app", host="127.0.0.1", port=8791)
