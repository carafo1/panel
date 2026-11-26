'use client'

import { Link2, Server } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppStore } from '@/store/app-store'
import { ChoiceList, Field, describedBy } from './choice-list'
import { isValidDomain, slugify } from './format'

export const BRAND_DOMAIN = process.env.NEXT_PUBLIC_BRAND_DOMAIN || 'apsamo.com'

/**
 * Every website needs a real domain: one in the account, or one the customer
 * owns elsewhere. There is no free platform address.
 */
export type AddressType = 'existing' | 'external'

export interface IdentityValue {
  name: string
  /** Null until the customer picks one; the step cannot continue without it. */
  addressType: AddressType | null
  existingDomain: string
  externalDomain: string
}

export const DOMAIN_REQUIRED_MESSAGE = 'Choose a domain for this website — buy one or connect a domain you own.'

export const EMPTY_IDENTITY: IdentityValue = {
  name: '',
  addressType: null,
  existingDomain: '',
  externalDomain: '',
}

export function nameError(name: string): string | null {
  if (!name.trim()) return 'Give your website a name.'
  if (slugify(name).length < 3) return 'Use at least 3 letters or numbers.'
  if (name.trim().length > 60) return 'Keep the name under 60 characters.'
  return null
}

export function addressError(v: IdentityValue): string | null {
  if (!v.addressType) return DOMAIN_REQUIRED_MESSAGE
  if (v.addressType === 'existing' && !v.existingDomain) return 'Choose one of your domains.'
  if (v.addressType === 'external') {
    if (!v.externalDomain.trim()) return 'Enter the domain you want to use.'
    if (!isValidDomain(v.externalDomain)) return 'That does not look like a domain. Use a format like example.com.'
    if (v.externalDomain.trim().toLowerCase().endsWith(`.${BRAND_DOMAIN}`))
      return `Addresses on ${BRAND_DOMAIN} belong to the platform. Use a domain you own.`
  }
  return null
}

/** Payload fields both create endpoints accept. */
export function identityPayload(v: IdentityValue): { name: string; domainType?: AddressType; domain?: string } {
  return {
    name: v.name.trim(),
    domainType: v.addressType ?? undefined,
    domain:
      v.addressType === 'existing'
        ? v.existingDomain
        : v.addressType === 'external'
          ? v.externalDomain.trim().toLowerCase()
          : undefined,
  }
}

export function addressSummary(v: IdentityValue): string {
  if (v.addressType === 'existing') return v.existingDomain
  if (v.addressType === 'external') return `${v.externalDomain.trim().toLowerCase()} (connects after you update DNS)`
  return 'No domain chosen'
}

/** Website name and how visitors reach it. */
export function SiteIdentity({
  value,
  onChange,
  domains,
  domainsLoading,
  showErrors,
  onClose,
}: {
  value: IdentityValue
  onChange: (next: IdentityValue) => void
  domains: string[]
  domainsLoading: boolean
  /** Errors appear after the customer tries to continue, not while typing. */
  showErrors: boolean
  onClose: () => void
}) {
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)
  const nErr = showErrors ? nameError(value.name) : null
  const aErr = showErrors ? addressError(value) : null
  const nameHint = 'Only you see this. You can change it later.'

  return (
    <div className="space-y-6">
      <Field id="nw-name" label="Website name" hint={nameHint} error={nErr}>
        <Input
          id="nw-name"
          value={value.name}
          maxLength={60}
          autoComplete="off"
          placeholder="e.g. Sunrise Bakery"
          aria-invalid={Boolean(nErr)}
          aria-describedby={describedBy('nw-name', nErr, nameHint)}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          className="h-10"
        />
      </Field>

      <ChoiceList<AddressType>
        name="nw-address"
        legend="Where visitors will find it"
        value={value.addressType}
        onChange={(addressType) => onChange({ ...value, addressType })}
        choices={[
          {
            value: 'existing',
            title: 'A domain in my account',
            icon: <Server className="size-4" />,
            description:
              domains.length > 0 || domainsLoading
                ? 'One you registered or connected here.'
                : 'You have no domains here yet.',
            disabled: !domainsLoading && domains.length === 0,
          },
          {
            value: 'external',
            title: 'A domain I own elsewhere',
            icon: <Link2 className="size-4" />,
            description: 'GoDaddy, Namecheap, Cloudflare or any registrar. No transfer needed.',
          },
        ]}
      >
        {(t) =>
          t === 'existing' ? (
            domainsLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <div className="space-y-1.5">
                <label htmlFor="nw-existing" className="sr-only">
                  Your domain
                </label>
                <Select
                  value={value.existingDomain}
                  onValueChange={(existingDomain) => onChange({ ...value, existingDomain })}
                >
                  <SelectTrigger id="nw-existing" className="w-full" aria-invalid={Boolean(aErr)}>
                    <SelectValue placeholder="Choose a domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {aErr && <p className="text-xs text-destructive">{aErr}</p>}
              </div>
            )
          ) : t === 'external' ? (
            <Field
              id="nw-external"
              label={<span className="sr-only">Your domain</span>}
              error={aErr}
              hint="Afterwards we show the DNS records to add. Your site goes online on this domain by itself once they are in place."
            >
              <Input
                id="nw-external"
                value={value.externalDomain}
                placeholder="example.com"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(aErr)}
                aria-describedby={describedBy('nw-external', aErr, true)}
                onChange={(e) => onChange({ ...value, externalDomain: e.target.value })}
              />
            </Field>
          ) : null
        }
      </ChoiceList>
      {aErr && !value.addressType && (
        <p id="nw-address-error" role="alert" className="-mt-3 text-xs text-destructive">
          {aErr}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        No domain yet?{' '}
        <button
          type="button"
          className="font-medium text-primary underline-offset-2 hover:underline"
          onClick={() => {
            setDashboardTab('domains')
            onClose()
          }}
        >
          Buy or transfer one in Domains
        </button>{' '}
        — then come back and choose it here.
      </p>
    </div>
  )
}
