import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight, Plus, GripVertical, Pencil, Trash2, X } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS as dndCSS } from '@dnd-kit/utilities'

import { useWorkspaces } from '../contexts/WorkspacesContext'
import { useToast } from '../contexts/ToastContext'
import { CreateWorkspaceModal } from './CreateWorkspaceModal'
import { ConfirmDialog } from './ConfirmDialog'
import { Portal } from './Portal'
import { Workspace } from '../types/workspace'

// ─── Sortable row inside the manage popup ───────────────────────────────────

interface SortableWorkspaceRowProps {
  workspace: Workspace
  isActive: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  canDelete: boolean
}

function SortableWorkspaceRow({
  workspace,
  isActive,
  onEdit,
  onDelete,
  canDelete,
}: SortableWorkspaceRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: workspace.id })

  const style = {
    transform: dndCSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  }

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{
        opacity: isDragging ? 0.8 : 1,
        y: 0,
        scale: isDragging ? 1.02 : 1,
        boxShadow: isDragging
          ? '0 8px 24px rgba(0,0,0,0.35)'
          : '0 1px 3px rgba(0,0,0,0.1)',
      }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className={`
        flex items-center gap-3 px-3 py-3 rounded-xl
        ${isDragging ? 'bg-background-tertiary' : 'bg-background-secondary'}
        ${isActive ? 'ring-1 ring-primary/40' : ''}
        transition-colors
      `}
    >
      {/* Drag Handle */}
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="flex-shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-background-tertiary/60 cursor-grab active:cursor-grabbing touch-manipulation transition-colors"
        aria-label="Sıralamak için sürükleyin"
      >
        <GripVertical className="w-4 h-4" />
      </button>

      {/* Workspace Info */}
      <div className="flex items-center gap-2.5 flex-1 min-w-0">
        <span className="text-lg flex-shrink-0">{workspace.icon}</span>
        <span className="text-sm font-medium text-text-primary truncate">
          {workspace.name}
        </span>
        {isActive && (
          <span
            className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: workspace.color }}
          />
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onEdit(workspace.id)
          }}
          className="p-2 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-background-tertiary/60 transition-colors touch-manipulation"
          aria-label={`${workspace.name} düzenle`}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(workspace.id)
            }}
            className="p-2 rounded-lg text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors touch-manipulation"
            aria-label={`${workspace.name} sil`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </motion.div>
  )
}

// ─── Workspace Manage Popup ─────────────────────────────────────────────────

interface WorkspaceManagePopupProps {
  isOpen: boolean
  onClose: () => void
  workspaces: Workspace[]
  currentWorkspaceId: string | null
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (ids: string[]) => void
}

function WorkspaceManagePopup({
  isOpen,
  onClose,
  workspaces,
  currentWorkspaceId,
  onEdit,
  onDelete,
  onReorder,
}: WorkspaceManagePopupProps) {
  const [localItems, setLocalItems] = useState<Workspace[]>([])

  useEffect(() => {
    if (isOpen) {
      setLocalItems(workspaces)
    }
  }, [isOpen, workspaces])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 150,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (active && over && active.id !== over.id) {
      setLocalItems((items) => {
        const oldIndex = items.findIndex((w) => w.id === active.id)
        const newIndex = items.findIndex((w) => w.id === over.id)
        const newItems = arrayMove(items, oldIndex, newIndex)
        onReorder(newItems.map((w) => w.id))
        return newItems
      })
    }
  }

  if (!isOpen) return null

  const canDelete = localItems.length > 1

  return (
    <Portal>
      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={onClose}
            />

            {/* Popup Content */}
            <motion.div
              initial={{ opacity: 0, y: 60 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 60 }}
              transition={{
                type: 'spring',
                stiffness: 400,
                damping: 30,
              }}
              className="relative z-10 bg-background-secondary border border-background-tertiary rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md max-h-[70vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-background-tertiary flex-shrink-0">
                <h3 className="text-base font-semibold text-text-primary">
                  Çalışma Alanlarını Yönet
                </h3>
                <button
                  onClick={onClose}
                  className="p-1.5 hover:bg-background-tertiary rounded-lg transition-colors touch-manipulation"
                  aria-label="Kapat"
                >
                  <X className="w-4 h-4 text-text-tertiary" />
                </button>
              </div>

              {/* Workspace List */}
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}

                >
                  <SortableContext
                    items={localItems.map((w) => w.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <AnimatePresence mode="popLayout">
                      {localItems.map((workspace) => (
                        <SortableWorkspaceRow
                          key={workspace.id}
                          workspace={workspace}
                          isActive={workspace.id === currentWorkspaceId}
                          onEdit={onEdit}
                          onDelete={onDelete}
                          canDelete={canDelete}
                        />
                      ))}
                    </AnimatePresence>
                  </SortableContext>
                </DndContext>
              </div>

              {/* Drag handle bar for mobile (bottom sheet indicator) */}
              <div className="sm:hidden flex justify-center py-2 border-t border-background-tertiary">
                <div className="w-10 h-1 bg-background-tertiary rounded-full" />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </Portal>
  )
}

// ─── Main WorkspaceNavigation ───────────────────────────────────────────────

export function WorkspaceNavigation() {
  const {
    workspaces,
    currentWorkspaceId,
    setCurrentWorkspaceId,
    deleteWorkspace,
    reorderWorkspaces,
  } = useWorkspaces()
  const { showToast } = useToast()

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [workspaceToDelete, setWorkspaceToDelete] = useState<string | null>(null)
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null)
  const [showManagePopup, setShowManagePopup] = useState(false)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)

  // ── Long-press detection for workspace bar ──

  const handleBarPointerDown = useCallback(() => {
    longPressFiredRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true
      setShowManagePopup(true)
    }, 500)
  }, [])

  const handleBarPointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const handleBarPointerLeave = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
    }
  }, [])

  // ── Auto-scroll when active workspace changes ──

  useEffect(() => {
    if (!scrollContainerRef.current || !currentWorkspaceId) return

    const timer = setTimeout(() => {
      if (!scrollContainerRef.current) return
      const activeElement = scrollContainerRef.current.querySelector(
        `button[data-workspace-id="${CSS.escape(currentWorkspaceId)}"]`
      )
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
      }
    }, 50)

    return () => clearTimeout(timer)
  }, [currentWorkspaceId])

  // ── Keyboard navigation ──

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return
      }

      if (e.key === 'ArrowLeft') {
        handlePrevious()
      } else if (e.key === 'ArrowRight') {
        handleNext()
      } else if (e.key === 'Escape') {
        setShowManagePopup(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [workspaces, currentWorkspaceId])

  // ── Navigation helpers ──

  const handlePrevious = () => {
    const currentIndex = workspaces.findIndex((w) => w.id === currentWorkspaceId)
    if (currentIndex > 0) {
      setCurrentWorkspaceId(workspaces[currentIndex - 1].id)
    }
  }

  const handleNext = () => {
    const currentIndex = workspaces.findIndex((w) => w.id === currentWorkspaceId)
    if (currentIndex < workspaces.length - 1) {
      setCurrentWorkspaceId(workspaces[currentIndex + 1].id)
    }
  }

  // ── Workspace actions ──

  const handleEdit = (workspaceId: string) => {
    setEditingWorkspaceId(workspaceId)
    setShowCreateModal(true)
    setShowManagePopup(false)
  }

  const handleDeleteClick = (workspaceId: string) => {
    setWorkspaceToDelete(workspaceId)
    setShowDeleteConfirm(true)
    setShowManagePopup(false)
  }

  const handleDelete = async () => {
    if (!workspaceToDelete) return

    try {
      await deleteWorkspace(workspaceToDelete)
      showToast('Çalışma alanı silindi', 'success', 2000)
      setShowDeleteConfirm(false)
      setWorkspaceToDelete(null)
    } catch (err) {
      console.error('Error deleting workspace:', err)
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete workspace'
      if (errorMessage.includes('last workspace')) {
        showToast('Son çalışma alanı silinemez', 'error', 3000)
      } else {
        showToast('Çalışma alanı silinemedi', 'error', 3000)
      }
    }
  }

  const handleReorder = (ids: string[]) => {
    reorderWorkspaces(ids)
  }

  const canGoPrevious = workspaces.findIndex((w) => w.id === currentWorkspaceId) > 0
  const canGoNext = workspaces.findIndex((w) => w.id === currentWorkspaceId) < workspaces.length - 1

  return (
    <>
      <div className="sticky top-0 z-40 pt-2 sm:pt-3 md:pt-4 pb-2">
        <div className="flex justify-center px-2">
          <motion.div
            layout
            initial={false}
            className="inline-flex items-center gap-0.5 sm:gap-1 px-2 sm:px-3 md:px-4 py-1.5 sm:py-2 bg-background-secondary/80 backdrop-blur-md border border-background-tertiary rounded-xl sm:rounded-2xl shadow-lg max-w-[95vw] sm:max-w-[90vw] overflow-hidden"
            style={{
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
            onPointerDown={handleBarPointerDown}
            onPointerUp={handleBarPointerUp}
            onPointerLeave={handleBarPointerLeave}
            onContextMenu={(e) => {
              e.preventDefault()
              setShowManagePopup(true)
            }}
          >
            {/* Previous Button */}
            <button
              onClick={handlePrevious}
              disabled={!canGoPrevious}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex-shrink-0 p-1.5 sm:p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-background-tertiary rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:scale-105 active:scale-95 touch-manipulation"
              aria-label="Önceki çalışma alanı"
            >
              <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5 text-text-tertiary" />
            </button>

            {/* Workspace Tabs */}
            <div
              ref={scrollContainerRef}
              className="flex items-center gap-1 overflow-x-auto scrollbar-hide"
            >
              <AnimatePresence mode="popLayout">
                {workspaces.map((workspace) => {
                  const isActive = workspace.id === currentWorkspaceId
                  return (
                    <motion.button
                      key={workspace.id}
                      data-workspace-id={workspace.id}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.2 }}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={(e) => {
                        // Don't select workspace if long press opened popup
                        if (longPressFiredRef.current) {
                          e.preventDefault()
                          return
                        }
                        setCurrentWorkspaceId(workspace.id)
                      }}
                      style={{
                        color: isActive ? workspace.color : undefined,
                      }}
                      className={`
                        flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 md:px-4 py-1.5 sm:py-2 rounded-lg sm:rounded-xl transition-all
                        min-h-[44px] touch-manipulation relative select-none
                        ${isActive ? '' : 'hover:bg-background-tertiary/50 active:bg-background-tertiary/70'}
                      `}
                    >
                      <span className="text-base sm:text-lg flex-shrink-0">{workspace.icon}</span>
                      <span className="text-xs sm:text-sm font-medium whitespace-nowrap truncate max-w-[100px] sm:max-w-none">
                        {workspace.name}
                      </span>
                      {isActive && (
                        <motion.div
                          layoutId="activeTabIndicator"
                          className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                          style={{
                            backgroundColor: workspace.color,
                          }}
                          transition={{
                            type: 'spring',
                            stiffness: 500,
                            damping: 30,
                          }}
                        />
                      )}
                    </motion.button>
                  )
                })}
              </AnimatePresence>
            </div>

            {/* Next Button */}
            <button
              onClick={handleNext}
              disabled={!canGoNext}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex-shrink-0 p-1.5 sm:p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-background-tertiary rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:scale-105 active:scale-95 touch-manipulation"
              aria-label="Sonraki çalışma alanı"
            >
              <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5 text-text-tertiary" />
            </button>

            {/* Create Button */}
            <button
              onClick={() => {
                setEditingWorkspaceId(null)
                setShowCreateModal(true)
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex-shrink-0 p-1.5 sm:p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-background-tertiary rounded-lg transition-all hover:scale-105 active:scale-95 touch-manipulation"
              aria-label="Yeni çalışma alanı oluştur"
            >
              <Plus className="w-4 h-4 sm:w-5 sm:h-5 text-text-tertiary" />
            </button>
          </motion.div>
        </div>
      </div>

      {/* Workspace Manage Popup */}
      <WorkspaceManagePopup
        isOpen={showManagePopup}
        onClose={() => setShowManagePopup(false)}
        workspaces={workspaces}
        currentWorkspaceId={currentWorkspaceId}
        onEdit={handleEdit}
        onDelete={handleDeleteClick}
        onReorder={handleReorder}
      />

      {/* Create/Edit Workspace Modal */}
      <CreateWorkspaceModal
        isOpen={showCreateModal}
        onClose={() => {
          setShowCreateModal(false)
          setEditingWorkspaceId(null)
        }}
        editingWorkspace={editingWorkspaceId ? workspaces.find((w) => w.id === editingWorkspaceId) : null}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => {
          setShowDeleteConfirm(false)
          setWorkspaceToDelete(null)
        }}
        onConfirm={handleDelete}
        title="Çalışma Alanını Sil"
        message={
          workspaceToDelete
            ? `"${workspaces.find((w) => w.id === workspaceToDelete)?.name}" isimli çalışma alanını silmek istediğinizden emin misiniz? Bu çalışma alanındaki tüm görevler başka bir çalışma alanına taşınacaktır.`
            : ''
        }
        confirmText="Sil"
        cancelText="İptal"
        confirmButtonColor="danger"
      />
    </>
  )
}
