import { useState, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DndContext, closestCenter, KeyboardSensor, TouchSensor, MouseSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { TaskWithSubtasks } from '../types/task'
import { Task } from './Task'
import { useTasks } from '../contexts/TasksContext'

interface TaskRowProps {
  task: TaskWithSubtasks
  depth?: number
  dragHandleProps?: any
}

function TaskRow({ task, depth = 0, dragHandleProps }: TaskRowProps) {
  return (
    <div className="flex items-start gap-1">
      <button
        {...dragHandleProps}
        className="mt-3 p-2 cursor-grab active:cursor-grabbing text-text-tertiary hover:text-text-secondary transition-colors touch-none"
      >
        <GripVertical className="w-5 h-5" />
      </button>
      <div className="flex-1 min-w-0">
        <Task task={task} depth={depth} />
      </div>
    </div>
  )
}

interface SortableTaskProps {
  task: TaskWithSubtasks
  depth?: number
}

function SortableTask({ task, depth = 0 }: SortableTaskProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  // CSS.Translate is smoother and prevents scale-clipping bugs during list reorders
  const style = {
    transform: CSS.Translate.toString(transform),
    transition: transition || 'transform 250ms cubic-bezier(0.2, 0, 0, 1)',
    opacity: isDragging ? 0.3 : 1, // original item becomes ghost
    zIndex: isDragging ? 0 : 1,
  }

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      layout={!isDragging}
      transition={{ layout: { duration: 0.4, ease: [0.4, 0, 0.2, 1] } }}
    >
      <TaskRow task={task} depth={depth} dragHandleProps={{ ...attributes, ...listeners }} />
    </motion.div>
  )
}

export const TaskList = memo(function TaskList() {
  const { filteredAndSortedTasks, updateTask } = useTasks()
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  const handleDragCancel = () => {
    setActiveId(null)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event

    if (!over || active.id === over.id) return

    const rootTasks = filteredAndSortedTasks
    const oldIndex = rootTasks.findIndex(t => t.id === active.id)
    const newIndex = rootTasks.findIndex(t => t.id === over.id)

    if (oldIndex === -1 || newIndex === -1) return

    // Reorder the array
    const reordered = arrayMove(rootTasks, oldIndex, newIndex)

    // Persist new positions for every task whose index changed
    const updates = reordered
      .map((task: TaskWithSubtasks, index: number) => ({ id: task.id, position: index }))
      .filter((item, index) => rootTasks[index]?.id !== item.id)

    await Promise.all(
      updates.map(({ id, position }) =>
        updateTask(id, { position }, true /* suppressToast */)
      )
    )
  }

  if (filteredAndSortedTasks.length === 0) {
    return (
      <div className="text-center py-12 text-text-tertiary">
        <p>Görev bulunamadı. Başlamak için ilk görevinizi oluşturun!</p>
      </div>
    )
  }

  const rootTaskIds = filteredAndSortedTasks.map((task) => task.id)
  const activeTask = activeId ? filteredAndSortedTasks.find(t => t.id === activeId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={rootTaskIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-2 relative">
          <AnimatePresence initial={false}>
            {filteredAndSortedTasks.map((task) => (
              <SortableTask key={task.id} task={task} depth={0} />
            ))}
          </AnimatePresence>
        </div>
      </SortableContext>
      
      {/* DragOverlay mounts the active item in a portal to pop it out of layout */}
      <DragOverlay
        dropAnimation={{
          // Adds a nice snapping animation when dropping
          sideEffects: defaultDropAnimationSideEffects({
            styles: {
              active: {
                opacity: '0.4',
              },
            },
          }),
        }}
      >
        {activeTask ? (
          <div className="opacity-100 shadow-2xl scale-[1.02] cursor-grabbing rotate-1 rounded-xl transition-transform origin-center">
            <TaskRow task={activeTask} depth={0} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
})
