/**
 * GET /api/docs
 * Returns the OpenAPI 3.0 specification for the Domain Reseller Module.
 * Renders as Swagger UI at /api/docs (HTML) or JSON at /api/docs?format=json.
 */
import { NextResponse } from 'next/server'
import { SUPPORT_EMAIL } from '@/lib/brand-config'

const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Apsamo Technology Domain Reseller API',
    version: '1.0.0',
    description:
      'Production-ready domain management system powered by the Dynadot Reseller API. ' +
      'Supports complete domain lifecycle: search, register, renew, transfer, DNS, nameservers, ' +
      'WHOIS privacy, registrar lock, EPP auth codes, auto-renew, pricing with $6.50 markup, ' +
      'invoices, and full audit logging.',
    contact: { name: 'Apsamo Technology', email: SUPPORT_EMAIL },
  },
  servers: [{ url: '/', description: 'Current host' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token or API key (dh_ prefix) via Authorization: Bearer <token>',
      },
    },
    schemas: {
      Envelope: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          data: {},
          errors: { type: 'array', items: { type: 'object' } },
          timestamp: { type: 'string', format: 'date-time' },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      DomainSearchResult: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          available: { type: 'boolean' },
          premium: { type: 'boolean' },
          registrationPrice: { type: 'number' },
          renewalPrice: { type: 'number' },
          transferPrice: { type: 'number' },
          currency: { type: 'string' },
        },
      },
      Domain: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'active', 'expired', 'transferring', 'suspended', 'deleted'] },
          registrar: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
          autoRenew: { type: 'boolean' },
          whoisPrivacy: { type: 'boolean' },
          locked: { type: 'boolean' },
          premium: { type: 'boolean' },
        },
      },
      DomainPrice: {
        type: 'object',
        properties: {
          tld: { type: 'string' },
          wholesale: { type: 'number' },
          markup: { type: 'number' },
          registration: { type: 'number' },
          renewal: { type: 'number' },
          transfer: { type: 'number' },
          currency: { type: 'string' },
        },
      },
      Invoice: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          number: { type: 'string' },
          status: { type: 'string' },
          total: { type: 'number' },
          currency: { type: 'string' },
          items: { type: 'array', items: { type: 'object' } },
          paidAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/api/domains/search': {
      get: {
        summary: 'Instant domain availability search',
        parameters: [
          { name: 'domain', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Search result with pricing and suggestions' },
        },
      },
      post: {
        summary: 'Bulk domain search',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domains: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Bulk search results' } },
      },
    },
    '/api/domains/register': {
      post: {
        summary: 'Register a new domain (triggers full automation pipeline)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  duration: { type: 'integer' },
                  projectId: { type: 'string' },
                  provider: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Domain registered' } },
      },
    },
    '/api/domains/renew': {
      post: {
        summary: 'Renew a domain',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domainId: { type: 'string' },
                  duration: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Domain renewed' } },
      },
    },
    '/api/domains/transfer': {
      post: {
        summary: 'Transfer a domain from another registrar',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domain: { type: 'string' },
                  authCode: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Transfer initiated' } },
      },
    },
    '/api/domains': {
      get: { summary: 'List user domains', responses: { '200': { description: 'Domain list' } } },
    },
    '/api/domains/{id}': {
      get: {
        summary: 'Get domain details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Domain details' } },
      },
    },
    '/api/domains/{id}/nameservers': {
      put: {
        summary: 'Set custom nameservers',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { nameservers: { type: 'array', items: { type: 'string' } } },
              },
            },
          },
        },
        responses: { '200': { description: 'Nameservers updated' } },
      },
    },
    '/api/domains/{id}/dns': {
      put: {
        summary: 'Configure DNS records (A, AAAA, CNAME, MX, TXT, SRV, CAA, NS)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'DNS records updated' } },
      },
    },
    '/api/domains/{id}/privacy': {
      put: {
        summary: 'Enable/disable WHOIS privacy',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { enabled: { type: 'boolean' } } },
            },
          },
        },
        responses: { '200': { description: 'Privacy setting updated' } },
      },
    },
    '/api/domains/{id}/lock': {
      put: {
        summary: 'Lock/unlock domain (registrar transfer lock)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { locked: { type: 'boolean' } } },
            },
          },
        },
        responses: { '200': { description: 'Lock status updated' } },
      },
    },
    '/api/domains/{id}/auth-code': {
      get: {
        summary: 'Get EPP / auth code (for transfers)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Auth code' } },
      },
    },
    '/api/domains/{id}/auto-renew': {
      put: {
        summary: 'Enable/disable auto-renew',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { enabled: { type: 'boolean' } } },
            },
          },
        },
        responses: { '200': { description: 'Auto-renew updated' } },
      },
    },
    '/api/domains/{id}/logs': {
      get: {
        summary: 'Get domain activity log',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Activity log' } },
      },
    },
    '/api/pricing': {
      get: {
        summary: 'Get all domain pricing (wholesale + $6.50 markup = selling price)',
        responses: { '200': { description: 'Pricing table' } },
      },
    },
    '/api/pricing/sync': {
      post: {
        summary: 'Sync prices from Dynadot (admin only)',
        responses: { '200': { description: 'Sync result' } },
      },
    },
    '/api/pricing/bulk-search': {
      post: {
        summary: 'Bulk search with pricing',
        responses: { '200': { description: 'Priced search results' } },
      },
    },
    '/api/invoices': {
      get: { summary: 'List invoices', responses: { '200': { description: 'Invoice list' } } },
    },
    '/api/invoices/{id}': {
      get: {
        summary: 'Get invoice detail (receipt)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Invoice detail' } },
      },
    },
    '/api/admin/domains': {
      get: {
        summary: 'Admin: list all domains',
        responses: { '200': { description: 'All domains' } },
      },
    },
    '/api/admin/domains/{id}/suspend': {
      post: {
        summary: 'Admin: suspend a domain',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Domain suspended' } },
      },
    },
  },
}

const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Apsamo Technology Domain Reseller API — Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        spec: ${JSON.stringify(openapiSpec)},
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout',
        deepLinking: true,
      });
    };
  </script>
</body>
</html>`

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  if (searchParams.get('format') === 'json') {
    return NextResponse.json(openapiSpec)
  }
  return new NextResponse(swaggerHtml, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
