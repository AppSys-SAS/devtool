<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted } from 'vue'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import layoutStore, { rightSidebarKey, type SidebarSide } from '@/stores/layout'

const props = defineProps<{
  side: SidebarSide
}>()

const available = props.side === 'left' || inject(rightSidebarKey, false)
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
    @click="layoutStore.toggle(side)"
  >
    <component
      :is="icon"
      class="size-3.5"
    />
  </Button>
</template>
