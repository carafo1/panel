// Ambient module declarations so side-effect CSS imports (import "./globals.css")
// pass the Next.js build type-check. Added 2026-07-24 to unblock the production build.
declare module '*.css';
declare module '*.scss';
declare module '*.sass';
