import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

const SEED_TEMPLATES = [
  {
    name: 'Next.js Starter',
    slug: 'nextjs-starter',
    description:
      'Production-grade Next.js app with TypeScript, Tailwind CSS, and App Router',
    category: 'Framework',
    framework: 'nextjs',
    icon: '▲',
    stars: 4200,
    deployments: 12500,
    features: JSON.stringify([
      'App Router',
      'TypeScript',
      'Tailwind CSS',
      'ESLint',
      'Dark Mode',
    ]),
    tags: JSON.stringify(['nextjs', 'typescript', 'tailwind']),
    previewGradient: 'from-gray-900 to-black',
    author: 'Apsamo Technology',
    repoUrl:
      'https://github.com/vercel/next.js/tree/canary/examples/next-starter',
    isOfficial: true,
  },
  {
    name: 'React SPA',
    slug: 'react-spa',
    description: 'Lightning-fast React development with Vite bundler',
    category: 'Framework',
    framework: 'react',
    icon: '⚡',
    stars: 3100,
    deployments: 8900,
    features: JSON.stringify([
      'Vite',
      'React 18',
      'TypeScript',
      'HMR',
      'ESLint',
    ]),
    tags: JSON.stringify(['react', 'vite', 'typescript']),
    previewGradient: 'from-indigo-400 to-indigo-600',
    author: 'Apsamo Technology',
    repoUrl:
      'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts',
    isOfficial: true,
  },
  {
    name: 'Vue.js App',
    slug: 'vuejs-app',
    description:
      'Progressive Vue.js application with Composition API and Vite',
    category: 'Framework',
    framework: 'vue',
    icon: '💚',
    stars: 2400,
    deployments: 5600,
    features: JSON.stringify([
      'Vue 3',
      'Composition API',
      'Vite',
      'TypeScript',
      'Pinia',
    ]),
    tags: JSON.stringify(['vue', 'vite', 'typescript', 'composition-api']),
    previewGradient: 'from-indigo-500 to-indigo-700',
    author: 'Apsamo Technology',
    repoUrl: 'https://github.com/vuejs/core',
    isOfficial: false,
  },
  {
    name: 'Nuxt.js SSR',
    slug: 'nuxtjs-ssr',
    description:
      'Full-stack Vue.js framework with SSR and file-based routing',
    category: 'Framework',
    framework: 'nuxt',
    icon: '💚',
    stars: 1800,
    deployments: 2900,
    features: JSON.stringify([
      'Nuxt 3',
      'Vue 3',
      'SSR',
      'File Routing',
      'Auto-imports',
    ]),
    tags: JSON.stringify(['nuxt', 'vue', 'ssr', 'typescript']),
    previewGradient: 'from-indigo-400 to-indigo-500',
    author: 'Apsamo Technology',
    repoUrl: 'https://nuxt.com/',
    isOfficial: false,
  },
  {
    name: 'Astro Blog',
    slug: 'astro-blog',
    description: "Lightning-fast blog with Astro's island architecture",
    category: 'Framework',
    framework: 'astro',
    icon: '🚀',
    stars: 2200,
    deployments: 3800,
    features: JSON.stringify([
      'Astro',
      'Markdown',
      'Island Architecture',
      'Fast',
      'SEO',
    ]),
    tags: JSON.stringify(['astro', 'blog', 'static', 'markdown']),
    previewGradient: 'from-indigo-500 to-indigo-700',
    author: 'Apsamo Technology',
    repoUrl: 'https://astro.build/',
    isOfficial: false,
  },
  {
    name: 'SvelteKit App',
    slug: 'sveltekit-app',
    description:
      'Lightweight and fast web apps with SvelteKit and SSR support',
    category: 'Framework',
    framework: 'svelte',
    icon: '🔥',
    stars: 1600,
    deployments: 2400,
    features: JSON.stringify([
      'SvelteKit',
      'SSR',
      'TypeScript',
      'File Routing',
      'Adapter Auto',
    ]),
    tags: JSON.stringify(['svelte', 'sveltekit', 'ssr', 'typescript']),
    previewGradient: 'from-indigo-700 to-indigo-500',
    author: 'Apsamo Technology',
    repoUrl: 'https://kit.svelte.dev/',
    isOfficial: false,
  },
  {
    name: 'Express API',
    slug: 'express-api',
    description:
      'RESTful API server with Express, TypeScript, and Swagger docs',
    category: 'Backend',
    framework: 'express',
    icon: '🟢',
    stars: 2800,
    deployments: 6700,
    features: JSON.stringify([
      'Express',
      'TypeScript',
      'Swagger',
      'Auth Middleware',
      'Rate Limiting',
    ]),
    tags: JSON.stringify(['node', 'express', 'api', 'typescript']),
    previewGradient: 'from-indigo-600 to-indigo-500',
    author: 'Apsamo Technology',
    repoUrl: 'https://github.com/developit/express-es6-rest-api',
    isOfficial: true,
  },
  {
    name: 'FastAPI Backend',
    slug: 'fastapi-backend',
    description:
      'High-performance Python API with FastAPI, Pydantic, and auto-docs',
    category: 'Backend',
    framework: 'fastapi',
    icon: '🐍',
    stars: 2600,
    deployments: 5200,
    features: JSON.stringify([
      'FastAPI',
      'Pydantic',
      'Auto Docs',
      'Async',
      'Type Hints',
    ]),
    tags: JSON.stringify(['python', 'fastapi', 'api', 'pydantic']),
    previewGradient: 'from-indigo-500 to-indigo-400',
    author: 'Apsamo Technology',
    repoUrl: 'https://fastapi.tiangolo.com/',
    isOfficial: true,
  },
  {
    name: 'Static HTML',
    slug: 'static-html',
    description:
      'Beautiful static landing page with animations and responsive design',
    category: 'Static',
    framework: 'static',
    icon: '🎨',
    stars: 1900,
    deployments: 4500,
    features: JSON.stringify([
      'Responsive',
      'Animations',
      'SEO Optimized',
      'Fast Load',
      'Accessible',
    ]),
    tags: JSON.stringify(['static', 'landing', 'html', 'css']),
    previewGradient: 'from-indigo-600 to-indigo-500',
    author: 'Apsamo Technology',
    repoUrl: 'https://github.com/tbakerx/react-resume-template',
    isOfficial: false,
  },
  {
    name: 'Gatsby Blog',
    slug: 'gatsby-blog',
    description:
      'Blazing-fast blog powered by Gatsby with GraphQL and React',
    category: 'Static',
    framework: 'gatsby',
    icon: '💜',
    stars: 1500,
    deployments: 3200,
    features: JSON.stringify([
      'Gatsby',
      'GraphQL',
      'React',
      'Markdown',
      'Image Optimization',
    ]),
    tags: JSON.stringify(['gatsby', 'blog', 'react', 'graphql']),
    previewGradient: 'from-indigo-700 to-indigo-400',
    author: 'Apsamo Technology',
    repoUrl: 'https://www.gatsbyjs.com/',
    isOfficial: false,
  },
  {
    name: 'WordPress',
    slug: 'wordpress',
    description:
      'Self-hosted WordPress with custom themes and plugins support',
    category: 'CMS',
    framework: 'node',
    icon: '📝',
    stars: 5200,
    deployments: 15000,
    features: JSON.stringify([
      'WordPress 6.x',
      'Custom Themes',
      'Plugin Support',
      'MySQL',
      'SSL',
    ]),
    tags: JSON.stringify(['wordpress', 'cms', 'php', 'blog']),
    previewGradient: 'from-indigo-600 to-indigo-800',
    author: 'Apsamo Technology',
    repoUrl: 'https://wordpress.org/',
    isOfficial: true,
  },
  {
    name: 'Go Microservice',
    slug: 'go-microservice',
    description:
      'Lightweight Go microservice with gRPC and REST endpoints',
    category: 'Backend',
    framework: 'go',
    icon: '🔵',
    stars: 1400,
    deployments: 2100,
    features: JSON.stringify([
      'Go 1.21',
      'gRPC',
      'REST API',
      'Docker',
      'Health Checks',
    ]),
    tags: JSON.stringify(['go', 'microservice', 'grpc', 'api']),
    previewGradient: 'from-indigo-500 to-indigo-400',
    author: 'Apsamo Technology',
    repoUrl: 'https://go.dev/',
    isOfficial: false,
  },
]

export async function POST() {
  try {
    let created = 0
    let skipped = 0

    for (const tpl of SEED_TEMPLATES) {
      const existing = await db.template.findUnique({
        where: { slug: tpl.slug },
      })

      if (existing) {
        // Update existing template with latest data
        await db.template.update({
          where: { slug: tpl.slug },
          data: {
            name: tpl.name,
            description: tpl.description,
            category: tpl.category,
            framework: tpl.framework,
            icon: tpl.icon,
            stars: tpl.stars,
            deployments: tpl.deployments,
            features: tpl.features,
            tags: tpl.tags,
            previewGradient: tpl.previewGradient,
            author: tpl.author,
            repoUrl: tpl.repoUrl,
            isOfficial: tpl.isOfficial,
          },
        })
        skipped++
      } else {
        await db.template.create({ data: tpl })
        created++
      }
    }

    const total = await db.template.count()

    return NextResponse.json({
      message: 'Templates seeded successfully',
      created,
      updated: skipped,
      total,
    })
  } catch (error) {
    console.error('Seed templates error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
