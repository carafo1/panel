import { cn } from '@/lib/utils'

/**
 * Hero vector illustration — a floating "deployment dashboard" with orbiting
 * accent chips, rendered as a self-contained SVG so it scales crisply and
 * themes with the brand palette (navy #322D5E, periwinkle #7477DC). Sits on the
 * dark aurora hero background, so surfaces are light/glass with brand accents.
 */
export function HeroIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 560 520"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Illustration of the Apsamo deployment dashboard"
      className={cn('w-full h-auto max-w-[560px]', className)}
    >
      <defs>
        <linearGradient id="hi-lav" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8E8BFF" />
          <stop offset="1" stopColor="#6E6CD0" />
        </linearGradient>
        <linearGradient id="hi-ink" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4A4487" />
          <stop offset="1" stopColor="#322D5E" />
        </linearGradient>
        <linearGradient id="hi-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7477DC" stopOpacity="0.55" />
          <stop offset="1" stopColor="#7477DC" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="hi-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#7477DC" stopOpacity="0.55" />
          <stop offset="1" stopColor="#7477DC" stopOpacity="0" />
        </radialGradient>
        <filter id="hi-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="18" stdDeviation="22" floodColor="#1a1636" floodOpacity="0.45" />
        </filter>
        <filter id="hi-shadow-sm" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="8" stdDeviation="12" floodColor="#1a1636" floodOpacity="0.4" />
        </filter>
      </defs>

      {/* soft brand glow */}
      <ellipse cx="285" cy="255" rx="250" ry="230" fill="url(#hi-glow)" />

      {/* rotating dashed orbit */}
      <g opacity="0.5">
        <ellipse cx="285" cy="260" rx="235" ry="205" stroke="#8888FF" strokeOpacity="0.28" strokeWidth="1.5" strokeDasharray="2 10" fill="none">
          <animateTransform attributeName="transform" type="rotate" from="0 285 260" to="360 285 260" dur="60s" repeatCount="indefinite" />
        </ellipse>
        <ellipse cx="285" cy="260" rx="180" ry="158" stroke="#8888FF" strokeOpacity="0.18" strokeWidth="1.5" fill="none" />
      </g>

      {/* sparkles */}
      <circle cx="70" cy="120" r="3.5" fill="#8888FF" opacity="0.9" />
      <circle cx="500" cy="150" r="2.5" fill="#FFFFFF" opacity="0.8" />
      <circle cx="510" cy="360" r="4" fill="#8888FF" opacity="0.8" />
      <circle cx="60" cy="380" r="2.5" fill="#FFFFFF" opacity="0.7" />
      <circle cx="290" cy="40" r="3" fill="#8888FF" opacity="0.7" />

      {/* ── main dashboard card ───────────────────────────────────────── */}
      <g filter="url(#hi-shadow)">
        <g>
          <animateTransform attributeName="transform" type="translate" values="0 0; 0 -10; 0 0" dur="6s" repeatCount="indefinite" />
          <rect x="128" y="150" width="304" height="222" rx="20" fill="#FFFFFF" />
          <rect x="128" y="150" width="304" height="222" rx="20" fill="url(#hi-ink)" opacity="0.04" />

          {/* window bar */}
          <circle cx="152" cy="176" r="5" fill="#FF6B6B" />
          <circle cx="170" cy="176" r="5" fill="#FFC542" />
          <circle cx="188" cy="176" r="5" fill="#2ECC71" />
          <rect x="300" y="169" width="112" height="15" rx="7.5" fill="#EEEDFB" />
          <rect x="312" y="174" width="8" height="5" rx="2.5" fill="#7477DC" />
          <rect x="326" y="173.5" width="70" height="6" rx="3" fill="#B9B7E6" />

          {/* deploy-success row */}
          <rect x="150" y="204" width="150" height="20" rx="10" fill="#E4F8EE" />
          <circle cx="162" cy="214" r="6" fill="#22C55E" />
          <path d="M159 214 l2.2 2.2 l4-4.3" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <rect x="174" y="210.5" width="86" height="7" rx="3.5" fill="#8FD9B4" />
          <rect x="330" y="205" width="82" height="18" rx="9" fill="url(#hi-lav)" />
          <rect x="341" y="211" width="60" height="6" rx="3" fill="#FFFFFF" opacity="0.85" />

          {/* area chart */}
          <path d="M150 330 L150 300 L182 288 L214 296 L246 272 L278 282 L310 258 L342 266 L374 244 L406 250 L406 330 Z" fill="url(#hi-area)" />
          <path d="M150 300 L182 288 L214 296 L246 272 L278 282 L310 258 L342 266 L374 244 L406 250" stroke="#7477DC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <circle cx="374" cy="244" r="4.5" fill="#322D5E" stroke="#FFFFFF" strokeWidth="2" />

          {/* footer stat pills */}
          <rect x="150" y="344" width="80" height="12" rx="6" fill="#EDEDFA" />
          <rect x="242" y="344" width="60" height="12" rx="6" fill="#EDEDFA" />
        </g>
      </g>

      {/* ── floating chip: Domain ─────────────────────────────────────── */}
      <g filter="url(#hi-shadow-sm)">
        <g transform="translate(58 190)">
          <animateTransform attributeName="transform" type="translate" values="58 190; 58 176; 58 190" dur="5s" repeatCount="indefinite" />
          <rect width="112" height="52" rx="14" fill="#FFFFFF" />
          <circle cx="30" cy="26" r="15" fill="#EEEDFB" />
          <circle cx="30" cy="26" r="9" fill="none" stroke="#7477DC" strokeWidth="1.8" />
          <path d="M21 26 h18 M30 17 a13 13 0 0 1 0 18 a13 13 0 0 1 0 -18" stroke="#7477DC" strokeWidth="1.4" fill="none" />
          <rect x="54" y="18" width="44" height="7" rx="3.5" fill="#322D5E" />
          <rect x="54" y="30" width="30" height="6" rx="3" fill="#C9C7EC" />
        </g>
      </g>

      {/* ── floating chip: SSL lock ───────────────────────────────────── */}
      <g filter="url(#hi-shadow-sm)">
        <g transform="translate(398 116)">
          <animateTransform attributeName="transform" type="translate" values="398 116; 398 104; 398 116" dur="5.6s" repeatCount="indefinite" />
          <rect width="108" height="52" rx="14" fill="#FFFFFF" />
          <rect x="16" y="16" width="28" height="22" rx="6" fill="url(#hi-lav)" />
          <path d="M24 16 v-4 a6 6 0 0 1 12 0 v4" stroke="#322D5E" strokeWidth="2.4" fill="none" />
          <circle cx="30" cy="26" r="3" fill="#FFFFFF" />
          <rect x="54" y="18" width="40" height="7" rx="3.5" fill="#322D5E" />
          <rect x="54" y="30" width="26" height="6" rx="3" fill="#C9C7EC" />
        </g>
      </g>

      {/* ── floating chip: Deploy / uptime ────────────────────────────── */}
      <g filter="url(#hi-shadow-sm)">
        <g transform="translate(392 388)">
          <animateTransform attributeName="transform" type="translate" values="392 388; 392 376; 392 388" dur="6.4s" repeatCount="indefinite" />
          <rect width="128" height="56" rx="16" fill="#322D5E" />
          <circle cx="30" cy="28" r="16" fill="#7477DC" />
          <path d="M30 20 l7 16 l-7 -4 l-7 4 z" fill="#FFFFFF" />
          <rect x="54" y="17" width="58" height="9" rx="4.5" fill="#FFFFFF" />
          <rect x="54" y="32" width="40" height="7" rx="3.5" fill="#8E8BFF" />
        </g>
      </g>

      {/* small node bottom-left */}
      <g filter="url(#hi-shadow-sm)">
        <g transform="translate(96 348)">
          <animateTransform attributeName="transform" type="translate" values="96 348; 96 340; 96 348" dur="5.2s" repeatCount="indefinite" />
          <circle cx="24" cy="24" r="24" fill="#FFFFFF" />
          <path d="M15 24 l6 6 l12 -13" stroke="#22C55E" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>
      </g>
    </svg>
  )
}
