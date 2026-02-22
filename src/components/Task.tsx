import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronDown,
  Check,
  Trash2,
  Edit,
  Plus,
  Calendar,
  CalendarPlus,
  Flag,
  Sparkles,
  Image as ImageIcon,
  Link as LinkIcon,
  X,
  Folder,
  Loader2
} from 'lucide-react'
import { Portal } from './Portal'
import { TaskWithSubtasks } from '../types/task'
import { useTasks } from '../contexts/TasksContext'
import { useTags } from '../contexts/TagsContext'
import { useAttachments } from '../contexts/AttachmentsContext'
import { useToast } from '../contexts/ToastContext'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspaces } from '../contexts/WorkspacesContext'
import { useCalendar } from '../contexts/CalendarContext'
import { getSupabaseClient } from '../lib/supabase'
import { calculateCompletionPercentage } from '../utils/taskUtils'
import { isPast, isToday } from 'date-fns'
import { getDeadlineColor, formatDeadline } from '../utils/dateUtils'
import { TaskForm } from './TaskForm'
import { AISuggestionsModal } from './AISuggestionsModal'
import { TagBadge } from './TagBadge'
import { BackgroundImageUpload } from './BackgroundImageUpload'
import { LinkAttachmentModal } from './LinkAttachmentModal'
import { ImageAttachmentModal } from './ImageAttachmentModal'
import { MoveTaskModal } from './MoveTaskModal'
import { ConfirmDialog } from './ConfirmDialog'
import { getImageUrl } from '../lib/storage'
import { TaskLink, TaskImage } from '../types/attachment'
import { getColorIdFromHex, getColorHexFromId } from '../utils/colorUtils'

interface TaskProps {
  task: TaskWithSubtasks
  depth?: number
}

export function Task({ task, depth = 0 }: TaskProps) {
  const { toggleTaskComplete, deleteTask, addAISuggestions, updateTask } = useTasks()
  const { getTaskTags, removeTagFromTask } = useTags()
  const { getTaskLinks, addTaskLink, updateTaskLink, deleteTaskLink, getTaskImages, addTaskImage, deleteTaskImage } = useAttachments()
  const { showToast } = useToast()
  const { user } = useAuth()
  const { workspaces, currentWorkspaceId } = useWorkspaces()
  const { createEvent } = useCalendar()

  // Persist expand/collapse state in localStorage
  const getStoredExpandedState = (): boolean => {
    try {
      const stored = localStorage.getItem(`task-expanded-${task.id}`)
      return stored !== null ? stored === 'true' : false // Default to collapsed
    } catch {
      return false
    }
  }

  const [isExpanded, setIsExpanded] = useState(getStoredExpandedState)
  const [showActionMenu, setShowActionMenu] = useState(false)

  // Update localStorage when expand state changes
  const handleToggleExpand = () => {
    const newState = !isExpanded
    setIsExpanded(newState)
    try {
      localStorage.setItem(`task-expanded-${task.id}`, String(newState))
    } catch (err) {
      console.warn('Failed to save expand state to localStorage:', err)
    }
  }

  const [isEditing, setIsEditing] = useState(false)
  const [showAddSubtask, setShowAddSubtask] = useState(false)
  const [showAISuggestions, setShowAISuggestions] = useState(false)
  const [taskTags, setTaskTags] = useState<any[]>([])
  const [taskLinks, setTaskLinks] = useState<TaskLink[]>([])
  const [taskImages, setTaskImages] = useState<TaskImage[]>([])
  const [showBackgroundModal, setShowBackgroundModal] = useState(false)
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [editingLink, setEditingLink] = useState<TaskLink | null>(null)
  const [viewingImage, setViewingImage] = useState<TaskImage | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showMoveModal, setShowMoveModal] = useState(false)
  const [isAddingToCalendar, setIsAddingToCalendar] = useState(false)

  // Load task tags
  useEffect(() => {
    getTaskTags(task.id).then(setTaskTags)
  }, [task.id, getTaskTags])

  // Load task links
  useEffect(() => {
    getTaskLinks(task.id).then(setTaskLinks)
  }, [task.id, getTaskLinks])

  // Load task images
  useEffect(() => {
    getTaskImages(task.id).then(setTaskImages)
  }, [task.id, getTaskImages])

  // Handle ESC key for image modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewingImage) {
        setViewingImage(null)
      }
    }
    if (viewingImage) {
      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
    }
  }, [viewingImage])

  // Subscribe to task_tags changes for this specific task
  useEffect(() => {
    if (!user?.id || task.id.startsWith('temp-')) {
      return
    }

    const supabase = getSupabaseClient()
    const channelName = `task-tags-${task.id}-${user.id}`

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'task_tags',
          filter: `task_id=eq.${task.id}`,
        },
        () => {
          // Refresh tags when task_tags change
          getTaskTags(task.id).then(setTaskTags)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [task.id, user?.id, getTaskTags])

  const handleRemoveTag = async (tagId: string) => {
    try {
      await removeTagFromTask(task.id, tagId)
      // Optimistically update UI
      setTaskTags((prevTags) => prevTags.filter((tag) => tag.id !== tagId))
      showToast('Etiket başarıyla kaldırıldı', 'success', 2000)
    } catch (err) {
      console.error('Error removing tag:', err)
      showToast('Etiket kaldırılamadı', 'error', 3000)
      // Refresh tags on error to restore correct state
      getTaskTags(task.id).then(setTaskTags)
    }
  }

  const handleSaveBackgroundImage = async (imageUrl: string | null, displayMode: 'thumbnail' | 'icon' | null) => {
    try {
      await updateTask(task.id, {
        background_image_url: imageUrl,
        background_image_display_mode: displayMode,
      })
      showToast('Arka plan resmi güncellendi', 'success', 2000)
    } catch (err) {
      console.error('Error updating background image:', err)
      showToast('Arka plan resmi güncellenemedi', 'error', 3000)
    }
  }

  const handleAddLink = async (url: string, displayName: string) => {
    try {
      if (editingLink) {
        await updateTaskLink(editingLink.id, { url, display_name: displayName || null })
        showToast('Bağlantı güncellendi', 'success', 2000)
        setEditingLink(null)
      } else {
        await addTaskLink(task.id, url, displayName)
        showToast('Bağlantı eklendi', 'success', 2000)
      }
      getTaskLinks(task.id).then(setTaskLinks)
    } catch (err) {
      console.error('Error saving link:', err)
      showToast('Bağlantı kaydedilemedi', 'error', 3000)
    }
  }

  const handleDeleteLink = async (linkId: string) => {
    try {
      await deleteTaskLink(linkId)
      setTaskLinks((prev) => prev.filter((link) => link.id !== linkId))
      showToast('Bağlantı silindi', 'success', 2000)
    } catch (err) {
      console.error('Error deleting link:', err)
      showToast('Bağlantı silinemedi', 'error', 3000)
    }
  }

  const handleAddImage = async (storagePath: string, fileName: string, fileSize: number, mimeType: string) => {
    try {
      await addTaskImage(task.id, storagePath, fileName, fileSize, mimeType)
      getTaskImages(task.id).then(setTaskImages)
    } catch (err) {
      console.error('Error adding image:', err)
      showToast('Resim eklenemedi', 'error', 3000)
    }
  }

  const handleDeleteImage = async (imageId: string) => {
    try {
      await deleteTaskImage(imageId)
      setTaskImages((prev) => prev.filter((img) => img.id !== imageId))
      showToast('Resim silindi', 'success', 2000)
    } catch (err) {
      console.error('Error deleting image:', err)
      showToast('Resim silinemedi', 'error', 3000)
    }
  }

  const hasSubtasks = task.subtasks && task.subtasks.length > 0
  const completionPercentage = calculateCompletionPercentage(task)
  const isOverdue = task.deadline && !task.completed && isPast(new Date(task.deadline)) && !isToday(new Date(task.deadline))

  const getPriorityStyles = () => {
    switch (task.priority) {
      case 'high':
        return 'text-danger bg-danger/10 border-danger/20'
      case 'medium':
        return 'text-warning bg-warning/10 border-warning/20'
      case 'low':
        return 'text-success bg-success/10 border-success/20'
      default:
        return 'text-text-tertiary bg-white/5 border-white/5'
    }
  }

  const handleToggleComplete = async () => {
    await toggleTaskComplete(task.id)
  }



  const handleAddToCalendar = async () => {
    setIsAddingToCalendar(true)
    try {
      // To preserve local time and avoid Google Calendar treating it as UTC (which causes a 3hr offset in Turkey timezone),
      // we format the local date as an ISO-like string WITHOUT the 'Z' suffix.
      let dateString: string

      const getLocalIsoString = (date: Date) => {
        const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
        const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, -1);
        // Ensure seconds are present (Google Calendar API requires RFC3339 format)
        // Format should be: "YYYY-MM-DDTHH:mm:ss" (19 characters)
        if (localISOTime.length === 16) {
          // Missing seconds, add ":00"
          return localISOTime + ':00'
        } else if (localISOTime.length >= 19) {
          // Has seconds or more, take first 19 chars (YYYY-MM-DDTHH:mm:ss)
          return localISOTime.slice(0, 19)
        }
        return localISOTime;
      }

      if (task.deadline) {
        const deadlineDate = new Date(task.deadline)
        dateString = getLocalIsoString(deadlineDate)
      } else {
        const now = new Date()
        const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000)
        dateString = getLocalIsoString(oneHourLater)
      }

      // Get color from task's color_id (preferred) or workspace color (fallback)
      let taskColor: string | undefined = undefined
      let colorId: string | undefined = undefined

      // First, try to get color from task's color_id
      if (task.color_id !== null && task.color_id !== undefined) {
        colorId = task.color_id.toString()
        taskColor = getColorHexFromId(task.color_id) || undefined
      } else {
        // Fallback: get color from workspace
        let workspace = task.workspace_id
          ? workspaces.find(w => w.id === task.workspace_id)
          : null

        // Fallback: if workspace not found, use current workspace
        if (!workspace && currentWorkspaceId) {
          workspace = workspaces.find(w => w.id === currentWorkspaceId) || null
        }

        if (workspace?.color) {
          taskColor = workspace.color
          const id = getColorIdFromHex(workspace.color)
          if (id !== null) {
            colorId = id.toString()
          }
        }
      }

      const endDate = new Date(new Date(dateString).getTime() + 60 * 60 * 1000) // 1 hour duration
      const endDateString = getLocalIsoString(endDate)

      const event = await createEvent({
        summary: task.title,
        description: task.description || '',
        start: dateString,
        end: endDateString,
        color: taskColor,
        colorId: colorId,
      })

      if (!event) {
        throw new Error('Etkinlik oluşturulamadı. Google Takvim\'in bağlı olduğundan emin olun.')
      }

      showToast('Takvime eklendi ✓', 'success', 2000)
    } catch (err) {
      console.error('Error adding task to calendar:', err)
      const errorMessage = err instanceof Error ? err.message : 'Takvime eklenemedi. Lütfen tekrar deneyin.'
      showToast(errorMessage, 'error', 4000)
    } finally {
      setIsAddingToCalendar(false)
    }
  }

  if (isEditing) {
    return (
      <TaskForm
        task={task}
        onCancel={() => setIsEditing(false)}
        onSave={() => setIsEditing(false)}
      />
    )
  }

  const backgroundImageUrl = task.background_image_url
  const displayMode = task.background_image_display_mode || 'thumbnail'
  const hasAttachments = taskLinks.length > 0 || taskImages.length > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="group mb-3"
      style={{ marginLeft: `${Math.min(depth * 24, 72)}px` }}
    >
      <div
        className={`
          relative rounded-xl border transition-all duration-300 overflow-hidden cursor-pointer
          ${task.completed ? 'bg-background-secondary/30 border-white/5 opacity-70' : 'bg-background-secondary/60 backdrop-blur-md border-white/10 shadow-glass hover:shadow-glass-lg hover:border-primary/20 hover:bg-background-secondary/80'}
          ${isOverdue ? 'border-danger/30 bg-danger/5' : ''}
        `}
        onClick={(e) => {
          // Don't open menu when clicking interactive elements
          const target = e.target as HTMLElement
          const interactive = target.closest('button, a, input, textarea, label, [role="button"]')
          if (!interactive) setShowActionMenu(true)
        }}
      >
        {/* Background Image - Thumbnail Mode */}
        {backgroundImageUrl && displayMode === 'thumbnail' && (
          <div className="h-32 w-full overflow-hidden relative">
            <img
              src={backgroundImageUrl}
              alt="Backdrop"
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background-secondary/90 to-transparent" />
          </div>
        )}

        <div className="p-4 flex gap-4">
          {/* Checkbox */}
          <button
            onClick={handleToggleComplete}
            className={`
              flex-shrink-0 w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all duration-300 mt-0.5
              ${task.completed
                ? 'bg-primary border-primary shadow-glow-primary'
                : 'border-white/20 hover:border-primary text-transparent hover:text-primary/30'
              }
            `}
          >
            <Check className={`w-3.5 h-3.5 text-white transition-transform duration-200 ${task.completed ? 'scale-100' : 'scale-0'}`} strokeWidth={3} />
          </button>

          {/* Icon Mode Image */}
          {backgroundImageUrl && displayMode === 'icon' && (
            <div className="flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden border border-white/10 shadow-md">
              <img
                src={backgroundImageUrl}
                alt="Thumbnail"
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            </div>
          )}

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            <div className="flex justify-between items-start gap-2">
              <div className="space-y-1 flex-1 min-w-0">
                <h3 className={`text-base font-medium leading-snug break-words transition-colors ${task.completed ? 'text-text-tertiary line-through decoration-2 decoration-text-tertiary/30' : 'text-text-primary'}`}>
                  {task.title}
                </h3>
                {task.description && (
                  <p className="text-sm text-text-tertiary line-clamp-2 break-words">{task.description}</p>
                )}
              </div>
            </div>

            {/* Metadata Chips */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {task.priority && (
                <span className={`px-2 py-0.5 rounded-md text-xs font-medium border flex items-center gap-1 ${getPriorityStyles()}`}>
                  <Flag className="w-3 h-3" />
                  {task.priority === 'high' ? 'Yüksek' : task.priority === 'medium' ? 'Orta' : 'Düşük'}
                </span>
              )}

              {task.deadline && (
                <span className={`px-2 py-0.5 rounded-md text-xs font-medium border flex items-center gap-1 ${getDeadlineColor(task.deadline)} ${isOverdue ? 'bg-danger/10 border-danger/20' : ''}`}>
                  <Calendar className="w-3 h-3" />
                  {formatDeadline(task.deadline)}
                </span>
              )}

              {taskTags.map(tag => (
                <TagBadge key={tag.id} tag={tag} size="sm" onRemove={() => handleRemoveTag(tag.id)} />
              ))}

              {/* Creation Date (optional, mostly distinct) */}
              {/* <span className="text-xs text-text-tertiary">{formatCreationDate(task.created_at)}</span> */}
            </div>

            {/* Progress Bar */}
            {hasSubtasks && (
              <div className="mt-3 flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${completionPercentage}%` }}
                    className="h-full bg-primary shadow-glow-primary"
                  />
                </div>
                <span className="text-xs text-text-tertiary font-medium">{completionPercentage}%</span>
              </div>
            )}

            {/* Attachments Preview */}
            {hasAttachments && (
              <div className="mt-4 pt-3 border-t border-white/5">
                {/* Images */}
                {taskImages.length > 0 && (
                  <div className="flex gap-2 mb-2 overflow-x-auto pb-1 scrollbar-hide">
                    {taskImages.map((img) => (
                      <div key={img.id} className="relative group/img flex-shrink-0">
                        <button
                          onClick={() => setViewingImage(img)}
                          className="w-16 h-16 rounded-lg border border-white/10 overflow-hidden hover:border-primary/50 transition-colors"
                        >
                          <img
                            src={getImageUrl(img.storage_path)}
                            alt={img.file_name}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="64" height="64"%3E%3Crect width="64" height="64" fill="%23121212"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%239ca3af" font-size="10"%3EImage%3C/text%3E%3C/svg%3E'
                            }}
                          />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-opacity">
                            <ImageIcon className="w-4 h-4 text-white" />
                          </div>
                        </button>
                        <button
                          onClick={() => handleDeleteImage(img.id)}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-danger text-white rounded-full flex items-center justify-center opacity-0 group-hover/img:opacity-100 shadow-lg scale-90 hover:scale-110 transition-all"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {/* Links */}
                <div className="space-y-1">
                  {taskLinks.map(link => (
                    <div key={link.id} className="flex items-center gap-2 group/link text-sm text-primary hover:text-primary-light">
                      <LinkIcon className="w-3.5 h-3.5" />
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate hover:underline flex-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {link.display_name || link.url}
                      </a>
                      <div className="opacity-0 group-hover/link:opacity-100 flex gap-1">
                        <button onClick={() => { setEditingLink(link); setShowLinkModal(true) }} className="p-1 hover:bg-white/10 rounded"><Edit className="w-3 h-3 text-text-tertiary" /></button>
                        <button onClick={() => handleDeleteLink(link.id)} className="p-1 hover:bg-danger/20 rounded"><Trash2 className="w-3 h-3 text-danger" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Action Menu — centered overlay via Portal */}
        <AnimatePresence>
          {showActionMenu && (
            <Portal>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
                onClick={() => setShowActionMenu(false)}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 20 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                  className="bg-background-elevated/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-4 w-full max-w-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Title */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="min-w-0">
                      <p className="text-xs text-text-tertiary uppercase tracking-wider font-medium mb-0.5">İşlem Seç</p>
                      <p className="text-sm font-medium text-text-primary truncate max-w-[200px]">{task.title}</p>
                    </div>
                    <button
                      onClick={() => setShowActionMenu(false)}
                      className="flex-shrink-0 p-1.5 hover:bg-white/10 text-text-tertiary hover:text-white rounded-lg transition-colors ml-2"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Grid of Actions */}
                  <div className="grid grid-cols-4 gap-2">
                    {/* AI Önerileri */}
                    <button
                      onClick={() => { setShowActionMenu(false); setShowAISuggestions(true) }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-primary/10 text-text-tertiary hover:text-primary transition-all group"
                    >
                      <Sparkles className="w-5 h-5" />
                      <span className="text-[10px] font-medium leading-tight text-center">AI Öneri</span>
                    </button>

                    {/* Takvime Ekle */}
                    <button
                      onClick={() => { setShowActionMenu(false); handleAddToCalendar() }}
                      disabled={isAddingToCalendar}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-primary/10 text-text-tertiary hover:text-primary transition-all group disabled:opacity-40"
                    >
                      {isAddingToCalendar ? <Loader2 className="w-5 h-5 animate-spin" /> : <CalendarPlus className="w-5 h-5" />}
                      <span className="text-[10px] font-medium leading-tight text-center">Takvim</span>
                    </button>

                    {/* Alt Görev */}
                    <button
                      onClick={() => { setShowActionMenu(false); setShowAddSubtask(true) }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-white/10 text-text-tertiary hover:text-white transition-all group"
                    >
                      <Plus className="w-5 h-5" />
                      <span className="text-[10px] font-medium leading-tight text-center">Alt Görev</span>
                    </button>

                    {/* Düzenle */}
                    <button
                      onClick={() => { setShowActionMenu(false); setIsEditing(true) }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-white/10 text-text-tertiary hover:text-white transition-all group"
                    >
                      <Edit className="w-5 h-5" />
                      <span className="text-[10px] font-medium leading-tight text-center">Düzenle</span>
                    </button>

                    {/* Arka Plan */}
                    <button
                      onClick={() => { setShowActionMenu(false); setShowBackgroundModal(true) }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-white/10 text-text-tertiary hover:text-white transition-all group"
                    >
                      <ImageIcon className="w-5 h-5" />
                      <span className="text-[10px] font-medium leading-tight text-center">Arka Plan</span>
                    </button>

                    {/* Bağlantı */}
                    <button
                      onClick={() => { setShowActionMenu(false); setShowLinkModal(true) }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-white/10 text-text-tertiary hover:text-white transition-all group"
                    >
                      <LinkIcon className="w-5 h-5" />
                      <span className="text-[10px] font-medium leading-tight text-center">Bağlantı</span>
                    </button>

                    {/* Taşı */}
                    <button
                      onClick={() => { setShowActionMenu(false); setShowMoveModal(true) }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-white/10 text-text-tertiary hover:text-white transition-all group"
                    >
                      <Folder className="w-5 h-5" />
                      <span className="text-[10px] font-medium leading-tight text-center">Taşı</span>
                    </button>

                    {/* Sil */}
                    <button
                      onClick={() => { setShowActionMenu(false); setShowDeleteConfirm(true) }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-danger/20 text-text-tertiary hover:text-danger transition-all group"
                    >
                      <Trash2 className="w-5 h-5" />
                      <span className="text-[10px] font-medium leading-tight text-center">Sil</span>
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            </Portal>
          )}
        </AnimatePresence>

        {/* Expand/Collapse Button (Bottom Center) */}
        {hasSubtasks && (
          <button
            onClick={handleToggleExpand}
            className="w-full flex items-center justify-center bg-white/5 hover:bg-white/10 py-1 transition-colors border-t border-white/5"
          >
            <ChevronDown className={`w-4 h-4 text-text-tertiary transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {/* Subtasks */}
      <AnimatePresence>
        {hasSubtasks && isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="pl-4 mt-2 border-l-2 border-white/5 ml-4"
          >
            {task.subtasks!.map(subtask => (
              <Task key={subtask.id} task={subtask} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Subtask Form */}
      <AnimatePresence>
        {showAddSubtask && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} className="mt-2 ml-8">
            <TaskForm parentTaskId={task.id} onCancel={() => setShowAddSubtask(false)} onSave={() => setShowAddSubtask(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modals */}
      <AISuggestionsModal task={task} isOpen={showAISuggestions} onClose={() => setShowAISuggestions(false)} onAddSuggestions={(s) => addAISuggestions(task.id, s)} />
      {user && showBackgroundModal && <BackgroundImageUpload currentImageUrl={task.background_image_url} displayMode={task.background_image_display_mode || 'thumbnail'} onSave={handleSaveBackgroundImage} userId={user.id} taskId={task.id} onClose={() => setShowBackgroundModal(false)} />}
      <LinkAttachmentModal isOpen={showLinkModal} onClose={() => { setShowLinkModal(false); setEditingLink(null) }} onSave={handleAddLink} link={editingLink} />
      {user && showImageModal && <ImageAttachmentModal isOpen={showImageModal} onClose={() => setShowImageModal(false)} onSave={handleAddImage} userId={user.id} taskId={task.id} />}
      <ConfirmDialog isOpen={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} onConfirm={async () => { setShowDeleteConfirm(false); await deleteTask(task.id) }} title="Görevi Sil" message="Emin misiniz? Bu işlem tüm alt görevleri de silecektir." confirmButtonColor="danger" />
      <MoveTaskModal isOpen={showMoveModal} onClose={() => setShowMoveModal(false)} task={task} />

      {/* Fullscreen Image */}
      {viewingImage && (
        <AnimatePresence>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/95 backdrop-blur-xl" onClick={() => setViewingImage(null)}>
            <img
              src={getImageUrl(viewingImage.storage_path)}
              alt={viewingImage.file_name}
              className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
            />
            <button className="absolute top-4 right-4 p-2 bg-white/10 rounded-full hover:bg-white/20"><X className="w-6 h-6 text-white" /></button>
          </motion.div>
        </AnimatePresence>
      )}
    </motion.div>
  )
}
