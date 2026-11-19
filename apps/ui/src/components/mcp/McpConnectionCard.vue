<script setup lang="ts">
import { computed } from "vue";
import { useClipboard } from "@vueuse/core";
import { Bot, Check, Copy, Unplug } from "@lucide/vue";
import type { McpClientStatus } from "@appsys/devtool-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { mcpAddCommand } from "@/lib/mcp";
import mcpStore from "@/stores/mcp";

const STATUSES: Record<McpClientStatus, string> = {
  pending: "not accepted yet",
  session: "accepted for the session",
  always: "accepted always",
  config: "accepted by the configuration",
  denied: "refused",
};

const state = mcpStore.state;
const command = computed(() => mcpAddCommand(state.value?.port ?? 6730));
const { copy, copied } = useClipboard({ copiedDuring: 1500 });
const remembered = computed(() => state.value?.clients.filter((client) => client.source === "always") ?? []);
const configured = computed(() => state.value?.clients.filter((client) => client.source !== "always") ?? []);
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Connection</CardTitle>
      <CardDescription>Agents running on this machine connect over Streamable HTTP. To add the devtool to Claude Code, run this command.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <code class="min-w-0 flex-1 truncate text-xs">{{ command }}</code>
        <Button
          size="icon-sm"
          variant="ghost"
          title="Copy"
          @click="copy(command)"
        >
          <Check
            v-if="copied"
            class="size-3.5"
          />
          <Copy
            v-else
            class="size-3.5"
          />
        </Button>
      </div>

      <div class="space-y-2">
        <h3 class="text-sm font-medium">
          Sessions
        </h3>
        <p
          v-if="!state?.sessions.length"
          class="text-sm text-muted-foreground"
        >
          No agent connected.
        </p>
        <div
          v-for="session in state?.sessions"
          :key="session.id"
          class="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2"
        >
          <Bot class="size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">
              {{ session.client }} <span
                v-if="session.version"
                class="text-muted-foreground"
              >{{ session.version }}</span>
            </p>
            <p class="truncate text-xs text-muted-foreground">
              Since {{ new Date(session.connectedAt).toLocaleTimeString() }} · {{ session.calls }} calls · {{ STATUSES[session.status] }}
            </p>
          </div>
          <Button
            v-if="session.status === 'session' || session.status === 'pending'"
            size="sm"
            variant="outline"
            @click="mcpStore.setClient(session.client, 'always')"
          >
            Always accept {{ session.client }}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="gap-1.5"
            @click="mcpStore.disconnect(session.id)"
          >
            <Unplug class="size-3.5" />
            Disconnect
          </Button>
        </div>
      </div>

      <div class="space-y-2">
        <h3 class="text-sm font-medium">
          Clients
        </h3>
        <p
          v-if="!remembered.length && !configured.length"
          class="text-sm text-muted-foreground"
        >
          Every new client is asked for (<code>adt.mcp.clients</code>).
        </p>
        <div
          v-for="client in remembered"
          :key="`always/${client.name}`"
          class="flex items-center gap-3 rounded-md border px-3 py-2"
        >
          <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ client.name }}</span>
          <span class="text-xs text-muted-foreground">accepted {{ client.date ? new Date(client.date).toLocaleString() : "" }}</span>
          <Button
            size="sm"
            variant="ghost"
            @click="mcpStore.setClient(client.name, 'forget')"
          >
            Forget
          </Button>
        </div>
        <div
          v-for="client in configured"
          :key="`${client.source}/${client.name}`"
          class="flex items-center gap-3 rounded-md border border-dashed px-3 py-2"
        >
          <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ client.name }}</span>
          <Badge :variant="client.source === 'deny' ? 'destructive' : 'secondary'">
            {{ client.source === "deny" ? "refused" : "accepted" }} by adt.mcp.clients.{{ client.source }}
          </Badge>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
