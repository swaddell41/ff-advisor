"""
Vercel entrypoint: exposes the FastAPI app as an ASGI function.

The backend package lives in ../backend; Vercel runs this file from the
repo root, so put backend on the path before importing. All /api/* traffic
is rewritten here by vercel.json; the frontend is static files.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.main import app  # noqa: E402,F401
