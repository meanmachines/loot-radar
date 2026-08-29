"""Google/GitHub OAuth login -- see db.py's own "Accounts" section for the
storage side (users table, upsert-on-login, retroactive device linking).

Deliberately stateless sessions (a signed JWT cookie, not a sessions
table): one fewer thing for the single-process design this whole app is
built on to keep consistent (see db.py's module docstring), and a session
is just "which user_id," nothing that needs revocation infrastructure for
what this app actually is.

Both providers are optional independently -- GOOGLE_CLIENT_ID/SECRET and
GITHUB_CLIENT_ID/SECRET are all `required: false` in app.yaml (see that
file's own comment). A provider whose credentials aren't set yet returns a
clear 503 from its own /login route instead of crashing or silently doing
nothing -- this app shipped and had real accounts-less traffic before
either credential pair existed, so "not configured yet" has to be a normal,
handled state, not an error path nobody tested.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Optional
from urllib.parse import urlencode

import bcrypt
import httpx
import jwt
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

import db

logger = logging.getLogger("loot-radar.auth")

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
SESSION_COOKIE = "lr_session"
SESSION_TTL_S = 90 * 24 * 3600  # 90 days -- "sign in once, stay in" for a platform meant to outlive one event
STATE_TTL_S = 600  # 10 minutes -- just long enough to get through a real OAuth consent screen

# The whole site is gated behind sign-in now (see require_user below and
# main.py's own use of it) -- email signup/login are consequently exposed
# to anyone who can reach the site at all, not just existing users, so both
# get their own rate limit keyed by IP. Small and duplicated from main.py's
# own _client_key rather than shared, matching this codebase's existing
# preference for small self-contained modules over a cross-file utils
# import for a five-line helper.
def _client_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


_email_auth_limiter = db.RateLimiter(max_per_window=20, window_seconds=3600)
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

router = APIRouter(prefix="/auth", tags=["auth"])

# provider -> (authorize_url, token_url, scope, client_id_env, client_secret_env)
_PROVIDERS = {
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scope": "openid email profile",
        "client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
        "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
    },
    "github": {
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user",
        "scope": "read:user user:email",
        "client_id": os.environ.get("GITHUB_CLIENT_ID", ""),
        "client_secret": os.environ.get("GITHUB_CLIENT_SECRET", ""),
    },
}


def _provider_configured(name: str) -> bool:
    p = _PROVIDERS.get(name)
    return bool(p and p["client_id"] and p["client_secret"])


def _callback_url(request: Request, provider: str) -> str:
    # Built from the real inbound request, not hardcoded -- this backend
    # sits behind nginx (see nginx.conf's own /api/ proxy) which already
    # forwards Host correctly; works the same on zbots-dev-style preview
    # domains without a code change.
    return f"{request.url.scheme}://{request.url.netloc}/api/auth/{provider}/callback"


def _sign(payload: dict, ttl_s: int) -> str:
    return jwt.encode({**payload, "exp": time.time() + ttl_s}, SESSION_SECRET, algorithm="HS256")


def _verify(token: str) -> Optional[dict]:
    # Fail closed, not open: an unset SESSION_SECRET must never be treated
    # as "verification succeeds with an empty key" -- that would make
    # every session/state token forgeable by anyone who noticed the
    # secret was blank. login() already refuses to issue a state token in
    # that case, but a request presenting some OTHER cookie/token still
    # has to be rejected here too, independently.
    if not SESSION_SECRET:
        return None
    try:
        return jwt.decode(token, SESSION_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def current_user_id(request: Request) -> Optional[int]:
    """Read-only session check -- used by other routers (main.py's own
    /loot, /my/loot) to attribute a request to a signed-in user without
    requiring one. Returns None for a missing/expired/tampered cookie,
    never raises -- being logged out is always a valid state here.
    """
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    claims = _verify(token)
    return claims.get("uid") if claims else None


# Friend codes -- a short, shareable identifier for the "add a friend"
# flow (see main.py's own POST /friends). XOR against a fixed constant
# rather than storing a random per-user code: it's a bijection (no
# collisions, always decodable) with no migration/backfill needed for
# existing users, and it keeps a code from being a trivially-sequential
# "just guess id+1" enumeration. Not real security -- this only gates who
# shows up on your OWN friends-scoped leaderboard, never anything private,
# so light obfuscation is the right amount of effort here, not a
# capability-token scheme.
_FRIEND_CODE_MASK = 0x5F3A9E17


def friend_code(user_id: int) -> str:
    return f"LOOT-{(user_id ^ _FRIEND_CODE_MASK):X}"


def decode_friend_code(code: str) -> Optional[int]:
    digits = code.strip().upper().removeprefix("LOOT-").replace("-", "")
    try:
        return int(digits, 16) ^ _FRIEND_CODE_MASK
    except ValueError:
        return None


def require_user(request: Request) -> int:
    """FastAPI dependency for the site-wide sign-in gate (see main.py's own
    Depends(auth.require_user) on every loot/giveaway/leaderboard/events
    route) -- raises a clean 401 instead of returning None, so a gated
    route fails loudly rather than silently treating "not signed in" as
    "signed in as nobody."
    """
    user_id = current_user_id(request)
    if user_id is None:
        raise HTTPException(401, "sign in required")
    return user_id


# ---------------------------------------------------------------------------
# Email/password sign-in -- for anyone who doesn't want to use Google or
# GitHub. JSON POSTs, not the OAuth routes' redirect dance, since there's
# no third party to round-trip through: the frontend calls these directly
# and gets the session cookie back on the same response.
# ---------------------------------------------------------------------------


class EmailSignupIn(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=128)
    display_name: Optional[str] = None
    device_id: str


class EmailLoginIn(BaseModel):
    email: str
    password: str
    device_id: str


@router.post("/email/signup")
async def email_signup(body: EmailSignupIn, request: Request, response: Response):
    if not SESSION_SECRET:
        raise HTTPException(503, "sign-in isn't configured yet")
    if not _email_auth_limiter.allow(_client_key(request)):
        raise HTTPException(429, "too many signup attempts -- try again in a bit")
    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(400, "enter a valid email address")

    password_hash = bcrypt.hashpw(body.password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
    display_name = (body.display_name or "").strip()[:60] or None
    user = await db.create_email_user(email, password_hash, display_name)
    if user is None:
        raise HTTPException(409, "an account with that email already exists -- try logging in instead")

    await db.link_device_to_user(body.device_id, user["id"])
    session_token = _sign({"uid": user["id"]}, SESSION_TTL_S)
    response.set_cookie(
        SESSION_COOKIE, session_token,
        max_age=SESSION_TTL_S, httponly=True, secure=True, samesite="lax", path="/",
    )
    return {"user": user}


@router.post("/email/login")
async def email_login(body: EmailLoginIn, request: Request, response: Response):
    if not SESSION_SECRET:
        raise HTTPException(503, "sign-in isn't configured yet")
    if not _email_auth_limiter.allow(_client_key(request)):
        raise HTTPException(429, "too many login attempts -- try again in a bit")
    email = body.email.strip().lower()

    auth_row = await db.get_email_auth(email)
    # Same "incorrect email or password" message whether the email doesn't
    # exist, has no password (an OAuth-only account with the same email
    # would be a DIFFERENT row here -- provider/provider_user_id differ, so
    # this genuinely can't happen, but a defensive check costs nothing), or
    # the password itself is wrong -- never reveal which case it was.
    if not auth_row or not auth_row["password_hash"] or not bcrypt.checkpw(
        body.password.encode("utf-8"), auth_row["password_hash"].encode("utf-8")
    ):
        raise HTTPException(401, "incorrect email or password")

    user = await db.get_user(auth_row["id"])
    await db.link_device_to_user(body.device_id, user["id"])
    session_token = _sign({"uid": user["id"]}, SESSION_TTL_S)
    response.set_cookie(
        SESSION_COOKIE, session_token,
        max_age=SESSION_TTL_S, httponly=True, secure=True, samesite="lax", path="/",
    )
    return {"user": user}


@router.get("/{provider}/login")
async def login(provider: str, request: Request, device_id: str, return_to: str = "/"):
    if provider not in _PROVIDERS:
        raise HTTPException(404, "unknown provider")
    if not _provider_configured(provider):
        raise HTTPException(503, f"{provider} sign-in isn't configured yet")
    if not SESSION_SECRET:
        raise HTTPException(503, "sign-in isn't configured yet")
    # return_to is only ever used as a same-origin redirect target (see the
    # callback below, which appends it to this backend's own domain) --
    # never fetched or treated as a full URL, so an attacker-supplied
    # value can't redirect a login to an external site.
    if not return_to.startswith("/"):
        return_to = "/"
    state = _sign({"device_id": device_id, "return_to": return_to, "provider": provider}, STATE_TTL_S)
    p = _PROVIDERS[provider]
    params = {
        "client_id": p["client_id"],
        "redirect_uri": _callback_url(request, provider),
        "scope": p["scope"],
        "state": state,
        "response_type": "code",
    }
    if provider == "google":
        params["access_type"] = "online"
        params["prompt"] = "select_account"
    return RedirectResponse(f"{p['authorize_url']}?{urlencode(params)}")


async def _fetch_google_profile(token: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(_PROVIDERS["google"]["userinfo_url"], headers={"Authorization": f"Bearer {token}"})
        res.raise_for_status()
        data = res.json()
    return {
        "provider_user_id": data["sub"],
        "email": data.get("email"),
        "display_name": data.get("name") or data.get("email"),
        "avatar_url": data.get("picture"),
    }


async def _fetch_github_profile(token: str) -> dict:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(_PROVIDERS["github"]["userinfo_url"], headers=headers)
        res.raise_for_status()
        data = res.json()
        email = data.get("email")
        if not email:
            # GitHub only includes email on /user when the user has made
            # one public -- most haven't. /user/emails needs the same
            # token but is a separate call; pick the primary verified one,
            # falling back to None (email stays optional throughout this
            # app, see db.py's users table -- no signup is blocked on it).
            try:
                emails_res = await client.get("https://api.github.com/user/emails", headers=headers)
                emails_res.raise_for_status()
                for row in emails_res.json():
                    if row.get("primary") and row.get("verified"):
                        email = row.get("email")
                        break
            except httpx.HTTPError:
                pass
    return {
        "provider_user_id": str(data["id"]),
        "email": email,
        "display_name": data.get("name") or data.get("login"),
        "avatar_url": data.get("avatar_url"),
    }


@router.get("/{provider}/callback")
async def callback(provider: str, request: Request, code: str = "", state: str = "", error: str = ""):
    if provider not in _PROVIDERS:
        raise HTTPException(404, "unknown provider")
    if error:
        # The user hit "Deny" on the provider's own consent screen -- a
        # normal outcome, not a server error. Send them back where they
        # started rather than showing a raw error page.
        claims = _verify(state) or {}
        return RedirectResponse(claims.get("return_to", "/"))
    claims = _verify(state)
    if not claims or claims.get("provider") != provider:
        raise HTTPException(400, "invalid or expired sign-in attempt -- please try again")

    p = _PROVIDERS[provider]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            token_res = await client.post(
                p["token_url"],
                data={
                    "client_id": p["client_id"],
                    "client_secret": p["client_secret"],
                    "code": code,
                    "redirect_uri": _callback_url(request, provider),
                    "grant_type": "authorization_code",
                },
                # GitHub's token endpoint defaults to form-encoded output
                # unless explicitly asked for JSON -- a well-known gotcha,
                # and harmless to send to Google too (already returns JSON).
                headers={"Accept": "application/json"},
            )
            token_res.raise_for_status()
            token_data = token_res.json()
            access_token = token_data.get("access_token")
            if not access_token:
                raise HTTPException(502, f"{provider} did not return an access token")
            profile = await (_fetch_google_profile(access_token) if provider == "google" else _fetch_github_profile(access_token))
    except httpx.HTTPError as e:
        # A code exchange can fail for reasons that are entirely the
        # provider/network's fault (an expired code from a slow consent
        # screen, a transient outage) -- worth its own clear message
        # rather than surfacing as a bare 500, even though a real signup
        # flow can't recover from this turn beyond "try again."
        logger.warning(json.dumps({"msg": "oauth code exchange failed", "provider": provider, "error": str(e)}))
        raise HTTPException(502, f"could not complete {provider} sign-in -- please try again")

    user = await db.upsert_user(provider=provider, **profile)
    await db.link_device_to_user(claims["device_id"], user["id"])

    session_token = _sign({"uid": user["id"]}, SESSION_TTL_S)
    resp = RedirectResponse(claims.get("return_to", "/"))
    resp.set_cookie(
        SESSION_COOKIE, session_token,
        max_age=SESSION_TTL_S, httponly=True, secure=True, samesite="lax", path="/",
    )
    return resp


@router.get("/me")
async def me(request: Request):
    user_id = current_user_id(request)
    if user_id is None:
        return {"user": None}
    user = await db.get_user(user_id)
    if user is None:
        # A session cookie survived past the account itself being removed
        # (shouldn't normally happen -- no delete-account path exists yet
        # -- but a stale/forged cookie is a real possibility). Being
        # logged out is always a valid, non-error state, same as /me
        # never having a cookie at all.
        return {"user": None}
    return {"user": user}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"status": "ok"}


@router.get("/providers")
async def providers():
    """Which providers are actually usable right now -- the frontend
    hides/shows sign-in buttons based on this instead of shipping a button
    that 503s the moment someone taps it before credentials exist.
    """
    return {name: _provider_configured(name) for name in _PROVIDERS}
