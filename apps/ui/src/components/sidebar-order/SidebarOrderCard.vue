<script setup lang="ts">
import { Check, Pencil, X } from "@lucide/vue";
import { SORT_MODES, type SortMode } from "@appsys/devtool-shared";
import ConfigFileChoice from "@/components/ConfigFileChoice.vue";
import SidebarOrderList from "@/components/sidebar-order/SidebarOrderList.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { type SidebarOrderList as OrderedList, useSidebarOrderEdit } from "@/composables/useSidebarOrderEdit";
import configStore from "@/stores/config";

const SORT_LABELS: Record<SortMode, string> = { config: "As configured", name: "By name", manual: "By hand" };
const SORT_OPTIONS = SORT_MODES.map((mode) => ({ label: SORT_LABELS[mode], value: mode }));

const edit = useSidebarOrderEdit();

/**
 * Changes how a list is ordered from its selector.
 * @param list The list.
 * @param value The mode chosen.
 */
function choose(list: OrderedList, value: string | undefined): void {
  if (value && SORT_MODES.includes(value as SortMode)) {
    edit.setSort(list, value as SortMode);
  }
}
</script>

<template>
  <Card class="max-w-3xl">
    <CardHeader class="flex flex-row items-start justify-between gap-3">
      <div class="space-y-1.5">
        <CardTitle>Sidebar</CardTitle>
        <CardDescription>
          The order of the sections, and of the rows and projects of each section.
        </CardDescription>
      </div>
      <div
        v-if="edit.file.value"
        class="flex shrink-0 items-center gap-2"
      >
        <Button
          size="sm"
          variant="ghost"
          class="gap-1.5"
          @click="edit.end(false)"
        >
          <X class="size-3.5" />
          Cancel
        </Button>
        <Button
          size="sm"
          class="gap-1.5"
          @click="edit.end(true)"
        >
          <Check class="size-3.5" />
          {{ edit.staged.value.size ? `Save (${edit.staged.value.size})` : "Save" }}
        </Button>
      </div>
      <Button
        v-else
        size="sm"
        variant="outline"
        class="shrink-0 gap-1.5"
        @click="edit.start()"
      >
        <Pencil class="size-3.5" />
        Edit
      </Button>
    </CardHeader>
    <CardContent class="space-y-3">
      <ConfigFileChoice
        v-if="edit.file.value"
        v-model="edit.file.value"
        :local-file="configStore.mcp.value?.localFile ?? null"
        shared-hint="adt.sidebar and each section are written where they are declared, shared with the others once pushed or committed."
      />
      <div class="flex items-center gap-2 text-sm">
        <span class="font-medium">Sections</span>
        <Select
          v-if="edit.file.value"
          :model-value="edit.ordering(edit.sections.value).sort"
          :options="SORT_OPTIONS"
          class="h-7 w-36 text-xs"
          @update:model-value="choose(edit.sections.value, $event)"
        />
        <span
          v-else
          class="text-xs text-muted-foreground"
        >{{ SORT_LABELS[edit.ordering(edit.sections.value).sort] }}</span>
      </div>
      <SidebarOrderList
        :items="edit.shown(edit.sections.value)"
        :draggable="edit.file.value !== null && edit.ordering(edit.sections.value).sort === 'manual'"
        @move="edit.move(edit.sections.value, $event)"
      >
        <template #default="{ item }">
          <div
            v-if="edit.contents.value[item.key]"
            class="mt-1 mb-2 ml-6 space-y-1"
          >
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Content</span>
              <Select
                v-if="edit.file.value"
                :model-value="edit.ordering(edit.contents.value[item.key]).sort"
                :options="SORT_OPTIONS"
                class="h-6 w-32 text-xs"
                @update:model-value="choose(edit.contents.value[item.key], $event)"
              />
              <span v-else>{{ SORT_LABELS[edit.ordering(edit.contents.value[item.key]).sort] }}</span>
            </div>
            <SidebarOrderList
              :items="edit.shown(edit.contents.value[item.key])"
              :draggable="edit.file.value !== null && edit.ordering(edit.contents.value[item.key]).sort === 'manual'"
              @move="edit.move(edit.contents.value[item.key], $event)"
            />
          </div>
        </template>
      </SidebarOrderList>
    </CardContent>
  </Card>
</template>
