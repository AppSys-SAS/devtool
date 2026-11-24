<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ChevronRight, FileCog, FileKey, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Pencil, Sparkles, Trash2, TriangleAlert } from '@lucide/vue'
import { agentSkillFolderOf, type AgentSkillSummary, type FileEntryPayload } from '@appsys/devtool-shared'
import { cn } from '@/lib/utils'

interface TreeNode {
  name: string
  path: string
  kind: FileEntryPayload['kind']
  children: TreeNode[]
}

const props = withDefaults(
  defineProps<{
    entries: FileEntryPayload[]
    current: string | null
    dirty: boolean
    editable: boolean
    /** The agent skills of the folders at the root, null when the folder does not hold agent skills. */
    agentSkills?: AgentSkillSummary[] | null
  }>(),
  { agentSkills: null }
)

const router = useRouter()

const emit = defineEmits<{
  create: [parent: string, kind: FileEntryPayload['kind']]
  rename: [path: string]
  remove: [path: string, kind: FileEntryPayload['kind']]
}>()

const expanded = shallowRef(new Set<string>())

/**
 * Lists the folders holding a path.
 * @param path The path.
 * @returns The paths of its parent folders, outermost first.
 */
function ancestorsOf (path: string): string[] {
  const segments = path.split('/')
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'))
}

/**
 * Chooses the icon of a file from its name.
 * @param name The name of the file.
 * @returns The icon component.
 */
function fileIcon (name: string) {
  if (/\.(key|pem|crt|pub)$/.test(name)) {
    return FileKey
  }
  return /\.(ya?ml|json|toml|ini|conf)$/.test(name) ? FileCog : FileText
}

const root = computed(() => {
  const nodes = new Map<string, TreeNode>([['', { name: '', path: '', kind: 'directory', children: [] }]])
  const add = (path: string, kind: FileEntryPayload['kind']): TreeNode => {
    const existing = nodes.get(path)
    if (existing) {
      return existing
    }

    const separator = path.lastIndexOf('/')
    const node: TreeNode = { name: path.slice(separator + 1), path, kind, children: [] }
    nodes.set(path, node)
    add(separator === -1 ? '' : path.slice(0, separator), 'directory').children.push(node)
    return node
  }
  for (const entry of props.entries) {
    add(entry.path, entry.kind)
  }

  for (const node of nodes.values()) {
    node.children.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory'))
  }
  return nodes.get('')!
})

const skillsByFolder = computed(() => new Map(props.agentSkills?.map(skill => [skill.folder, skill])))

const rows = computed(() => {
  const visible: { node: TreeNode, depth: number, skill: AgentSkillSummary | null }[] = []
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children) {
      visible.push({ node: child, depth, skill: depth === 0 ? (skillsByFolder.value.get(child.path) ?? null) : null })
      if (child.kind === 'directory' && (!props.editable || expanded.value.has(child.path))) {
        walk(child, depth + 1)
      }
    }
  }
  walk(root.value, 0)
  return visible
})

watch(
  () => props.current,
  current => {
    if (current) {
      expanded.value = new Set([...expanded.value, ...ancestorsOf(current)])
    }
  },
  { immediate: true }
)

/**
 * Opens or closes a folder.
 * @param path The path of the folder.
 */
function toggle (path: string): void {
  const next = new Set(expanded.value)
  if (!next.delete(path)) {
    next.add(path)
  }
  expanded.value = next
}

/**
 * Opens the `SKILL.md` of a skill not shown yet, or opens or closes its folder.
 * @param path The path of the folder of the skill.
 */
function selectSkill (path: string): void {
  const skillFile = props.entries.find(entry => entry.kind === 'file' && agentSkillFolderOf(entry.path) === path)?.path
  if (!skillFile || props.current === skillFile) {
    toggle(path)
    return
  }
  void router.push({ query: { path: skillFile } })
}
</script>

<template>
  <div class="flex flex-col gap-0.5">
    <div
      v-for="{ node, depth, skill } in rows"
      :key="node.path"
      class="group relative flex items-center"
    >
      <button
        v-if="skill"
        type="button"
        :class="cn(
          'flex min-w-0 flex-1 items-start gap-1.5 rounded-md py-1.5 pr-2 pl-2 text-left text-sm transition-colors',
          current?.startsWith(`${node.path}/`) ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )"
        @click="selectSkill(node.path)"
      >
        <ChevronRight
          :class="cn('mt-0.5 size-3.5 shrink-0 transition-transform', expanded.has(node.path) && 'rotate-90')"
          @click.stop="toggle(node.path)"
        />
        <Sparkles class="mt-0.5 size-4 shrink-0" />
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1">
            <span class="truncate">{{ node.name }}</span>
            <span
              v-if="skill.problems.length"
              :title="skill.problems.join('\n')"
            >
              <TriangleAlert class="size-3.5 shrink-0 text-amber-500" />
            </span>
          </span>
          <span
            v-if="skill.description"
            class="line-clamp-2 text-xs text-muted-foreground"
          >{{ skill.description }}</span>
        </span>
      </button>
      <button
        v-else-if="node.kind === 'directory'"
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        :style="{ paddingLeft: `${0.5 + depth * 0.875}rem` }"
        @click="toggle(node.path)"
      >
        <ChevronRight
          v-if="editable"
          :class="cn('size-3.5 shrink-0 transition-transform', expanded.has(node.path) && 'rotate-90')"
        />
        <FolderOpen
          v-if="!editable || expanded.has(node.path)"
          class="size-4 shrink-0"
        />
        <Folder
          v-else
          class="size-4 shrink-0"
        />
        <span class="truncate">{{ node.name }}</span>
      </button>
      <RouterLink
        v-else
        :to="{ query: { path: node.path } }"
        :class="cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors',
          node.path === current ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )"
        :style="{ paddingLeft: `${(editable ? 1.375 : 0.5) + depth * 0.875}rem` }"
      >
        <component
          :is="fileIcon(node.name)"
          class="size-4 shrink-0"
        />
        <span class="truncate">{{ node.name }}</span>
        <span
          v-if="dirty && node.path === current"
          class="ml-auto size-2 shrink-0 rounded-full bg-amber-500"
        />
      </RouterLink>

      <div
        v-if="editable"
        class="absolute right-1 hidden items-center rounded-md bg-card group-hover:flex"
      >
        <template v-if="node.kind === 'directory'">
          <button
            type="button"
            title="New file"
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            @click="emit('create', node.path, 'file')"
          >
            <FilePlus class="size-3.5" />
          </button>
          <button
            type="button"
            title="New folder"
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            @click="emit('create', node.path, 'directory')"
          >
            <FolderPlus class="size-3.5" />
          </button>
        </template>
        <button
          type="button"
          title="Rename or move"
          class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          @click="emit('rename', node.path)"
        >
          <Pencil class="size-3.5" />
        </button>
        <button
          type="button"
          title="Remove"
          class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
          @click="emit('remove', node.path, node.kind)"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
