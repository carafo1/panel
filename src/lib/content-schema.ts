/**
 * Content schema for the APSAMO CMS.
 *
 * Defines every editable text string on the public marketing site, organised
 * into labelled groups for the admin "Pages" editor. Each key has a default
 * value (the current hardcoded copy) so the site always renders even when the
 * DB is empty, and the admin editor always shows pre-filled, friendly fields.
 *
 * The schema is consumed by:
 *  - `src/lib/cms.ts`        → merges DB rows over DEFAULT_CONTENT
 *  - `src/components/admin/cms-panel.tsx` → renders the grouped editor
 *  - Public page components   → read via `useSiteContent().getContent(key)`
 */

export type ContentFieldType = 'text' | 'textarea' | 'json'

export interface ContentField {
  /** Stable key, e.g. "home.hero.title". */
  key: string
  /** Human-friendly label shown in the admin editor. */
  label: string
  /** Input type. `textarea` for long copy, `json` for structured arrays. */
  type?: ContentFieldType
  /** Optional help text shown under the field. */
  hint?: string
}

export interface ContentGroup {
  /** Group heading, e.g. "Home Page". */
  group: string
  /** Optional icon name (lucide) for the group header. */
  icon?: string
  /** A short description of what this group covers. */
  description?: string
  /** Ordered list of editable fields in this group. */
  fields: ContentField[]
}

/* ────────────────────────────────────────────────────────────────────────
 * DEFAULT VALUES
 *
 * Every key below MUST exist in DEFAULT_CONTENT. When a page calls
 * `getContent(key)`, it receives either the admin-overridden DB value or
 * this default — never an empty string.
 * ──────────────────────────────────────────────────────────────────────── */

export const DEFAULT_CONTENT: Record<string, string> = {
  // ── Navbar ────────────────────────────────────────────────────────────
  'nav.home': 'Home',
  'nav.services': 'Services',
  'nav.pricing': 'Pricing',
  'nav.about': 'About',
  'nav.contact': 'Contact',
  'nav.allServices': 'All Services',
  'nav.signin': 'Sign In',
  'nav.getStarted': 'Get Started',

  // ── Footer ────────────────────────────────────────────────────────────
  'footer.tagline':
    'Build, host, and scale your entire online presence — web development, hosting, domains, and SaaS in one platform.',
  'footer.copyright': '© 2025 Apsamo Technology. All rights reserved.',
  'footer.col.product': 'Product',
  'footer.col.company': 'Company',
  'footer.col.resources': 'Resources',

  // ── Home: Hero ─────────────────────────────────────────────────────────
  'home.hero.badge': 'Web Development · Hosting · Domains · SaaS',
  'home.hero.title': 'Deploy in Seconds, Scale Without Limits',
  'home.hero.subtitle':
    'From web development and hosting to domain registration and SaaS platforms — Apsamo Technology builds, hosts, and scales your entire online presence.',
  'home.hero.ctaPrimary': 'Start Deploying',
  'home.hero.ctaSecondary': 'Explore Services',
  'home.hero.check1': 'No credit card required',
  'home.hero.check2': 'Free SSL on every plan',
  'home.hero.check3': '99.9% uptime SLA',

  // ── Home: Tech stack marquee ──────────────────────────────────────────
  'home.techStack.label': 'Powered by a modern, battle-tested stack',
  'home.techStack.items':
    'React, Next.js, TypeScript, Node.js, Tailwind, Prisma, Docker, Vercel, AWS, Cloudflare, GitHub, FastAPI',

  // ── Home: Services section ────────────────────────────────────────────
  'home.services.badge': 'Our Services',
  'home.services.title': 'Everything you need to build & grow',
  'home.services.subtitle':
    'Four integrated services, one platform. From your first line of code to global scale.',

  // ── Home: Bento features ──────────────────────────────────────────────
  'home.features.badge': 'Platform Features',
  'home.features.title': 'Everything you need, nothing you don\u2019t',
  'home.features.subtitle':
    'A complete platform with the primitives you need to ship and scale modern web apps.',

  // ── Home: How it works ────────────────────────────────────────────────
  'home.howItWorks.badge': 'How It Works',
  'home.howItWorks.title': 'From code to live in three steps',
  'home.howItWorks.subtitle':
    'Connect, deploy, and scale — Apsamo Technology handles the infrastructure so you can focus on your product.',

  // ── Home: Testimonials ────────────────────────────────────────────────
  'home.testimonials.badge': 'Loved by Developers',
  'home.testimonials.title': 'Trusted by teams shipping fast',

  // ── Home: Pricing preview ─────────────────────────────────────────────
  'home.pricing.badge': 'Pricing',
  'home.pricing.title': 'Simple, transparent pricing',
  'home.pricing.subtitle': 'Start free, scale as you grow. No hidden fees, ever.',

  // ── Home: Final CTA ───────────────────────────────────────────────────
  'home.cta.title': 'Ready to deploy your next big idea?',
  'home.cta.subtitle':
    'Join thousands of developers building on Apsamo Technology. Your first deploy is seconds away.',
  'home.cta.button': 'Start Deploying',

  // ── Services index page ───────────────────────────────────────────────
  'services.hero.badge': 'Our Services',
  'services.hero.title': 'Everything you need to build & grow online',
  'services.hero.subtitle':
    'Four integrated services that take you from idea to global scale — all on one platform.',
  'services.workflow.badge': 'Integrated Workflow',
  'services.workflow.title': 'Four services, one workflow',
  'services.workflow.subtitle':
    'Apsamo Technology services are designed to chain together. Each handoff is automatic — no glue code, no manual config.',
  'services.why.badge': 'Why Apsamo Technology',
  'services.why.title': 'One platform, zero integration headaches',
  'services.why.desc':
    'Every Apsamo Technology service is designed to work together. Buy a domain, get hosting, deploy your app, and scale — all from a single dashboard.',
  'services.why.button': 'View Pricing',
  'services.cta.title': 'Not sure where to start?',
  'services.cta.subtitle':
    'Book a free consultation. We\u2019ll map the right services to your goals and give you a fixed quote.',
  'services.cta.button': 'Talk to an Expert',

  // ── Pricing page ──────────────────────────────────────────────────────
  'pricing.hero.badge': 'Pricing',
  'pricing.hero.title': 'Transparent pricing for every service',
  'pricing.hero.subtitle':
    'Pay only for what you use. No hidden fees, no surprises. Upgrade, downgrade, or cancel anytime.',
  'pricing.custom.title': 'Need a custom plan?',
  'pricing.custom.subtitle':
    'For high-volume or enterprise needs, talk to our team about a tailored solution.',
  'pricing.custom.button': 'Contact Sales',

  // ── About page ────────────────────────────────────────────────────────
  'about.hero.badge': 'About Us',
  'about.hero.title': 'We build the web so you can build your business',
  'about.hero.subtitle':
    'Apsamo Technology was founded by developers, for developers. We believe deploying a website should be as simple as pushing to git.',
  'about.story.title': 'Our story',
  'about.story.p1':
    'Apsamo Technology started with a simple frustration: deploying a web app involved too many tools, too many accounts, and too many points of failure. Domain registrars, DNS providers, hosting platforms, CI/CD pipelines, SSL certificates — each a separate bill, a separate dashboard, a separate headache.',
  'about.story.p2':
    'We set out to build the platform we wished existed: one place to develop, host, register domains, and scale SaaS applications — with automation that handles the boring parts so you can focus on building.',
  'about.story.p3':
    'Today, Apsamo Technology powers tens of thousands of sites across 12 countries, with a 99.9% uptime SLA and a relentless focus on developer experience. But we\u2019re just getting started.',
  'about.values.badge': 'Our Values',
  'about.values.title': 'What we believe',
  'about.mission.title': 'Our mission',
  'about.mission.text':
    'To make the web faster, safer, and more accessible — by giving every developer the infrastructure they need to build something great, without the operational burden.',

  // ── Contact page ──────────────────────────────────────────────────────
  'contact.hero.badge': 'Contact',
  'contact.hero.title': 'Let\u2019s build something great together',
  'contact.hero.subtitle':
    'Have a question, a project, or just want to say hi? We\u2019d love to hear from you.',
  'contact.info.badge': 'Get in touch',
  'contact.info.title': 'We\u2019re here to help',
  'contact.info.desc':
    'Whether you\u2019re evaluating Apsamo Technology for your team, need technical support, or want to explore a partnership — reach out through any channel below.',
  'contact.info.email': 'hello@apsamo.tech',
  'contact.info.emailDesc': 'We reply within 24 hours',
  'contact.info.phone': '+1 (555) 010-2025',
  'contact.info.phoneDesc': 'Mon\u2013Fri, 9am\u20136pm EST',
  'contact.info.office': 'Remote-first, Global',
  'contact.info.officeDesc': 'Team across 12 countries',
  'contact.info.support': '24/7',
  'contact.info.supportDesc': 'Always-on for production issues',
  'contact.form.button': 'Send Message',

  // ── Web Development page ──────────────────────────────────────────────
  'svc.web-development.hero.badge': 'Web Development',
  'svc.web-development.hero.title': 'Custom web apps engineered for performance & scale',
  'svc.web-development.hero.subtitle':
    'From MVP to enterprise — Apsamo Technology builds production-grade web applications with Next.js, TypeScript, and modern infrastructure. Pixel-perfect UI, robust APIs, and observability baked in from day one.',
  'svc.web-development.stack.title': 'A modern, battle-tested stack',
  'svc.web-development.code.title': 'Type-safe, end to end',
  'svc.web-development.process.title': 'From idea to launch in five steps',
  'svc.web-development.capabilities.title': 'Built for real products',
  'svc.web-development.pricing.title': 'Plans for every stage',
  'svc.web-development.faq.title': 'Frequently asked questions',
  'svc.web-development.cta.title': 'Let\u2019s build something remarkable',
  'svc.web-development.cta.button': 'Start a Project',

  // ── Hosting page ──────────────────────────────────────────────────────
  'svc.web-hosting.hero.badge': 'Web Hosting',
  'svc.web-hosting.hero.title': 'Managed hosting that just works',
  'svc.web-hosting.hero.subtitle':
    'Containerized hosting on a global edge network. Push to GitHub \u2192 we build \u2192 we deploy \u2192 we scale. Automatic HTTPS, instant rollbacks, and 99.9% uptime SLA. Stop wrestling with servers and start shipping.',
  'svc.web-hosting.deploy.title': 'From push to production in 30 seconds',
  'svc.web-hosting.features.title': 'Everything included, nothing extra',
  'svc.web-hosting.edge.title': 'Served from 280+ edge locations',
  'svc.web-hosting.pricing.title': 'Scale as you grow',
  'svc.web-hosting.faq.title': 'Frequently asked questions',
  'svc.web-hosting.cta.title': 'Ship your first deploy today',
  'svc.web-hosting.cta.button': 'Deploy Now',

  // ── Domain page ───────────────────────────────────────────────────────
  'svc.domain-registration.hero.badge': 'Domain Registration',
  'svc.domain-registration.hero.title': 'Find & register the perfect domain',
  'svc.domain-registration.hero.subtitle':
    'Search 100+ TLDs with real-time availability and transparent registrar-direct pricing. Free WHOIS privacy, automatic DNS, and one-click transfers — Apsamo Technology is your one-stop domain shop.',
  'svc.domain-registration.pricing.title': 'Transparent pricing for every TLD',
  'svc.domain-registration.features.title': 'Every domain comes fully loaded',
  'svc.domain-registration.lifecycle.title': 'From search to live in four steps',
  'svc.domain-registration.tld.title': 'Pick the right extension',
  'svc.domain-registration.faq.title': 'Frequently asked questions',
  'svc.domain-registration.cta.title': 'Claim your domain today',
  'svc.domain-registration.cta.button': 'Search Domains',

  // ── SaaS System page ──────────────────────────────────────────────────
  'svc.saas-system.hero.badge': 'SaaS System',
  'svc.saas-system.hero.title': 'Full SaaS platforms — done right',
  'svc.saas-system.hero.subtitle':
    'We architect and build complete SaaS platforms: authentication, multi-tenancy, subscription billing, admin dashboards, team management, and audit logs. Skip 6 months of plumbing — launch in weeks.',
  'svc.saas-system.modules.title': 'Every module a SaaS actually needs',
  'svc.saas-system.arch.title': 'A layered, type-safe architecture',
  'svc.saas-system.integrations.title': 'Pre-wired to the tools you need',
  'svc.saas-system.boilerplate.title': 'Skip 6 months of boilerplate',
  'svc.saas-system.pricing.title': 'From MVP to enterprise',
  'svc.saas-system.faq.title': 'Frequently asked questions',
  'svc.saas-system.cta.title': 'Launch your SaaS in weeks, not months',
  'svc.saas-system.cta.button': 'Start Your SaaS',

  // ── Domain search widget ──────────────────────────────────────────────
  'widget.domain.title': 'Find Your Perfect Domain',
  'widget.domain.subtitle': 'Search 100+ TLDs with live availability & instant pricing',
  'widget.domain.sectionTitle': 'Check Domain Availability',
  'widget.domain.sectionSubtitle': 'Real-time search across 100+ TLDs with live wholesale pricing',
}

/* ────────────────────────────────────────────────────────────────────────
 * GROUPED SCHEMA (for the admin editor UI)
 *
 * Drives the rendered fields in the "Pages" tab of the CMS panel. The order
 * here is the order shown to the admin.
 * ──────────────────────────────────────────────────────────────────────── */

export const CONTENT_GROUPS: ContentGroup[] = [
  {
    group: 'Navigation & Footer',
    icon: 'PanelLeft',
    description: 'Labels shown in the navbar and the footer columns.',
    fields: [
      { key: 'nav.home', label: 'Nav: Home' },
      { key: 'nav.services', label: 'Nav: Services' },
      { key: 'nav.pricing', label: 'Nav: Pricing' },
      { key: 'nav.about', label: 'Nav: About' },
      { key: 'nav.contact', label: 'Nav: Contact' },
      { key: 'nav.allServices', label: 'Nav: All Services' },
      { key: 'nav.signin', label: 'Nav: Sign In' },
      { key: 'nav.getStarted', label: 'Nav: Get Started' },
      { key: 'footer.tagline', label: 'Footer tagline', type: 'textarea' },
      { key: 'footer.copyright', label: 'Footer copyright' },
      { key: 'footer.col.product', label: 'Footer: Product column title' },
      { key: 'footer.col.company', label: 'Footer: Company column title' },
      { key: 'footer.col.resources', label: 'Footer: Resources column title' },
    ],
  },
  {
    group: 'Home Page',
    icon: 'Home',
    description: 'Hero, section titles, and CTAs on the landing page.',
    fields: [
      { key: 'home.hero.badge', label: 'Hero badge' },
      { key: 'home.hero.title', label: 'Hero title' },
      { key: 'home.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'home.hero.ctaPrimary', label: 'Hero primary button' },
      { key: 'home.hero.ctaSecondary', label: 'Hero secondary button' },
      { key: 'home.hero.check1', label: 'Hero check 1' },
      { key: 'home.hero.check2', label: 'Hero check 2' },
      { key: 'home.hero.check3', label: 'Hero check 3' },
      { key: 'home.techStack.label', label: 'Tech stack label' },
      { key: 'home.techStack.items', label: 'Tech stack items (comma-separated)', type: 'textarea', hint: 'Comma-separated list of technologies shown in the marquee.' },
      { key: 'home.services.badge', label: 'Services badge' },
      { key: 'home.services.title', label: 'Services title' },
      { key: 'home.services.subtitle', label: 'Services subtitle', type: 'textarea' },
      { key: 'home.features.badge', label: 'Features badge' },
      { key: 'home.features.title', label: 'Features title' },
      { key: 'home.features.subtitle', label: 'Features subtitle', type: 'textarea' },
      { key: 'home.howItWorks.badge', label: 'How it works badge' },
      { key: 'home.howItWorks.title', label: 'How it works title' },
      { key: 'home.howItWorks.subtitle', label: 'How it works subtitle', type: 'textarea' },
      { key: 'home.testimonials.badge', label: 'Testimonials badge' },
      { key: 'home.testimonials.title', label: 'Testimonials title' },
      { key: 'home.pricing.badge', label: 'Pricing badge' },
      { key: 'home.pricing.title', label: 'Pricing title' },
      { key: 'home.pricing.subtitle', label: 'Pricing subtitle', type: 'textarea' },
      { key: 'home.cta.title', label: 'Final CTA title' },
      { key: 'home.cta.subtitle', label: 'Final CTA subtitle', type: 'textarea' },
      { key: 'home.cta.button', label: 'Final CTA button' },
    ],
  },
  {
    group: 'Services Page',
    icon: 'LayoutGrid',
    description: 'The services index page hero, workflow, and CTA sections.',
    fields: [
      { key: 'services.hero.badge', label: 'Hero badge' },
      { key: 'services.hero.title', label: 'Hero title' },
      { key: 'services.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'services.workflow.badge', label: 'Workflow badge' },
      { key: 'services.workflow.title', label: 'Workflow title' },
      { key: 'services.workflow.subtitle', label: 'Workflow subtitle', type: 'textarea' },
      { key: 'services.why.badge', label: 'Why Apsamo Technology badge' },
      { key: 'services.why.title', label: 'Why Apsamo Technology title' },
      { key: 'services.why.desc', label: 'Why Apsamo Technology description', type: 'textarea' },
      { key: 'services.why.button', label: 'Why Apsamo Technology button' },
      { key: 'services.cta.title', label: 'CTA title' },
      { key: 'services.cta.subtitle', label: 'CTA subtitle', type: 'textarea' },
      { key: 'services.cta.button', label: 'CTA button' },
    ],
  },
  {
    group: 'Pricing Page',
    icon: 'CreditCard',
    description: 'Hero and the custom-plan CTA on the pricing page.',
    fields: [
      { key: 'pricing.hero.badge', label: 'Hero badge' },
      { key: 'pricing.hero.title', label: 'Hero title' },
      { key: 'pricing.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'pricing.custom.title', label: 'Custom plan title' },
      { key: 'pricing.custom.subtitle', label: 'Custom plan subtitle', type: 'textarea' },
      { key: 'pricing.custom.button', label: 'Custom plan button' },
    ],
  },
  {
    group: 'About Page',
    icon: 'Info',
    description: 'Hero, story paragraphs, values, and mission.',
    fields: [
      { key: 'about.hero.badge', label: 'Hero badge' },
      { key: 'about.hero.title', label: 'Hero title' },
      { key: 'about.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'about.story.title', label: 'Story heading' },
      { key: 'about.story.p1', label: 'Story paragraph 1', type: 'textarea' },
      { key: 'about.story.p2', label: 'Story paragraph 2', type: 'textarea' },
      { key: 'about.story.p3', label: 'Story paragraph 3', type: 'textarea' },
      { key: 'about.values.badge', label: 'Values badge' },
      { key: 'about.values.title', label: 'Values title' },
      { key: 'about.mission.title', label: 'Mission title' },
      { key: 'about.mission.text', label: 'Mission text', type: 'textarea' },
    ],
  },
  {
    group: 'Contact Page',
    icon: 'Mail',
    description: 'Hero, contact info cards, and form button.',
    fields: [
      { key: 'contact.hero.badge', label: 'Hero badge' },
      { key: 'contact.hero.title', label: 'Hero title' },
      { key: 'contact.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'contact.info.badge', label: 'Info badge' },
      { key: 'contact.info.title', label: 'Info title' },
      { key: 'contact.info.desc', label: 'Info description', type: 'textarea' },
      { key: 'contact.info.email', label: 'Email value' },
      { key: 'contact.info.emailDesc', label: 'Email description' },
      { key: 'contact.info.phone', label: 'Phone value' },
      { key: 'contact.info.phoneDesc', label: 'Phone description' },
      { key: 'contact.info.office', label: 'Office value' },
      { key: 'contact.info.officeDesc', label: 'Office description' },
      { key: 'contact.info.support', label: 'Support value' },
      { key: 'contact.info.supportDesc', label: 'Support description' },
      { key: 'contact.form.button', label: 'Form button' },
    ],
  },
  {
    group: 'Domain Search Widget',
    icon: 'Globe',
    description: 'Title and subtitle of the domain search widget (home + domain page).',
    fields: [
      { key: 'widget.domain.title', label: 'Hero widget title' },
      { key: 'widget.domain.subtitle', label: 'Hero widget subtitle' },
      { key: 'widget.domain.sectionTitle', label: 'Section widget title' },
      { key: 'widget.domain.sectionSubtitle', label: 'Section widget subtitle' },
    ],
  },
  {
    group: 'Web Development Page',
    icon: 'Code2',
    description: 'Hero and section titles for the Web Development service page. Plans, highlights & FAQs are managed in the Services tab.',
    fields: [
      { key: 'svc.web-development.hero.badge', label: 'Hero badge' },
      { key: 'svc.web-development.hero.title', label: 'Hero title' },
      { key: 'svc.web-development.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'svc.web-development.stack.title', label: 'Tech stack title' },
      { key: 'svc.web-development.code.title', label: 'Code showcase title' },
      { key: 'svc.web-development.process.title', label: 'Process title' },
      { key: 'svc.web-development.capabilities.title', label: 'Capabilities title' },
      { key: 'svc.web-development.pricing.title', label: 'Pricing title' },
      { key: 'svc.web-development.faq.title', label: 'FAQ title' },
      { key: 'svc.web-development.cta.title', label: 'CTA title' },
      { key: 'svc.web-development.cta.button', label: 'CTA button' },
    ],
  },
  {
    group: 'Web Hosting Page',
    icon: 'Server',
    description: 'Hero and section titles for the Web Hosting service page.',
    fields: [
      { key: 'svc.web-hosting.hero.badge', label: 'Hero badge' },
      { key: 'svc.web-hosting.hero.title', label: 'Hero title' },
      { key: 'svc.web-hosting.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'svc.web-hosting.deploy.title', label: 'Deploy flow title' },
      { key: 'svc.web-hosting.features.title', label: 'Features title' },
      { key: 'svc.web-hosting.edge.title', label: 'Edge network title' },
      { key: 'svc.web-hosting.pricing.title', label: 'Pricing title' },
      { key: 'svc.web-hosting.faq.title', label: 'FAQ title' },
      { key: 'svc.web-hosting.cta.title', label: 'CTA title' },
      { key: 'svc.web-hosting.cta.button', label: 'CTA button' },
    ],
  },
  {
    group: 'Domain Registration Page',
    icon: 'Globe',
    description: 'Hero and section titles for the Domain Registration service page.',
    fields: [
      { key: 'svc.domain-registration.hero.badge', label: 'Hero badge' },
      { key: 'svc.domain-registration.hero.title', label: 'Hero title' },
      { key: 'svc.domain-registration.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'svc.domain-registration.pricing.title', label: 'TLD pricing title' },
      { key: 'svc.domain-registration.features.title', label: 'Features title' },
      { key: 'svc.domain-registration.lifecycle.title', label: 'Lifecycle title' },
      { key: 'svc.domain-registration.tld.title', label: 'TLD plans title' },
      { key: 'svc.domain-registration.faq.title', label: 'FAQ title' },
      { key: 'svc.domain-registration.cta.title', label: 'CTA title' },
      { key: 'svc.domain-registration.cta.button', label: 'CTA button' },
    ],
  },
  {
    group: 'SaaS System Page',
    icon: 'Boxes',
    description: 'Hero and section titles for the SaaS System service page.',
    fields: [
      { key: 'svc.saas-system.hero.badge', label: 'Hero badge' },
      { key: 'svc.saas-system.hero.title', label: 'Hero title' },
      { key: 'svc.saas-system.hero.subtitle', label: 'Hero subtitle', type: 'textarea' },
      { key: 'svc.saas-system.modules.title', label: 'Modules title' },
      { key: 'svc.saas-system.arch.title', label: 'Architecture title' },
      { key: 'svc.saas-system.integrations.title', label: 'Integrations title' },
      { key: 'svc.saas-system.boilerplate.title', label: 'Boilerplate title' },
      { key: 'svc.saas-system.pricing.title', label: 'Pricing title' },
      { key: 'svc.saas-system.faq.title', label: 'FAQ title' },
      { key: 'svc.saas-system.cta.title', label: 'CTA title' },
      { key: 'svc.saas-system.cta.button', label: 'CTA button' },
    ],
  },
]

/**
 * Flat list of all known content keys (derived from DEFAULT_CONTENT).
 * Used to detect "custom" keys the admin may have added that aren't in the
 * schema (shown in a separate "Custom Keys" section).
 */
export const KNOWN_CONTENT_KEYS: string[] = Object.keys(DEFAULT_CONTENT)
