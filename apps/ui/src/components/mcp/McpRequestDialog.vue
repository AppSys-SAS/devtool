<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import type { CommandInputValue, McpAnswer } from "@appsys/devtool-shared";
import McpRequestDetails from "@/components/mcp/McpRequestDetails.vue";
import mcpStore from "@/stores/mcp";

const route = useRoute();
const request = mcpStore.current;
const waiting = computed(() => mcpStore.state.value?.pending.length ?? 0);
const answeredInPage = computed(() => route.name === "agents" && route.query.tab === "waiting");
const open = computed(() => request.value !== null && !answeredInPage.value);

/**
 * Answers the request shown, the next one then shown.
 * @param answer The answer.
 * @param inputs The values of the inputs of its command.
 */
function answer(answer: McpAnswer, inputs: CommandInputValue[] | null): void {
  if (request.value) {
    mcpStore.answer(request.value.id, answer, inputs);
  }
}

/**
 * Denies the request shown when the dialog is closed with Escape.
 * @param event The key event, prevented so that the dialog closes once the request is answered.
 */
function escape(event: KeyboardEvent): void {
  event.preventDefault();
  answer("deny", null);
}
</script>

<template>
  <DialogRoot :open="open">
    <DialogPortal>
      <DialogOverlay class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        v-if="request"
        class="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100%-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border p-6 shadow-lg"
        :class="request.diff ? 'sm:max-w-3xl' : 'sm:max-w-xl'"
        @interact-outside.prevent
        @escape-key-down="escape"
      >
        <div class="flex items-start justify-between gap-3">
          <DialogTitle class="text-lg font-semibold">
            {{ request.title }}
          </DialogTitle>
          <span
            v-if="waiting > 1"
            class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >1 / {{ waiting }}</span>
        </div>
        <DialogDescription class="-mt-2 text-sm text-muted-foreground">
          <template v-if="request.kind === 'client'">
            An agent connected to the MCP server of the devtool asks to use it.
          </template>
          <template v-else>
            An agent asks to make this call.
          </template>
          <RouterLink
            :to="{ name: 'agents', query: { tab: 'history' } }"
            class="underline-offset-4 hover:underline"
          >
            See the history
          </RouterLink>
        </DialogDescription>
        <McpRequestDetails
          :key="request.id"
          :request="request"
          @answer="answer"
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
