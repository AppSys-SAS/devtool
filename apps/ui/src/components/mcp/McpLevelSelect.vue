<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from "reka-ui";
import type { McpLevel } from "@appsys/devtool-shared";
import { Badge } from "@/components/ui/badge";
import { LEVELS } from "@/lib/mcp";

defineProps<{
  /** The level shown, null for a level about to be inherited. */
  level: McpLevel | null;
  /** Where the level comes from, or that it is changed. */
  title: string;
  /** Whether the level is a change not written yet. */
  staged: boolean;
  /** The levels offered. */
  levels: readonly McpLevel[];
  /** Why the level cannot be changed, null when it can. */
  blocked: string | null;
}>();

const emit = defineEmits<{
  select: [level: McpLevel | null];
}>();
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger
      :disabled="blocked !== null"
      :title="blocked ?? title"
      class="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Badge
        :class="[level ? LEVELS[level] : 'border-dashed text-muted-foreground', staged ? 'ring-2 ring-sky-500/70' : '']"
        class="cursor-pointer gap-0.5"
      >
        {{ level ?? "inherit" }}
        <ChevronDown class="size-3" />
      </Badge>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        :side-offset="4"
        class="z-50 min-w-36 rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-md"
      >
        <DropdownMenuItem
          v-for="item in levels"
          :key="item"
          class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent"
          @select="emit('select', item)"
        >
          <Badge :class="LEVELS[item]">
            {{ item }}
          </Badge>
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />
        <DropdownMenuItem
          class="cursor-pointer rounded-sm px-2 py-1.5 text-muted-foreground outline-none data-[highlighted]:bg-accent data-[highlighted]:text-foreground"
          @select="emit('select', null)"
        >
          Inherit
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
