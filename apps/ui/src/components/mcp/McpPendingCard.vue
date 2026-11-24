<script setup lang="ts">
import type { CommandInputValue, McpAnswer } from '@appsys/devtool-shared'
import McpRequestDetails from '@/components/mcp/McpRequestDetails.vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import mcpStore from '@/stores/mcp'

const state = mcpStore.state

/**
 * Answers a waiting request.
 * @param id The request.
 * @param answer The answer.
 * @param inputs The values of the inputs of its command.
 */
function answer (id: string, answer: McpAnswer, inputs: CommandInputValue[] | null): void {
  mcpStore.answer(id, answer, inputs)
}
</script>

<template>
  <Card :class="{ 'border-amber-500/50': state?.pending.length }">
    <CardHeader>
      <CardTitle>Waiting for you</CardTitle>
      <CardDescription>Calls of agents waiting for an answer, the oldest first.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      <p
        v-if="!state?.pending.length"
        class="text-sm text-muted-foreground"
      >
        Nothing waiting.
      </p>
      <div
        v-for="request in state?.pending"
        :key="request.id"
        class="space-y-2 rounded-md border p-3"
      >
        <p class="text-sm font-medium">
          {{ request.title }}
        </p>
        <McpRequestDetails
          :request="request"
          @answer="(value, inputs) => answer(request.id, value, inputs)"
        />
      </div>
    </CardContent>
  </Card>
</template>
