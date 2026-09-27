/**
 * useMessages Hook
 * 
 * Fetches and subscribes to messages for a project using the unified message system.
 * Replaces the complex message reconstruction logic in useChatMessages.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch, apiUrl } from '../utils_api'
import { createFetchEventSource } from '../utils/fetchEventSource'

/**
 * Hook for fetching and subscribing to project messages.
 * 
 * @param {string} projectId - Project ID
 * @param {Object} options - Options
 * @param {string} options.runId - Optional run ID filter
 * @param {boolean} options.enableSSE - Enable SSE subscription (default: true)
 * @param {number} options.resetNonce - Bump to reset message state after revert
 * @returns {Object} { messages, isLoading, error, refetch, pendingApproval }
 */
export function useMessages(projectId, options = {}) {
  const { runId, enableSSE = true, resetNonce = 0 } = options
  
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [pendingApproval, setPendingApproval] = useState(null)
  
  const lastSequenceRef = useRef(0)
  const eventSourceRef = useRef(null)
  const mountedRef = useRef(true)

  // Fetch messages
  const fetchMessages = useCallback(async (afterSequence = 0) => {
    if (!projectId) return
    
    try {
      const params = new URLSearchParams()
      if (afterSequence > 0) params.set('after', afterSequence.toString())
      if (runId) params.set('run_id', runId)
      // Journal records ship as bounded previews; the feed renders them as
      // tool action cards (hanging call = "awaiting result")
      params.set('include_journal', '1')

      const url = `/projects/${projectId}/messages?${params.toString()}`
      const res = await apiFetch(url)
      
      if (!res.ok) {
        throw new Error(`Failed to fetch messages: ${res.status}`)
      }
      
      const data = await res.json()
      
      if (!mountedRef.current) return
      
      if (afterSequence === 0) {
        // Initial fetch - replace all messages
        setMessages(data.messages || [])
      } else {
        // Incremental fetch - append new messages
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id))
          const newMessages = (data.messages || []).filter(m => !existingIds.has(m.id))
          if (newMessages.length === 0) return prev
          return [...prev, ...newMessages].sort((a, b) => a.sequence - b.sequence)
        })
      }
      
      lastSequenceRef.current = data.latest_sequence || 0
      
      // Find pending approval
      const pending = (data.messages || []).find(
        m => m.type === 'approval' && m.status === 'pending'
      )
      setPendingApproval(pending || null)
      
      setError(null)
    } catch (err) {
      if (mountedRef.current) {
        setError(err)
        console.error('Error fetching messages:', err)
      }
    }
  }, [projectId, runId])

  // Initial fetch
  useEffect(() => {
    if (!projectId) {
      setMessages([])
      setIsLoading(false)
      return
    }
    
    mountedRef.current = true
    setIsLoading(true)
    lastSequenceRef.current = 0
    
    fetchMessages(0).finally(() => {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    })
    
    return () => {
      mountedRef.current = false
    }
  }, [projectId, resetNonce, fetchMessages])

  // SSE subscription for real-time updates
  useEffect(() => {
    if (!projectId || !enableSSE) return

    if (resetNonce) {
      lastSequenceRef.current = 0
    }
    
    const params = new URLSearchParams()
    params.set('after', lastSequenceRef.current.toString())
    if (runId) params.set('run_id', runId)
    // Must match the REST fetch above, or live updates drop journal records
    params.set('include_journal', '1')

    const sseUrl = apiUrl(`/projects/${projectId}/messages/stream?${params.toString()}`)
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('access_token') : null
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}

    const handleMessage = (data) => {
      try {
        const message = JSON.parse(data)
        
        setMessages(prev => {
          const existingIdx = prev.findIndex(m => m.id === message.id)
          if (existingIdx >= 0) {
            const updated = [...prev]
            updated[existingIdx] = message
            return updated
          }
          
          const updated = [...prev, message].sort((a, b) => a.sequence - b.sequence)
          return updated
        })
        
        lastSequenceRef.current = Math.max(lastSequenceRef.current, message.sequence)
        
        if (message.type === 'approval') {
          if (message.status === 'pending') {
            setPendingApproval(message)
          } else {
            setPendingApproval(prev => prev?.id === message.id ? null : prev)
          }
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err)
      }
    }

    const sse = createFetchEventSource(sseUrl, {
      headers: authHeaders,
      onEvent: (type, data) => {
        if (type === 'message') {
          handleMessage(data)
        } else if (type === 'connected') {
          try {
            const parsed = JSON.parse(data)
            lastSequenceRef.current = parsed.last_sequence || lastSequenceRef.current
          } catch {}
        }
      },
      onError: (err) => {
        console.warn('SSE connection error, will retry...', err)
      },
    })
    eventSourceRef.current = sse
    
    return () => {
      sse.close()
      eventSourceRef.current = null
    }
  }, [projectId, runId, enableSSE, resetNonce])

  // Refetch function for manual refresh
  const refetch = useCallback(() => {
    setIsLoading(true)
    return fetchMessages(0).finally(() => {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    })
  }, [fetchMessages])

  // Update message status (for local optimistic updates)
  const updateMessageStatus = useCallback((messageId, newStatus) => {
    setMessages(prev => prev.map(m => 
      m.id === messageId ? { ...m, status: newStatus } : m
    ))
    
    // Update pending approval if needed
    if (newStatus !== 'pending') {
      setPendingApproval(prev => prev?.id === messageId ? null : prev)
    }
  }, [])

  return {
    messages,
    isLoading,
    error,
    refetch,
    pendingApproval,
    updateMessageStatus,
    lastSequence: lastSequenceRef.current
  }
}

/**
 * Hook for sending messages to a project.
 * 
 * @param {string} projectId - Project ID
 * @param {Object} options - Options
 * @returns {Object} { sendMessage, isSending }
 */
export function useSendMessage(projectId, options = {}) {
  const { runId } = options
  const [isSending, setIsSending] = useState(false)

  const sendMessage = useCallback(async (content, metadata = {}) => {
    if (!projectId || !content?.trim()) return null
    
    setIsSending(true)
    
    try {
      const params = runId ? `?run_id=${runId}` : ''
      const res = await apiFetch(`/projects/${projectId}/messages${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim(), metadata })
      })
      
      if (!res.ok) {
        throw new Error(`Failed to send message: ${res.status}`)
      }
      
      return await res.json()
    } catch (err) {
      console.error('Error sending message:', err)
      throw err
    } finally {
      setIsSending(false)
    }
  }, [projectId, runId])

  return { sendMessage, isSending }
}

export default useMessages
