<script setup lang="ts">
import { onMounted } from "vue";
import { RouterView } from "vue-router";
import AppSidebar from "@/components/AppSidebar.vue";
import wsStore from "@/stores/ws";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

onMounted(() => {
  if (!wsStore.connected.value && !wsStore.loading.value) {
    wsStore.connect();
  }
});
</script>

<template>
  <div
    v-if="!wsStore.connected.value"
    class="flex h-full w-full items-center justify-center bg-muted/30 p-6"
  >
    <Card class="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Server</CardTitle>
        <CardDescription v-if="wsStore.loading.value">
          Connecting to server...
        </CardDescription>
        <CardDescription v-else>
          {{ wsStore.error.value || "Disconnected from server" }}
        </CardDescription>
      </CardHeader>
      <CardContent v-if="!wsStore.loading.value">
        <Button @click="wsStore.connect()">
          Try To Reconnect
        </Button>
      </CardContent>
    </Card>
  </div>
  <div
    v-else
    class="flex h-full w-full overflow-hidden"
  >
    <AppSidebar class="h-full w-80 shrink-0 border-r" />
    <main class="min-w-0 flex-1 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>
