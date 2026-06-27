import {
  Code2, Server, Globe, LayoutGrid, Zap, Shield, ShieldCheck, Globe2,
  GitBranch, Activity, Users, Rocket, PenTool, Terminal, Layers,
  Database, Cpu, Cloud, Palette, Boxes, Network, HardDrive, Lock,
  RotateCcw, RefreshCw, Bell, Mail, Webhook, KeyRound, FileText,
  BarChart3, Building2, CreditCard, Gauge, Search, ShoppingBag,
  Tag, ArrowLeftRight, ArrowRight, Check, Sparkles, ChevronDown,
  type LucideIcon,
} from 'lucide-react'

/**
 * Registry mapping lucide icon names (stored in the DB as strings) to their
 * React components. Used by the CMS so admin-entered icon names resolve to
 * real components on the public site.
 *
 * Add new icons here as needed — the admin UI offers these as a dropdown.
 */
export const ICON_REGISTRY: Record<string, LucideIcon> = {
  Code2, Server, Globe, LayoutGrid, Zap, Shield, ShieldCheck, Globe2,
  GitBranch, Activity, Users, Rocket, PenTool, Terminal, Layers,
  Database, Cpu, Cloud, Palette, Boxes, Network, HardDrive, Lock,
  RotateCcw, RefreshCw, Bell, Mail, Webhook, KeyRound, FileText,
  BarChart3, Building2, CreditCard, Gauge, Search, ShoppingBag,
  Tag, ArrowLeftRight, ArrowRight, Check, Sparkles, ChevronDown,
}

/** Resolve an icon name to its component, falling back to LayoutGrid. */
export function resolveIcon(name?: string): LucideIcon {
  if (!name) return LayoutGrid
  return ICON_REGISTRY[name] ?? LayoutGrid
}

/** List of available icon names for the admin dropdown. */
export const ICON_NAMES = Object.keys(ICON_REGISTRY).sort()
