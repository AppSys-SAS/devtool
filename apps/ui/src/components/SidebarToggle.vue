<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import layoutStore, { type SidebarSide } from '@/stores/layout'

const props = defineProps<{
  side: SidebarSide
  /** Whether the button stands in the bar shown over a narrow page, the only place it shows in a narrow window. */
  inBar?: boolean
}>()

const available = computed(() => layoutStore.frames.value[props.side] > 0 && (props.inBar || !layoutStore.narrow.value))
const visible = computed(() => layoutStore.isVisible(props.side))
const icon = computed(() => {
  if (props.side === 'left') {
    return visible.value ? PanelLeftClose : PanelLeftOpen
  }
  return visible.value ? PanelRightClose : PanelRightOpen
})

onMounted(() => {
  layoutStore.collapsibleViews.value += 1
})

onBeforeUnmount(() => {
  layoutStore.collapsibleViews.value -= 1
})
</script>

<template>
  <Button
    v-if="available"
    size="icon"
    variant="ghost"
    class="size-7"
    :title="`${visible ? 'Hide' : 'Show'} the ${side} sidebar`"
    :aria-label="`${visible ? 'Hide' : 'Show'} the ${side} sidebar`"
    :aria-expanded="visible"
    :aria-controls="`${side}-sidebar`"
    @click="layoutStore.toggle(side)"
  >
    <component
      :is="icon"
      class="size-3.5"
    />
  </Button>
</template>
