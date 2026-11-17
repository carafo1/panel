'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Mail, Phone, MapPin, Clock, Send, Loader2 } from 'lucide-react'
import { apiFetch } from '@/store/auth-store'
import { PageHero, ScrollReveal } from '../ui-helpers'
import { useSiteContent } from '../site-data-context'

export function ContactPage() {
  const { getContent } = useSiteContent()
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' })
  const [loading, setLoading] = useState(false)

  const contactInfo = [
    { icon: Mail, title: 'Email', value: getContent('contact.info.email'), desc: getContent('contact.info.emailDesc') },
    { icon: Phone, title: 'Phone', value: getContent('contact.info.phone'), desc: getContent('contact.info.phoneDesc') },
    { icon: MapPin, title: 'Office', value: getContent('contact.info.office'), desc: getContent('contact.info.officeDesc') },
    { icon: Clock, title: 'Support', value: getContent('contact.info.support'), desc: getContent('contact.info.supportDesc') },
  ]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name || !form.email || !form.message) {
      toast.error('Please fill in all required fields')
      return
    }
    setLoading(true)
    try {
      await apiFetch('/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      toast.success('Message sent!', { description: 'We\'ll get back to you within 24 hours.' })
      setForm({ name: '', email: '', subject: '', message: '' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send message'
      toast.error('Failed to send', { description: msg })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <PageHero
        badge={getContent('contact.hero.badge')}
        title={<span className="text-gradient-brand">{getContent('contact.hero.title')}</span>}
        subtitle={getContent('contact.hero.subtitle')}
      />

      <section className="py-20 bg-background">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
            {/* Contact info */}
            <ScrollReveal>
              <div>
                <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('contact.info.badge')}</Badge>
                <h2 className="text-2xl font-extrabold mb-4">{getContent('contact.info.title')}</h2>
                <p className="text-muted-foreground mb-8 leading-relaxed">
                  {getContent('contact.info.desc')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {contactInfo.map((info) => {
                    const Icon = info.icon
                    return (
                      <Card key={info.title} className="border hover:border-indigo-500/30 hover:shadow-modern-lg transition-all duration-300 bg-card/80 backdrop-blur-sm">
                        <CardContent className="p-5">
                          <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo">
                            <Icon className="size-5" />
                          </div>
                          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{info.title}</p>
                          <p className="font-bold text-sm mt-0.5">{info.value}</p>
                          <p className="text-xs text-muted-foreground mt-1">{info.desc}</p>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              </div>
            </ScrollReveal>

            {/* Form */}
            <ScrollReveal delay={100}>
              <Card className="border bg-card/80 backdrop-blur-sm shadow-modern-lg">
                <CardContent className="p-6 sm:p-8">
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="name">Name <span className="text-red-500">*</span></Label>
                        <Input
                          id="name"
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          placeholder="Jane Doe"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="email">Email <span className="text-red-500">*</span></Label>
                        <Input
                          id="email"
                          type="email"
                          value={form.email}
                          onChange={(e) => setForm({ ...form, email: e.target.value })}
                          placeholder="jane@company.com"
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="subject">Subject</Label>
                      <Input
                        id="subject"
                        value={form.subject}
                        onChange={(e) => setForm({ ...form, subject: e.target.value })}
                        placeholder="How can we help?"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="message">Message <span className="text-red-500">*</span></Label>
                      <Textarea
                        id="message"
                        value={form.message}
                        onChange={(e) => setForm({ ...form, message: e.target.value })}
                        placeholder="Tell us about your project or question..."
                        rows={5}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={loading}
                      className="btn-shimmer w-full bg-indigo-500 hover:bg-indigo-600 text-white border-0 h-12 shadow-glow-indigo"
                    >
                      {loading ? (
                        <><Loader2 className="size-4 me-2 animate-spin" /> Sending...</>
                      ) : (
                        <><Send className="size-4 me-2" /> {getContent('contact.form.button')}</>
                      )}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </ScrollReveal>
          </div>
        </div>
      </section>
    </>
  )
}
