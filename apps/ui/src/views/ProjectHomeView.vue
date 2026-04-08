<script setup lang="ts">
import { computed } from "vue";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import configStore from "@/stores/config";

const props = defineProps<{
  projectSlug: string;
}>();

const project = computed(() => configStore.getProject(props.projectSlug));
const projectName = computed(() => project.value?.name ?? props.projectSlug);
const projectDescription = computed(() => project.value?.description ?? null);
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <Card class="max-w-3xl">
      <CardHeader>
        <CardTitle>{{ projectName }}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          v-if="projectDescription"
          class="text-sm text-muted-foreground"
        >
          {{ projectDescription }}
        </p>
      </CardContent>
    </Card>
  </div>
</template>
