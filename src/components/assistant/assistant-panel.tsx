'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Bot,
  Send,
  Sparkles,
  Trash2,
  Plus,
  User,
  Loader2,
  Rocket,
  Globe,
  GitMerge,
  AlertTriangle,
  Shield,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAuthStore } from '@/store/auth-store'

// ── Types ───────────────────────────────────────────────────────────────
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

// ── Quick prompts ───────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  { label: 'Help me deploy my first project', icon: Rocket, prompt: 'Help me deploy my first project. What steps do I need to follow?' },
  { label: 'Configure DNS for my domain', icon: Globe, prompt: 'How do I configure DNS for my domain? What records do I need?' },
  { label: 'Explain CI/CD pipelines', icon: GitMerge, prompt: 'Explain CI/CD pipelines and how they work in APSAMO.' },
  { label: 'Troubleshoot deployment failure', icon: AlertTriangle, prompt: 'My deployment failed. How can I troubleshoot deployment failures?' },
  { label: 'Best practices for production', icon: Shield, prompt: 'What are the best practices for deploying applications to production?' },
]

// ── Markdown renderer (basic) ───────────────────────────────────────────
function renderMarkdown(text: string) {
  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks (```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    return `<pre class="bg-muted/80 text-foreground rounded-lg p-3 my-2 overflow-x-auto text-sm leading-relaxed"><code class="language-${lang}">${code.trim()}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-indigo-700 dark:text-indigo-400">$1</code>')

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>')

  // Italic
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')

  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-3 mb-1">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold mt-3 mb-1">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold mt-3 mb-1">$1</h1>')

  // Line breaks (double newline → paragraph)
  html = html.replace(/\n\n/g, '</p><p class="mb-2">')

  // Single newlines → <br>
  html = html.replace(/\n/g, '<br/>')

  return `<p class="mb-2">${html}</p>`
}

// ── Component ───────────────────────────────────────────────────────────
export default function AssistantPanel() {
  const { token } = useAuthStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isLoading])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const sendMessage = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || isLoading) return

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: messageText.trim(),
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, userMessage])
      setInput('')
      setIsLoading(true)

      try {
        const response = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            message: messageText.trim(),
            sessionId: sessionId || undefined,
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.error || 'Failed to get response')
        }

        const data = await response.json()

        if (!sessionId) {
          setSessionId(data.sessionId)
        }

        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: data.response,
          timestamp: new Date(),
        }

        setMessages((prev) => [...prev, assistantMessage])
      } catch (error) {
        console.error('Chat error:', error)
        toast.error('Failed to get AI response. Please try again.')
      } finally {
        setIsLoading(false)
        inputRef.current?.focus()
      }
    },
    [isLoading, sessionId, token]
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(input)
  }

  const handleClearChat = async () => {
    if (sessionId) {
      try {
        await fetch(`/api/assistant/chat?sessionId=${sessionId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {
        // Silently fail - it's just cleanup
      }
    }
    setMessages([])
    setSessionId(null)
    toast.success('Chat cleared')
    inputRef.current?.focus()
  }

  const handleNewChat = () => {
    setMessages([])
    setSessionId(null)
    inputRef.current?.focus()
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[calc(100vh-10rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Sparkles className="size-5 text-white" />
          </div>
          <div>
            <h2 className="font-bold text-lg">AI Assistant</h2>
            <p className="text-xs text-muted-foreground">
              Expert help for hosting & deployment
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNewChat}
            title="New chat"
            className="size-9"
          >
            <Plus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClearChat}
            disabled={messages.length === 0}
            title="Clear chat"
            className="size-9 text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* Chat area */}
      <Card className="flex-1 flex flex-col min-h-0 border shadow-sm">
        <ScrollArea className="flex-1" ref={scrollRef}>
          <div className="p-4 space-y-4">
            {messages.length === 0 ? (
              /* Empty state with quick prompts */
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <div className="size-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-indigo-500/20 flex items-center justify-center mb-4">
                  <Bot className="size-8 text-indigo-600 dark:text-indigo-400" />
                </div>
                <h3 className="text-lg font-semibold mb-1">
                  How can I help you?
                </h3>
                <p className="text-sm text-muted-foreground text-center max-w-md mb-6">
                  I&apos;m your APSAMO AI assistant. Ask me anything about hosting, domains, deployments, CI/CD, or cloud infrastructure.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
                  {QUICK_PROMPTS.map((prompt) => {
                    const Icon = prompt.icon
                    return (
                      <button
                        key={prompt.label}
                        onClick={() => sendMessage(prompt.prompt)}
                        disabled={isLoading}
                        className="flex items-center gap-2.5 p-3 rounded-lg border border-border/60 bg-card hover:bg-muted/50 transition-colors text-left group"
                      >
                        <div className="size-8 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0 group-hover:bg-indigo-500/20 transition-colors">
                          <Icon className="size-4 text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <span className="text-sm font-medium leading-snug">
                          {prompt.label}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              /* Message list */
              <>
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex gap-2.5 ${
                      msg.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    {msg.role === 'assistant' && (
                      <div className="size-7 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center shrink-0 mt-1">
                        <Bot className="size-3.5 text-white" />
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] sm:max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-indigo-600 text-white rounded-br-md'
                          : 'bg-muted/80 text-foreground rounded-bl-md'
                      }`}
                    >
                      {msg.role === 'assistant' ? (
                        <div
                          className="prose prose-sm dark:prose-invert max-w-none [&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_code]:text-indigo-700 [&_code]:dark:text-indigo-400 [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono"
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdown(msg.content),
                          }}
                        />
                      ) : (
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                      )}
                    </div>
                    {msg.role === 'user' && (
                      <div className="size-7 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-1">
                        <User className="size-3.5 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                ))}

                {/* Typing indicator */}
                {isLoading && (
                  <div className="flex gap-2.5 justify-start">
                    <div className="size-7 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center shrink-0 mt-1">
                      <Bot className="size-3.5 text-white" />
                    </div>
                    <div className="bg-muted/80 rounded-2xl rounded-bl-md px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <div className="size-2 rounded-full bg-indigo-500 animate-[bounce_1s_ease-in-out_infinite]" />
                        <div className="size-2 rounded-full bg-indigo-500 animate-[bounce_1s_ease-in-out_0.15s_infinite]" />
                        <div className="size-2 rounded-full bg-indigo-500 animate-[bounce_1s_ease-in-out_0.3s_infinite]" />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        {/* Chat input */}
        <div className="border-t p-3">
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about hosting, deployment, DNS..."
              disabled={isLoading}
              className="flex-1 h-10 rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim() || isLoading}
              className="size-10 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shrink-0"
            >
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </form>
          <p className="text-[10px] text-muted-foreground text-center mt-2">
            AI responses may not always be accurate. Verify important information.
          </p>
        </div>
      </Card>
    </div>
  )
}
