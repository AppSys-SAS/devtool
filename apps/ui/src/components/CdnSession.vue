<script setup lang="ts">
import { computed } from "vue";
import { LogIn, LogOut, UserRound } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import sessionStore from "@/stores/session";
import wsStore from "@/stores/ws";

const state = sessionStore.state;

const displayName = computed(() => state.value?.user?.name ?? state.value?.user?.username ?? "Signed in");

const initials = computed(() => {
  const words = (state.value?.user?.name ?? state.value?.user?.username ?? "").split(/[\s._-]+/).filter((word) => word !== "");
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("");
});

/**
 * Starts a sign-in, in a new tab.
 */
function login(): void {
  sessionStore.openLoginWindow();
  wsStore.cdnLogin();
}
</script>

<template>
  <div
    v-if="state?.configured"
    class="flex items-center gap-2 px-3 py-2"
  >
    <div class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
      <template v-if="state.signedIn && initials">
        {{ initials }}
      </template>
      <UserRound
        v-else
        class="size-4"
      />
    </div>

    <div class="min-w-0 flex-1">
      <template v-if="state.signedIn">
        <div
          class="truncate text-sm font-medium"
          :title="state.user?.username ?? undefined"
        >
          {{ displayName }}
        </div>
        <div
          v-if="state.user?.groups.length"
          class="mt-0.5 flex flex-wrap gap-1"
        >
          <Badge
            v-for="group in state.user.groups"
            :key="group"
            variant="secondary"
            class="px-1.5 py-0 text-[10px]"
          >
            {{ group }}
          </Badge>
        </div>
      </template>
      <template v-else-if="state.pendingLoginUrl">
        <div class="truncate text-sm">
          Waiting for {{ state.issuerName ?? "the sign-in" }}…
        </div>
        <a
          :href="state.pendingLoginUrl"
          target="_blank"
          rel="noopener"
          class="text-xs text-muted-foreground underline hover:text-foreground"
        >Open the sign-in page</a>
      </template>
      <template v-else>
        <div class="truncate text-sm text-muted-foreground">
          Not signed in
        </div>
        <div
          v-if="state.error"
          class="truncate text-xs text-destructive"
          :title="state.error"
        >
          Sign-in failed: {{ state.error }}
        </div>
      </template>
    </div>

    <Button
      v-if="state.signedIn"
      size="icon"
      variant="ghost"
      class="size-8 shrink-0"
      title="Sign out"
      @click="wsStore.cdnLogout()"
    >
      <LogOut class="size-3.5" />
    </Button>
    <Button
      v-else-if="!state.pendingLoginUrl"
      size="sm"
      variant="outline"
      class="h-8 shrink-0 gap-1.5 px-2 text-xs"
      :title="state.issuerName ? `Sign in with ${state.issuerName}` : undefined"
      @click="login"
    >
      <LogIn class="size-3.5" />
      Sign in
    </Button>
  </div>
</template>
