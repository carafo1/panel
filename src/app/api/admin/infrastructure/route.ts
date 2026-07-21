import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { getFleetMetrics } from '@/lib/vps/host-metrics'

/**
 * Super-admin infrastructure + business overview.
 *
 * Everything here is either a live host measurement or a row count. There are
 * deliberately NO plan limits in this response: a plan's "10 GB" is a billing
 * entitlement for one customer, and rendering it on an operator dashboard
 * beside real host metrics is what made the old UI misleading. Quotas belong
 * to a subscription, and are only meaningful when managing that subscription.
 */
export async function GET(request: Request) {
  try {
    if (!(await requireAdminRole(request))) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [
      fleet,
      servers,
      customers,
      suspendedAccounts,
      hostingAccounts,
      runningProjects,
      totalDomains,
      activeSubs,
      pastDueSubs,
      suspendedSubs,
      unpaidInvoices,
      monthPayments,
    ] = await Promise.all([
      getFleetMetrics(),
      db.server.findMany({
        select: { id: true, name: true, status: true, ip: true, cpuCores: true, ramGB: true, storageGB: true },
      }),
      db.user.count({ where: { role: { in: ['client', 'user'] } } }),
      db.user.count({ where: { status: { not: 'active' } } }),
      db.project.count(),
      db.project.count({ where: { status: 'running' } }),
      db.domain.count(),
      db.subscription.count({ where: { status: { in: ['active', 'trialing'] } } }),
      db.subscription.count({ where: { status: 'past_due' } }),
      db.subscription.count({ where: { status: 'suspended' } }),
      db.invoice.findMany({
        where: { status: { in: ['unpaid', 'partially_paid'] } },
        select: { total: true, amountPaid: true, dueDate: true },
      }),
      db.payment.aggregate({
        _sum: { amount: true },
        where: { status: 'completed', createdAt: { gte: monthStart } },
      }),
    ])

    // ── Aggregate the fleet ──────────────────────────────────────────
    // Only servers we actually reached contribute to averages; an
    // unreachable host must not be averaged in as "0% busy", which would
    // make a dead machine look idle and healthy.
    const reachable = fleet.filter((f) => !f.error)
    const unreachable = fleet.filter((f) => f.error)

    const totalCores = reachable.reduce((s, f) => s + (f.cpu?.cpuCount ?? 0), 0)
    const totalRamMB = reachable.reduce((s, f) => s + f.memory.totalMB, 0)
    const usedRamMB = reachable.reduce((s, f) => s + f.memory.usedMB, 0)
    // Average only over servers whose CPU we could actually parse.
    const cpuMeasured = reachable.filter((f) => f.cpu !== null)
    const avgCpu =
      cpuMeasured.length > 0
        ? Math.round(
            (cpuMeasured.reduce((s, f) => s + (f.cpu?.busyPercent ?? 0), 0) /
              cpuMeasured.length) * 10
          ) / 10
        : null
    const avgDisk =
      reachable.length > 0
        ? Math.round(
            (reachable.reduce((s, f) => s + f.disk.usePercent, 0) / reachable.length) * 10
          ) / 10
        : null
    const runningContainers = reachable.reduce((s, f) => s + f.containers.length, 0)

    const outstanding =
      Math.round(
        unpaidInvoices.reduce((s, i) => s + ((i.total || 0) - (i.amountPaid || 0)), 0) * 100
      ) / 100
    const overdueCount = unpaidInvoices.filter(
      (i) => i.dueDate && new Date(i.dueDate) < now
    ).length

    return NextResponse.json({
      // ── Real host measurements ─────────────────────────────────────
      infrastructure: {
        totalServers: servers.length,
        reachableServers: reachable.length,
        unreachableServers: unreachable.length,
        // null (not 0) when nothing could be measured — the UI shows "—".
        avgCpuPercent: avgCpu,
        avgDiskPercent: avgDisk,
        totalCores,
        totalRamMB,
        usedRamMB,
        ramPercent:
          totalRamMB > 0 ? Math.round((usedRamMB / totalRamMB) * 1000) / 10 : null,
        runningContainers,
        measuredAt: new Date().toISOString(),
      },
      servers: fleet.map((f) => {
        const row = servers.find((s) => s.id === f.serverId)
        return {
          id: f.serverId,
          name: f.serverName,
          ip: row?.ip ?? null,
          status: row?.status ?? 'unknown',
          demo: f.demo,
          error: f.error ?? null,
          cpuPercent: f.error || !f.cpu ? null : f.cpu.busyPercent,
          cpuCores: f.cpu?.cpuCount ?? 0,
          ramUsedMB: f.error ? null : f.memory.usedMB,
          ramTotalMB: f.memory.totalMB,
          ramPercent: f.error ? null : f.memory.usedPercent,
          diskPercent: f.error ? null : f.disk.usePercent,
          diskSize: f.disk.size,
          diskUsed: f.disk.used,
          containers: f.containers.length,
          load1: f.loadAvg.load1,
          uptime: f.uptime.uptimeString,
        }
      }),
      // ── Business counts (rows, not quotas) ─────────────────────────
      business: {
        customers,
        suspendedAccounts,
        hostingAccounts,
        runningProjects,
        totalDomains,
        activeSubscriptions: activeSubs,
        pastDueSubscriptions: pastDueSubs,
        suspendedSubscriptions: suspendedSubs,
        monthlyRevenue: Math.round((monthPayments._sum.amount || 0) * 100) / 100,
        pendingInvoices: unpaidInvoices.length,
        outstandingAmount: outstanding,
        overdueInvoices: overdueCount,
      },
    })
  } catch (error) {
    console.error('[admin/infrastructure] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
