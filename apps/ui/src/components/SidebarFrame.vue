<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { onKeyStroke } from '@vueuse/core'
import { cn } from '@/lib/utils'
import layoutStore, { type SidebarSide } from '@/stores/layout'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  side: SidebarSide
  tag?: string
}>(), { tag: 'div' })

const route = useRoute()
const visible = computed(() => layoutStore.isVisible(props.side))
const overlaid = computed(() => layoutStore.covers(props.side))
const panel = useTemplateRef<HTMLElement>('panel')
let opener: HTMLElement | null = null

watch(overlaid, async isOverlaid => {
  if (isOverlaid) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  await nextTick()
  if (isOverlaid) {
    panel.value?.focus()
  } else {
    restoreFocus()
  }
})

/**
 * Gives the focus back to the element that opened the sidebar over the page, when it is still shown.
 */
function restoreFocus (): void {
  if (opener?.isConnected) {
    opener.focus()
  }
  opener = null
}

onMounted(() => {
  layoutStore.frames.value[props.side] += 1
})
onBeforeUnmount(() => {
  layoutStore.frames.value[props.side] -= 1
  if (layoutStore.opened.value === props.side) {
    layoutStore.close()
    restoreFocus()
  }
})
watch(() => route.fullPath, () => layoutStore.close())
onKeyStroke('Escape', event => {
  if (overlaid.value && !event.defaultPrevented && !document.querySelector('[data-dismissable-layer]')) {
    layoutStore.close()
  }
})

/**
 * Closes the sidebar opened over the page once one of its links is followed.
 * @param event The click inside the sidebar.
 */
function closeOnLink (event: MouseEvent): void {
  if (overlaid.value && event.target instanceof Element && event.target.closest('a')) {
    layoutStore.close()
  }
}
</script>

<template>
  <div
    v-if="overlaid"
    class="fixed inset-0 z-50 bg-black/50"
    aria-hidden="true"
    @click="layoutStore.close()"
  />
  <component
    :is="tag"
    v-show="visible"
    :id="`${side}-sidebar`"
    ref="panel"
    v-bind="$attrs"
    :role="overlaid ? 'dialog' : undefined"
    :aria-modal="overlaid ? 'true' : undefined"
    :aria-label="overlaid ? `${side === 'left' ? 'Left' : 'Right'} sidebar` : undefined"
    :tabindex="overlaid ? -1 : undefined"
    :class="cn('flex shrink-0', overlaid && ['fixed inset-y-0 z-50 max-w-[85vw] overflow-hidden shadow-xl', side === 'left' ? 'left-0' : 'right-0'])"
    @click="closeOnLink"
  >
    <slot />
  </component>
</template>
