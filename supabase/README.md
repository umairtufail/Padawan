# Supabase

Project ref: `reuueppvukwdiytfxezj` (API URL `https://reuueppvukwdiytfxezj.supabase.co`).

The schema is already applied to the project. `migrations/20261003212719_init_padawan_schema.sql` is the exact SQL that was applied, kept here as the record. For a new change, add a new migration file and apply it; do not edit this one.

## What is set up
- **Tables** (all with row-level security): `profiles`, `skills`, `sessions`, `events`, `utterances`, `questions`, `steps_draft`, `learn_attempts`.
- **Profiles** are created automatically at sign-up (trigger on `auth.users`). The display name comes from the login's full name, or the email before the `@`.
- **Access model**
  - The **backend** uses the service-role key, which bypasses RLS, so it must always filter by the user id in code.
  - The **browser** uses the publishable key plus the user's session, so RLS applies. A user reads their own sessions and their children (events, utterances, questions, steps), published skills from anyone, and manages their own skills. Anonymous users get nothing.
- **Storage**: private bucket `keyframes` (the backend uses signed URLs, there are no public or per-user policies).
- **Realtime** is on for `steps_draft` (the live step ticker). RLS applies to it too.
- `sessions.last_screen_summary` holds the previous frame summary the vision model needs (see issue #4).

## Keys and where they go
| Value | Where | Secret? |
|---|---|---|
| Project URL | root `.env` `SUPABASE_URL`, `frontend/.env.local` `NEXT_PUBLIC_SUPABASE_URL` | no |
| Publishable key (`sb_publishable_...`) | `frontend/.env.local` `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no, made for browsers |
| JWKS URL | root `.env` `SUPABASE_JWKS_URL` (`<url>/auth/v1/.well-known/jwks.json`) | no |
| **Service-role key** | root `.env` `SUPABASE_SERVICE_ROLE_KEY`, backend only | **yes, never in the frontend or git** |

The project signs tokens with an asymmetric key (ES256), so the backend verifies logins against the JWKS URL (issue #2).

## Still to do in the dashboard
- Authentication, Providers: enable email magic link and/or Google.
- Authentication, URL configuration: add `http://localhost:3000` and the Vercel URL as redirect URLs.

## Frontend types
```bash
npx supabase login
npx supabase gen types typescript --project-id reuueppvukwdiytfxezj > frontend/lib/database.types.ts
```
