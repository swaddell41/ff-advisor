"""
Vercel entrypoint: exposes the FastAPI app as an ASGI function.

Vercel's rewrite hands the function the DESTINATION path (/api/index), not
the original request path — so vercel.json encodes the real path into a
__path query param and this shim restores it before FastAPI routes.
"""

import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.main import app as fastapi_app  # noqa: E402


async def app(scope, receive, send):
    if scope["type"] == "http":
        params = parse_qsl(scope.get("query_string", b"").decode(), keep_blank_values=True)
        path = None
        rest = []
        for k, v in params:
            if k == "__path":
                path = v
            else:
                rest.append((k, v))
        if path is not None:
            scope = dict(scope)
            scope["path"] = "/" + path.lstrip("/")
            scope["raw_path"] = scope["path"].encode()
            scope["query_string"] = urlencode(rest).encode()
    await fastapi_app(scope, receive, send)
