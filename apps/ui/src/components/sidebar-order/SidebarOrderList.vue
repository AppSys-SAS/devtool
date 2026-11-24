<script setup lang="ts">
import { ref } from "vue";
import { Icon } from "@iconify/vue";
import { GripVertical } from "@lucide/vue";
import type { SidebarOrderItem } from "@/composables/useSidebarOrderEdit";

const props = defineProps<{
  /** The items, in the order shown. */
  items: SidebarOrderItem[];
  /** Whether the items can be dragged into a new order. */
  draggable: boolean;
}>();

const emit = defineEmits<{
  move: [keys: string[]];
}>();

defineSlots<{
  default?: (props: { item: SidebarOrderItem }) => unknown;
}>();

const dragged = ref<string | null>(null);

/**
 * Starts dragging an item.
 * @param event The drag event.
 * @param key The item.
 */
function dragStart(event: DragEvent, key: string): void {
  dragged.value = key;
  event.dataTransfer?.setData("text/plain", key);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

/**
 * Drops the dragged item at the place of another one.
 * @param key The item dropped on.
 */
function drop(key: string): void {
  const moved = dragged.value;
  dragged.value = null;
  if (!moved || moved === key) {
    return;
  }
  const keys = props.items.map((item) => item.key).filter((item) => item !== moved);
  keys.splice(keys.indexOf(key) + (props.items.findIndex((item) => item.key === moved) < props.items.findIndex((item) => item.key === key) ? 1 : 0), 0, moved);
  emit("move", keys);
}
</script>

<template>
  <ul class="space-y-1">
    <li
      v-for="item in items"
      :key="item.key"
      :draggable="draggable"
      class="rounded-md"
      :class="{ 'opacity-50': dragged === item.key }"
      @dragstart.stop="dragStart($event, item.key)"
      @dragend.stop="dragged = null"
      @dragover.prevent.stop
      @drop.prevent.stop="drop(item.key)"
    >
      <div
        class="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
        :class="draggable ? 'cursor-grab bg-background active:cursor-grabbing' : 'border-transparent'"
      >
        <GripVertical
          v-if="draggable"
          class="size-3.5 shrink-0 text-muted-foreground"
        />
        <Icon
          :icon="item.icon"
          class="size-3.5 shrink-0 text-muted-foreground"
        />
        <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
      </div>
      <slot :item="item" />
    </li>
  </ul>
</template>
