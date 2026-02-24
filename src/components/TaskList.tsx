import { memo } from 'react'
import { DndContext, closestCenter, KeyboardSensor, TouchSensor, MouseSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { TaskWithSubtasks } from '../types/task'
import { Task } from './Task'
import { useTasks } from '../contexts/TasksContext'

interface SortableTaskProps {
  task: TaskWithSubtasks
  depth?: number
}

function SortableTask({ task, depth = 0 }: SortableTaskProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <div className="flex items-start gap-1">
        <button
          {...attributes}
          {...listeners}
          className="mt-3 p-2 cursor-grab active:cursor-grabbing text-text-tertiary hover:text-text-secondary transition-colors touch-none"
        >
          <GripVertical className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <Task task={task} depth={depth} />
        </div>
      </div>
    </div>
  )
}

export const TaskList = memo(function TaskList() {
  const { filteredAndSortedTasks, updateTask } = useTasks()
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

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event

    if (!over || active.id === over.id) return

    const rootTasks = filteredAndSortedTasks
    const oldIndex = rootTasks.findIndex(t => t.id === active.id)
    const newIndex = rootTasks.findIndex(t => t.id === over.id)

    if (oldIndex === -1 || newIndex === -1) return

    // Reorder the array
    const reordered = arrayMove(rootTasks, oldIndex, newIndex)

    // Persist new positions for every task whose index changed
    const updates: Array<{ id: string; position: number }> = reordered
      .map((task: TaskWithSubtasks, index: number) => ({ id: task.id, position: index }))
      .filter((item: { id: string; position: number }, index: number) => rootTasks[index]?.id !== item.id)

    await Promise.all(
      updates.map(({ id, position }: { id: string; position: number }) =>
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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={rootTaskIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {filteredAndSortedTasks.map((task) => (
            <SortableTask key={task.id} task={task} depth={0} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
})
