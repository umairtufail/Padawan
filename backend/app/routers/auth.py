from fastapi import APIRouter, HTTPException

from ..auth import ADMIN_ID, check_admin_credentials, issue_admin_token
from ..config import settings
from ..schemas import LoginRequest, LoginResponse, LoginUser

router = APIRouter()


@router.post("/auth/login", response_model=LoginResponse)
async def login(body: LoginRequest) -> LoginResponse:
    """Demo login with the hardcoded admin account (ADMIN_USER / ADMIN_PASSWORD)."""
    if settings.auth_mode == "supabase":
        raise HTTPException(404, "admin login is disabled, sign in with Supabase")
    if not check_admin_credentials(body.username, body.password):
        raise HTTPException(401, "invalid credentials")
    token, ttl = issue_admin_token()
    return LoginResponse(access_token=token, expires_in=ttl, user=LoginUser(id=ADMIN_ID, name="Admin"))
