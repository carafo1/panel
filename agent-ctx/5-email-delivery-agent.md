---
Task ID: 5
Agent: Email Delivery Agent
Task: Integrate real email delivery into auth and team routes

# What was done

Wired the Wave 1 email service (`src/lib/email.ts`) into the four auth/team
flows that previously only `console.log`-ed the verification / reset / invite
links.

## Files changed

### Backend (API routes)

1. **`src/app/api/auth/register/route.ts`**
   - Imports `sendWelcomeEmail` from `@/lib/email`.
   - Builds `verificationUrl = ${NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}?verify_token=${token}`.
   - Calls `await sendWelcomeEmail(user.email, user.name, verificationUrl)`.
   - Keeps the existing `console.log` lines for dev visibility.
   - **Security fix**: no longer returns a JWT or the verification token.
     Returns only `{ message: "Registration successful. Check your email for verification link." }`.
   - Removed the unused `generateToken` import and JWT generation block.

2. **`src/app/api/auth/forgot-password/route.ts`**
   - Imports `sendPasswordResetEmail` from `@/lib/email`.
   - Builds `resetUrl = ${NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}?reset_token=${token}`.
   - Calls `await sendPasswordResetEmail(user.email, resetUrl)`.
   - **Security fix**: no longer returns the reset token. Always returns
     `{ message: "If an account with that email exists, a reset link has been sent." }`
     (same message for existing vs non-existing users to prevent email enumeration).

3. **`src/app/api/auth/resend-verification/route.ts`**
   - Imports `sendWelcomeEmail` from `@/lib/email`.
   - Calls `sendWelcomeEmail(user.email, user.name, verificationUrl)` with the freshly
     generated token. Existing console.log + notification kept.

4. **`src/app/api/teams/[teamId]/members/route.ts`** (POST)
   - Imports `sendTeamInvitationEmail` and `crypto`.
   - After the existing TeamMember.create (preserved), generates an invite token
     (`sha256(memberId:teamId:timestamp)`) and builds
     `inviteUrl = ${NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}?team_invite=${inviteToken}`.
   - Calls `await sendTeamInvitationEmail(targetUser.email, team.name, inviteUrl)`.
   - Existing member creation + in-app notification logic untouched.

### Frontend

5. **`src/store/auth-store.ts`**
   - `register` signature changed to `Promise<{ message: string }>`.
   - Removed `get().setAuth(data.user, data.token)` (no longer returned by API).
   - The user is NOT auto-logged-in after registration; they must verify their
     email and sign in normally.

6. **`src/components/auth/auth-modal.tsx`**
   - Added `CheckCircle2` icon import.
   - New `registerSuccess` state.
   - `handleRegister`: on success sets `registerSuccess=true` and shows a toast
     "Account created! Check your email to verify." (modal stays open).
   - Register form now conditionally renders a success card
     ("Check your email for verification") with the registered email,
     a "Continue to sign in" button, and a "try a different email" link,
     instead of the form fields.
   - `handleForgotPassword`: always clears `forgotToken` and sets `forgotSuccess=true`.
   - Removed the entire "Reset Token Generated" demo block from the forgot-password
     form (it used to expose the token in the UI).
   - Forgot-password success card now reads "Check your email" with the entered
     email and a button "I have my token - reset password" that switches to the
     reset-password mode (user pastes the token from their email).
   - Header subtitle for forgot-password changed from
     "Enter your email to receive a reset token" to
     "Enter your email to receive a reset link".

## Behavioural notes

- In **demo mode** (no `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`),
  `sendEmail()` logs to the server console and returns `{ success: true, demo: true }`,
  so the rest of the flow keeps working. Developers can read the verification /
  reset / invite URLs from the dev server log.
- In **production mode** (SMTP env vars set), real emails are sent via nodemailer.
- Security: verification tokens, reset tokens, and invite tokens are NEVER
  returned in API JSON responses. They only travel via email (or dev console).
- Registration is now a two-step flow: register -> verify email via link -> sign in.
  This is a deliberate UX change required by the security fix (no auto-login).
- Login route (`/api/auth/login`) and reset-password route (`/api/auth/reset-password`)
  were NOT modified - they continue to work as before.

## Verification

- Did NOT run `bun run lint` or `bun run build` (per task instructions).
- Tail of `dev.log` shows continued `200 OK` responses on `/` with no compile
  errors after every edit.
EOF
