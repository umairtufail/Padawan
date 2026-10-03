"""Auth dependency.

TODO: verify the Supabase JWT (JWKS) and return its `sub`. For now every request is one dev user so the
frontend and tests can run without a Supabase project.
"""

DEV_USER = "dev-user"


async def current_user() -> str:
    return DEV_USER
