import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useCallback } from 'react'
import { adrsApi, getCurrentProjectId } from '@/lib/api'
import { useWebSocketContext } from '@/contexts/WebSocketContext'
import { useProject } from '@/hooks/useProject'
import type { UpdateAdrRequest, WebSocketMessage } from '@/types/api'

export function useAdrs(archived?: boolean) {
  const queryClient = useQueryClient()
  const { currentProjectId } = useProject()
  const { connected, subscribe, unsubscribe, addMessageHandler, removeMessageHandler } = useWebSocketContext()
  const queryKey = currentProjectId
    ? archived !== undefined
      ? ['adrs', currentProjectId, { archived }]
      : ['adrs', currentProjectId]
    : ['adrs']
  const isProjectSynced = currentProjectId === getCurrentProjectId()

  const query = useQuery({
    queryKey,
    queryFn: () => adrsApi.getAll(archived),
    enabled: !!currentProjectId && isProjectSynced,
  })

  const handleMessage = useCallback((message: WebSocketMessage) => {
    if (['adr_created', 'adr_updated', 'adr_deleted'].includes(message.type)) {
      queryClient.invalidateQueries({ queryKey: ['adrs', currentProjectId] })
    }
  }, [queryClient, currentProjectId])

  useEffect(() => {
    const handlerId = 'useAdrs'
    addMessageHandler(handlerId, handleMessage)
    if (connected) subscribe('adr')
    return () => {
      removeMessageHandler(handlerId)
      unsubscribe('adr')
    }
  }, [connected, subscribe, unsubscribe, addMessageHandler, removeMessageHandler, handleMessage])

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAdrRequest }) => adrsApi.update(id, data),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['adrs', currentProjectId] })
      queryClient.invalidateQueries({ queryKey: ['adr', currentProjectId] })
    },
  })
  const createMutation = useMutation({
    mutationFn: adrsApi.create,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adrs', currentProjectId] }),
  })
  const deleteMutation = useMutation({
    mutationFn: adrsApi.delete,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adrs', currentProjectId] }),
  })

  return {
    adrs: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    updateAdr: updateMutation.mutate,
    updateAdrAsync: updateMutation.mutateAsync,
    createAdr: createMutation.mutate,
    createAdrAsync: createMutation.mutateAsync,
    deleteAdr: deleteMutation.mutate,
    archiveAdr: (id: string) => updateMutation.mutate({ id, data: { archived: true } }),
    unarchiveAdr: (id: string) => updateMutation.mutate({ id, data: { archived: false } }),
    isUpdating: updateMutation.isPending,
    isCreating: createMutation.isPending,
  }
}

export function useAdr(id: string) {
  const queryClient = useQueryClient()
  const { currentProjectId } = useProject()
  const { connected, subscribe, unsubscribe, addMessageHandler, removeMessageHandler } = useWebSocketContext()
  const isProjectSynced = currentProjectId === getCurrentProjectId()
  const queryKey = ['adr', currentProjectId, id]
  const query = useQuery({
    queryKey,
    queryFn: () => adrsApi.getById(id),
    enabled: !!id && !!currentProjectId && isProjectSynced,
  })

  const handleMessage = useCallback((message: WebSocketMessage) => {
    if (message.type === 'adr_updated') {
      queryClient.invalidateQueries({ queryKey: ['adr', currentProjectId, id] })
      queryClient.invalidateQueries({ queryKey: ['adrs', currentProjectId] })
    }
  }, [id, currentProjectId, queryClient])

  useEffect(() => {
    if (!id) return
    const handlerId = `useAdr-${id}`
    addMessageHandler(handlerId, handleMessage)
    if (connected) subscribe('adr', id)
    return () => {
      removeMessageHandler(handlerId)
      unsubscribe('adr', id)
    }
  }, [connected, id, subscribe, unsubscribe, addMessageHandler, removeMessageHandler, handleMessage])

  return {
    adr: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  }
}
