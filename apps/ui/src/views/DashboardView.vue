<script setup lang="ts">
import { TriangleAlert } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";

const version = window.devtool?.version ?? "0.0.0";
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <Card class="max-w-3xl">
      <CardHeader>
        <CardTitle>Server <sup>{{ version }}</sup></CardTitle>
        <CardDescription>Configuration status and validation warnings.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <Button
          variant="secondary"
          @click="wsStore.reconfigure()"
        >
          Rescan Config Paths
        </Button>
        <div
          v-if="configStore.warnings.value.length > 0"
          class="space-y-2"
        >
          <div
            v-for="warning in configStore.warnings.value"
            :key="warning"
            class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
          >
            <TriangleAlert class="mt-0.5 size-4 shrink-0" />
            <span>{{ warning }}</span>
          </div>
        </div>
        <p
          v-else
          class="text-sm text-muted-foreground"
        >
          No warnings detected.
        </p>
      </CardContent>
    </Card>
  </div>
</template>
