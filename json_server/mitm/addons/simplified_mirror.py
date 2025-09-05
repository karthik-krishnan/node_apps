# mirror_replay.py
from mitmproxy import http, ctx
from urllib.parse import urlsplit

def load(l):
    ctx.options.add_option(
        "mirror_base", str, "", "Base URL to mirror to, e.g. https://mirror.example.com"
    )
    ctx.options.add_option(
        "mirror_match", str, ".*", "Regex to match which requests to mirror"
    )

def _matches(url: str) -> bool:
    import re
    pat = ctx.options.mirror_match or ".*"
    return bool(re.search(pat, url))

def request(flow: http.HTTPFlow):
    # 1) Skip any replays to avoid infinite loops
    if flow.is_replay == "request":
        return

    # 2) Require mirror_base and a URL match
    base = ctx.options.mirror_base
    if not base or not _matches(flow.request.pretty_url):
        return

    # 3) Parse mirror destination
    u = urlsplit(base)
    if not u.scheme or not u.hostname:
        ctx.log.warn(f"mirror_base is invalid: {base}")
        return

    # 4) Don't mirror our own mirror traffic
    if flow.request.host == u.hostname and flow.request.port == (u.port or (443 if u.scheme == "https" else 80)):
        return

    # 5) Build a copy and retarget
    nf = flow.copy()
    nf.metadata["mirrored"] = True   # marker to skip other addons if needed

    # Either set full URL (if supported)...
    # nf.request.url = base.rstrip("/") + flow.request.path

    # ...or set components explicitly (more portable & explicit)
    nf.request.scheme = u.scheme
    nf.request.host   = u.hostname
    nf.request.port   = u.port or (443 if u.scheme == "https" else 80)

    # Preserve original path+query as-is; optionally prefix a base path
    if u.path and u.path != "/":
        # Ensure one slash between base path and original path
        nf.request.path = u.path.rstrip("/") + flow.request.path
    else:
        nf.request.path = flow.request.path  # includes query

    # 6) Optional: scrub headers you don't want to leak to the mirror
    for h in ["authorization", "cookie", "proxy-authorization"]:
        if h in nf.request.headers:
            del nf.request.headers[h]
    nf.request.headers["X-Mirrored-From"] = flow.request.pretty_url

    # 7) Fire-and-forget replay of the copy
    ctx.master.commands.call("replay.client", [nf])
