import {
  Code2,
  Server,
  Globe,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react'

export interface ServicePlan {
  name: string
  price: number
  period: string
  description: string
  features: string[]
  popular?: boolean
}

export interface ServiceHighlight {
  title: string
  description: string
  icon: LucideIcon
}

export interface ServiceFaq {
  q: string
  a: string
}

export interface Service {
  slug: string
  name: string
  tagline: string
  description: string
  icon: LucideIcon
  /** Tailwind gradient classes, indigo scale only. */
  accent: string
  features: string[]
  plans: ServicePlan[]
  highlights: ServiceHighlight[]
  faqs: ServiceFaq[]
}

export const SERVICES: Service[] = [
  // ────────────────────────────────────────────────────────────────────
  // 1. Web Development
  // ────────────────────────────────────────────────────────────────────
  {
    slug: 'web-development',
    name: 'Web Development',
    tagline: 'Custom web apps engineered for performance, scale, and longevity.',
    description:
      'From MVP to enterprise — APSAMO builds production-grade web applications with Next.js, TypeScript, and modern infrastructure. Pixel-perfect UI, robust APIs, automated CI/CD, and observability baked in from day one.',
    icon: Code2,
    accent: 'from-indigo-500 to-indigo-400',
    features: [
      'Full-stack Next.js + TypeScript architecture',
      'Pixel-perfect, accessible UI with Tailwind + shadcn/ui',
      'Serverless APIs & edge functions',
      'Automated CI/CD pipelines (GitHub Actions)',
      'Real-time features via WebSockets & SSE',
      'Comprehensive observability, logs, and error tracking',
    ],
    plans: [
      {
        name: 'Starter',
        price: 49,
        period: '/project',
        description: 'Perfect for landing pages and small MVPs.',
        features: [
          'Up to 5 pages',
          'Responsive design',
          'Basic SEO setup',
          'Contact form integration',
          '2 rounds of revisions',
          '14-day delivery',
        ],
      },
      {
        name: 'Growth',
        price: 199,
        period: '/project',
        description: 'Full marketing site or interactive web app.',
        features: [
          'Up to 15 pages',
          'CMS integration',
          'Custom animations',
          'Analytics & A/B testing',
          'Unlimited revisions',
          '30-day delivery',
          '90-day support',
        ],
        popular: true,
      },
      {
        name: 'Enterprise',
        price: 299,
        period: '/project',
        description: 'Complex web apps with custom integrations.',
        features: [
          'Unlimited pages',
          'Custom backend & APIs',
          'Third-party integrations',
          'Performance optimization',
          'Dedicated project manager',
          '60-day delivery',
          '1-year priority support',
        ],
      },
    ],
    highlights: [
      {
        title: 'Type-safe end-to-end',
        description: 'Shared TypeScript schemas across front-end, back-end, and database eliminate entire classes of runtime bugs.',
        icon: Code2,
      },
      {
        title: 'Ships in days, not months',
        description: 'Pre-built component library + opinionated stack means we focus on your business logic, not plumbing.',
        icon: LayoutGrid,
      },
      {
        title: 'SEO-optimized',
        description: 'Static generation, structured data, Core Web Vitals in the green — built for organic growth.',
        icon: Globe,
      },
      {
        title: 'Future-proof architecture',
        description: 'Modular, well-tested code that grows with your business — not a rewrite waiting to happen.',
        icon: Server,
      },
    ],
    faqs: [
      {
        q: 'What technologies do you use?',
        a: 'We primarily build with Next.js 16, TypeScript, Tailwind CSS, Prisma, and Postgres. For real-time features we use Socket.io. We can also work with your existing stack if needed.',
      },
      {
        q: 'Do you provide the source code?',
        a: 'Absolutely. You own 100% of the source code, IP, and infrastructure. We deliver everything via your own private GitHub repository.',
      },
      {
        q: 'How long does a typical project take?',
        a: 'Marketing sites ship in 2–3 weeks. Full web apps typically take 4–8 weeks depending on complexity. We give you a fixed timeline before kickoff.',
      },
      {
        q: 'What about ongoing maintenance?',
        a: 'Every plan includes a support window. After that, you can subscribe to our managed hosting plan for continuous updates, monitoring, and bug fixes.',
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 2. Web Hosting
  // ────────────────────────────────────────────────────────────────────
  {
    slug: 'web-hosting',
    name: 'Web Hosting',
    tagline: 'Managed hosting that just works — zero-downtime deploys, auto-SSL, global CDN.',
    description:
      'Containerized hosting on a global edge network. Push to GitHub → we build → we deploy → we scale. Automatic HTTPS, instant rollbacks, real-time logs, and 99.9% uptime SLA. Stop wrestling with servers and start shipping.',
    icon: Server,
    accent: 'from-indigo-950 to-indigo-500',
    features: [
      'Containerized Docker deployments',
      'Automatic SSL via Let\u2019s Encrypt',
      'Global CDN with 280+ edge locations',
      'Zero-downtime rolling deploys',
      'Instant rollbacks (1 click)',
      'Real-time logs, metrics & alerts',
      'Custom domains & wildcard DNS',
    ],
    plans: [
      {
        name: 'Hobby',
        price: 9,
        period: '/mo',
        description: 'For personal projects and side hustles.',
        features: [
          '1 project',
          '1 GB RAM / 1 vCPU',
          '10 GB SSD storage',
          '100 GB bandwidth',
          'Automatic SSL',
          'Community support',
        ],
      },
      {
        name: 'Pro',
        price: 29,
        period: '/mo',
        description: 'For production apps that need to scale.',
        features: [
          '10 projects',
          '4 GB RAM / 2 vCPU',
          '50 GB SSD storage',
          '500 GB bandwidth',
          'Custom domains',
          'Cron jobs & workers',
          'Priority support',
        ],
        popular: true,
      },
      {
        name: 'Business',
        price: 99,
        period: '/mo',
        description: 'For teams running mission-critical workloads.',
        features: [
          'Unlimited projects',
          '16 GB RAM / 8 vCPU',
          '250 GB SSD storage',
          '2 TB bandwidth',
          'Team collaboration',
          'Dedicated IPs',
          '24/7 priority support',
          '99.9% uptime SLA',
        ],
      },
    ],
    highlights: [
      {
        title: 'Deploy in seconds',
        description: 'Connect GitHub, push to main, and watch your site go live in under 30 seconds — every time.',
        icon: Server,
      },
      {
        title: 'Auto SSL, always',
        description: 'Free Let\u2019s Encrypt certificates auto-renewed and auto-installed. Never think about HTTPS again.',
        icon: Globe,
      },
      {
        title: 'Global edge network',
        description: 'Your static assets served from 280+ edge locations worldwide. Sub-50ms TTFB anywhere on earth.',
        icon: LayoutGrid,
      },
      {
        title: 'One-click rollbacks',
        description: 'Every deploy is immutable and versioned. Bad push? Roll back to the last good state in one click.',
        icon: Code2,
      },
    ],
    faqs: [
      {
        q: 'Can I host any Dockerized app?',
        a: 'Yes. If it has a Dockerfile (or we auto-detect Node, Python, Go, Ruby, PHP), we can host it. Bring your compose file or use our templates.',
      },
      {
        q: 'Do you support custom domains?',
        a: 'Yes — every plan supports unlimited custom domains. We auto-provision SSL and configure DNS records for you.',
      },
      {
        q: 'What is your uptime SLA?',
        a: 'Business and Enterprise plans include a 99.9% uptime SLA with service credits if we miss it. Historical uptime is 99.97% over the last 12 months.',
      },
      {
        q: 'Can I scale vertically and horizontally?',
        a: 'Yes. Adjust RAM/CPU per project at any time, and enable autoscaling for stateless web services to handle traffic spikes.',
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 3. Domain Registration
  // ────────────────────────────────────────────────────────────────────
  {
    slug: 'domain-registration',
    name: 'Domain Registration',
    tagline: 'Search 100+ TLDs with real-time availability and instant Dynadot pricing.',
    description:
      'Find, register, renew, and transfer domains in seconds. Real-time availability across 100+ TLDs, transparent Dynadot-powered pricing, automatic DNS, free WHOIS privacy, and one-click transfer. APSAMO is your one-stop domain shop.',
    icon: Globe,
    accent: 'from-indigo-400 to-indigo-600',
    features: [
      'Real-time availability across 100+ TLDs',
      'Live Dynadot-powered pricing',
      'Free WHOIS privacy forever',
      'Automatic DNS management',
      'One-click domain transfers',
      'Auto-renewal & expiry alerts',
      'Bulk search & registration',
    ],
    plans: [
      {
        name: '.com',
        price: 12.99,
        period: '/year',
        description: 'The classic. Perfect for businesses of any size.',
        features: [
          'Free WHOIS privacy',
          'Automatic DNS',
          'Email forwarding',
          'URL forwarding',
          'Auto-renewal available',
        ],
        popular: true,
      },
      {
        name: '.io / .dev',
        price: 39.99,
        period: '/year',
        description: 'Developer-favourite TLDs for tech products.',
        features: [
          'Free WHOIS privacy',
          'Automatic DNS',
          'Email forwarding',
          'URL forwarding',
          'Auto-renewal available',
        ],
      },
      {
        name: '.ai',
        price: 92.1,
        period: '/year',
        description: 'Premium TLD for AI startups & ML products.',
        features: [
          'Free WHOIS privacy',
          'Automatic DNS',
          'Email forwarding',
          'URL forwarding',
          'Auto-renewal available',
          '2-year minimum registration',
        ],
      },
    ],
    highlights: [
      {
        title: 'Real-time availability',
        description: 'We query Dynadot directly — no caching, no stale data. What you see is what you get.',
        icon: Globe,
      },
      {
        title: 'Transparent pricing',
        description: 'Live Dynadot wholesale + small markup. What you see at checkout is what you pay. No hidden fees.',
        icon: Server,
      },
      {
        title: 'Auto DNS & SSL',
        description: 'Connect a domain to your APSAMO-hosted site and we configure DNS + SSL automatically.',
        icon: LayoutGrid,
      },
      {
        title: 'One-click transfers',
        description: 'Bring your domains from any registrar. We handle the auth code, the unlock, and the whole transfer flow.',
        icon: Code2,
      },
    ],
    faqs: [
      {
        q: 'How much does a domain cost?',
        a: 'Pricing varies by TLD. .com starts at $12.99/year, .io at $39.99/year, .ai at $92.10/year. Use the search above to get live pricing for any domain.',
      },
      {
        q: 'Is WHOIS privacy really free?',
        a: 'Yes — every domain registered through APSAMO includes free WHOIS privacy for life. Your personal info never appears in public WHOIS records.',
      },
      {
        q: 'Can I transfer domains from another registrar?',
        a: 'Yes. Just provide the EPP/auth code from your current registrar and unlock the domain. We handle the rest — most transfers complete in 5\u20137 days.',
      },
      {
        q: 'What happens if my domain expires?',
        a: 'We send you multiple expiry alerts and offer auto-renewal. If a domain does expire, there is a grace period during which you can still renew it without losing ownership.',
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 4. SaaS System
  // ────────────────────────────────────────────────────────────────────
  {
    slug: 'saas-system',
    name: 'SaaS System',
    tagline: 'Full SaaS platforms — auth, billing, teams, multi-tenancy, done right.',
    description:
      'We architect and build complete SaaS platforms: authentication, multi-tenancy, subscription billing (Stripe + local methods), admin dashboards, team management, audit logs, and a polished onboarding flow. Skip 6 months of plumbing — launch in weeks.',
    icon: LayoutGrid,
    accent: 'from-indigo-500 to-indigo-950',
    features: [
      'Multi-tenant data architecture',
      'Auth: email + OAuth + 2FA + magic links',
      'Stripe + local payment methods (Waafi, etc.)',
      'Role-based access control (RBAC)',
      'Subscription billing & invoicing',
      'Admin dashboard with full audit logs',
      'Team management & invitations',
      'Onboarding flows & email automation',
    ],
    plans: [
      {
        name: 'MVP',
        price: 99,
        period: '/mo',
        description: 'For founders validating their SaaS idea.',
        features: [
          'Up to 1,000 users',
          'Email + OAuth auth',
          'Single subscription plan',
          'Basic admin dashboard',
          '5 team members',
          'Email support',
        ],
      },
      {
        name: 'Scale',
        price: 199,
        period: '/mo',
        description: 'For SaaS products in active growth.',
        features: [
          'Up to 50,000 users',
          '2FA + magic links',
          'Multiple subscription tiers',
          'Full admin + audit logs',
          'Unlimited team members',
          'Custom integrations',
          'Priority support',
        ],
        popular: true,
      },
      {
        name: 'Enterprise',
        price: 499,
        period: '/mo',
        description: 'For mission-critical SaaS at scale.',
        features: [
          'Unlimited users',
          'SSO / SAML / SCIM',
          'Custom billing & contracts',
          'Dedicated infrastructure',
          'SLA + 24/7 support',
          'Custom compliance (SOC2, HIPAA)',
          'Dedicated success manager',
        ],
      },
    ],
    highlights: [
      {
        title: 'Skip the boilerplate',
        description: 'Auth, billing, teams, audit logs — all the unsexy infrastructure that takes 6 months to build solo. We ship it day one.',
        icon: LayoutGrid,
      },
      {
        title: 'Multi-tenant by default',
        description: 'Row-level security, tenant isolation, and per-tenant config baked in. Add new tenants without a single schema migration.',
        icon: Server,
      },
      {
        title: 'Local + global payments',
        description: 'Stripe for cards + Waafi and other local payment methods for emerging markets. One API, every payment rail.',
        icon: Globe,
      },
      {
        title: 'Compliance-ready',
        description: 'Audit logs, role-based access, data residency options. Built so you can pass SOC2 / HIPAA / ISO 27001 when you need to.',
        icon: Code2,
      },
    ],
    faqs: [
      {
        q: 'Do I own the SaaS codebase?',
        a: 'Yes. You own 100% of the code, infrastructure, and IP. We deliver everything in your private GitHub repo and hand over all credentials.',
      },
      {
        q: 'Can I start with just the MVP and upgrade later?',
        a: 'Of course. The MVP plan gives you a fully working SaaS in weeks. When you outgrow it, upgrading to Scale or Enterprise is a 1-click plan change — no migration needed.',
      },
      {
        q: 'Which payment methods are supported?',
        a: 'Stripe (cards, Apple/Google Pay, Stripe Checkout), plus local methods like Waafi for East Africa. We can integrate additional gateways on request.',
      },
      {
        q: 'Do you handle compliance (SOC2, HIPAA)?',
        a: 'The Enterprise plan includes compliance scaffolding: audit logs, RBAC, data residency. We partner with compliance auditors for the formal certification process if needed.',
      },
    ],
  },
]

export function getServiceBySlug(slug?: string): Service | undefined {
  if (!slug) return undefined
  return SERVICES.find((s) => s.slug === slug)
}
