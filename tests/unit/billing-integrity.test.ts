/**
 * Waafi verification rules (pure, no network).
 *
 * Guards the bug where a TransactionStatus reply with responseCode '2001'
 * ("request successfully completed" — the QUERY worked) was read as "the
 * customer paid", and where any reported amount was accepted.
 */
import { describe, it, expect } from 'bun:test'
import { interpretWaafiStatus, waafiAmountMismatch } from '@/lib/waafi'

describe('interpretWaafiStatus', () => {
  it('does not treat a successful status query as a successful payment', () => {
    expect(interpretWaafiStatus({ responseCode: '2001', responseMsg: 'RCS_SUCCESS' }).status).toBe('pending')
    expect(
      interpretWaafiStatus({ responseCode: '2001', responseMsg: 'Request successfully completed' }).status
    ).toBe('pending')
  })

  it('uses the transaction state', () => {
    expect(interpretWaafiStatus({ responseCode: '2001', params: { state: 'APPROVED', txAmount: '12.50' } })).toEqual({
      success: true, status: 'completed', amount: 12.5, currency: undefined,
    })
    expect(interpretWaafiStatus({ transactionStatus: 'Completed', amount: 3, currency: 'USD' }).status).toBe('completed')
    expect(interpretWaafiStatus({ params: { state: 'DECLINED' } }).status).toBe('failed')
    expect(interpretWaafiStatus({ status: 'unsuccessful' }).status).toBe('failed')
    expect(interpretWaafiStatus({ params: { state: 'PENDING' } }).status).toBe('pending')
  })

  it('reports a missing amount as undefined, not 0', () => {
    expect(interpretWaafiStatus({ params: { state: 'APPROVED' } }).amount).toBeUndefined()
  })
})

describe('waafiAmountMismatch', () => {
  const due = { amount: 25, currency: 'usd' }

  it('accepts the full amount in the same currency', () => {
    expect(waafiAmountMismatch(due, { amount: 25, currency: 'USD' })).toBeNull()
    expect(waafiAmountMismatch(due, { amount: 25.0000001 })).toBeNull()
  })

  it('refuses a short, missing or foreign-currency payment', () => {
    expect(waafiAmountMismatch(due, { amount: 0.01, currency: 'USD' })).not.toBeNull()
    expect(waafiAmountMismatch(due, { amount: 24.99, currency: 'USD' })).not.toBeNull()
    expect(waafiAmountMismatch(due, { currency: 'USD' })).not.toBeNull()
    expect(waafiAmountMismatch(due, { amount: 25, currency: 'SOS' })).not.toBeNull()
    expect(waafiAmountMismatch({ amount: 25, currency: 'EUR' }, { amount: 25 })).not.toBeNull()
  })
})
