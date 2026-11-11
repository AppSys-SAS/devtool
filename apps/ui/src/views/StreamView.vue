<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Eraser, Play, RotateCcw, Search, Square, Trash2 } from "@lucide/vue";
import router from "@/router";
import SidebarToggle from "@/components/SidebarToggle.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";
import type { CommandStreamLine } from "@/types";
import type { CommandStreamOutputStore } from "@/stores/command-stream-output";

const props = withDefaults(
  defineProps<{
    streamSlug: string;
    projectSlug?: string | null;
    directorySlug?: string | null;
  }>(),
  {
    projectSlug: null,
    directorySlug: null,
  },
);

const terminalElement = ref<HTMLElement | null>(null);
const searchVisible = ref(false);
const searchQuery = ref("");
const withInformation = ref(false);

const stream = computed(
  () =>
    configStore.commandStreams.value.find((item) => {
      if (item.slug !== props.streamSlug) {
        return false;
      }

      if (props.projectSlug && item.projectSlug !== props.projectSlug) {
        return false;
      }

      if (props.directorySlug && item.directorySlug !== props.directorySlug) {
        return false;
      }

      return true;
    }) ?? null,
);
const outputStoreRef = computed(() => configStore.getCommandStreamsOutput(props.streamSlug));
const cwd = computed(() => stream.value?.cwd ?? "N/A");
const runningDate = computed(() => (stream.value?.runningDate ? formatDate(stream.value.runningDate) : null));
const stoppedDate = computed(() =>
  stream.value?.stoppedDate ? formatDate(stream.value.stoppedDate, stream.value.runningDate ?? undefined) : null,
);

const args = computed(() => Object.entries(stream.value?.args ?? {}).map(([key, value]) => `${value}`));
const exitCode = computed(() => stream.value?.exitCode ?? null);
const env = computed(() => Object.entries(stream.value?.env ?? {}).map(([key, value]) => `${key}=${value}`));
const fullName = computed(() => stream.value?.name ?? "N/A");

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let outputStore: CommandStreamOutputStore | null = null;
let fitFrame: number | null = null;

const outputListener = (event: Event): void => {
  if (!(event instanceof CustomEvent) || !terminal) {
    return;
  }
  writeLine(event.detail as CommandStreamLine);
};

function writeLine(line: CommandStreamLine): void {
  if (!terminal) {
    return;
  }
  if (line.type === "stdout" || line.type === "stderr" || line.type === "stdin") {
    terminal.write(line.content);
    return;
  }
  terminal.writeln(`\r\n${line.content}`);
}

function formatDate(value: number, diffWith?: number): string {
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  const str = `${hours}:${minutes}:${seconds}.${milliseconds}`;

  if (typeof diffWith === "number") {
    const diff = Math.round((value - diffWith) / 100) / 10;
    if (diff < 5 * 60) {
      return `${str} (${diff}s)`;
    }
    return `${str} (${Math.round((diff / 60) * 10) / 10} min)`;
  }

  return str;
}

function syncOutputStore(): void {
  if (!terminal) {
    return;
  }

  if (outputStore) {
    outputStore.removeEventListener("output", outputListener);
  }

  outputStore = outputStoreRef.value;
  terminal.clear();
  const output = outputStore?.output ?? [];
  for (const line of output) {
    writeLine(line);
  }
  terminal.scrollToBottom();

  if (outputStore) {
    outputStore.addEventListener("output", outputListener);
  }
}

function fitTerminal(): void {
  if (!terminal || !fitAddon || !terminalElement.value) {
    return;
  }

  if (fitFrame !== null) {
    window.cancelAnimationFrame(fitFrame);
  }

  fitFrame = window.requestAnimationFrame(() => {
    if (!terminal || !fitAddon || !terminalElement.value) {
      return;
    }

    fitAddon.fit();
    terminal.scrollToBottom();
    wsStore.streamResize(props.streamSlug, terminal.cols, terminal.rows);
    fitFrame = null;
  });
}

function toggleSearch(): void {
  searchVisible.value = !searchVisible.value;
  if (!searchVisible.value) {
    return;
  }
  void nextTick(() => {
    const input = document.getElementById("stream-search-input");
    if (input instanceof HTMLInputElement) {
      input.focus();
    }
  });
}

function searchNext(): void {
  if (!searchAddon) {
    return;
  }
  searchAddon.findNext(searchQuery.value);
}

function searchPrevious(): void {
  if (!searchAddon) {
    return;
  }
  searchAddon.findPrevious(searchQuery.value);
}

function actionStart(): void {
  wsStore.updateCommandStream(props.streamSlug, "start");
}

function actionStop(): void {
  wsStore.updateCommandStream(props.streamSlug, "stop");
}

function actionRestart(): void {
  wsStore.updateCommandStream(props.streamSlug, "restart");
}

function actionClear(): void {
  configStore.getCommandStreamsOutput(props.streamSlug)?.clear();
  terminal?.clear();
}

function actionClose(): void {
  wsStore.updateCommandStream(props.streamSlug, "close");
}

onMounted(() => {
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontSize: 13,
    lineHeight: 1.1,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
    allowProposedApi: true,
    theme: {
      overviewRulerBorder: 'black'
    },
    overviewRuler: {
      width: 9,
    },
  });

  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new Unicode11Addon());
  terminal.loadAddon(
    new WebLinksAddon((_, url) => {
      window.open(url, "_blank", "noreferrer");
    }),
  );

  terminal.unicode.activeVersion = "11";
  terminal.onData((data) => wsStore.streamInput(props.streamSlug, data));
  terminal.onKey((event) => {
    if (event.domEvent.ctrlKey && event.domEvent.key === "f") {
      event.domEvent.preventDefault();
      toggleSearch();
    }

    if (event.domEvent.ctrlKey && event.domEvent.key === "l") {
      event.domEvent.preventDefault();
      actionClear();
    }
  });

  if (terminalElement.value) {
    terminal.open(terminalElement.value);
    resizeObserver = new ResizeObserver(() => fitTerminal());
    resizeObserver.observe(terminalElement.value);
  }

  window.addEventListener("resize", fitTerminal);
  fitTerminal();
  syncOutputStore();
});

onBeforeUnmount(() => {
  if (outputStore) {
    outputStore.removeEventListener("output", outputListener);
  }
  resizeObserver?.disconnect();
  window.removeEventListener("resize", fitTerminal);
  if (fitFrame !== null) {
    window.cancelAnimationFrame(fitFrame);
  }
  terminal?.dispose();
  outputStore = null;
  terminal = null;
  fitAddon = null;
  searchAddon = null;
  resizeObserver = null;
  fitFrame = null;
});

watch(
  () => props.streamSlug,
  () => {
    syncOutputStore();
    fitTerminal();
  },
);

watch(
  () => outputStoreRef.value,
  () => {
    syncOutputStore();
  },
);

watch(
  () => [wsStore.connected.value, wsStore.loading.value, stream.value] as const,
  ([connected, loading, currentStream]) => {
    if (!connected || loading || currentStream) {
      return;
    }

    if (props.projectSlug && props.directorySlug) {
      void router.replace({ name: "directory", params: { projectSlug: props.projectSlug, directorySlug: props.directorySlug } });
      return;
    }

    if (props.projectSlug) {
      void router.replace({ name: "project", params: { projectSlug: props.projectSlug } });
      return;
    }

    void router.replace({ name: "dashboard" });
  },
  { immediate: true },
);

watch(
  () => stream.value?.unread,
  (unread) => {
    if (unread && stream.value) {
      configStore.markAsRead(stream.value.slug);
    }
  },
  { immediate: true },
);
</script>

<template>
  <section
    v-if="stream"
    class="relative flex h-full min-h-0 flex-col"
  >
    <div
      v-if="searchVisible"
      class="absolute right-4 top-4 z-50 flex w-full max-w-md items-center gap-2 rounded-md border bg-background p-2 shadow-sm"
    >
      <Input
        id="stream-search-input"
        v-model="searchQuery"
        placeholder="Search..."
        @keydown.enter.prevent="searchNext"
      />
      <Button
        size="sm"
        variant="secondary"
        @click="searchPrevious"
      >
        Prev
      </Button>
      <Button
        size="sm"
        variant="secondary"
        @click="searchNext"
      >
        Next
      </Button>
      <Button
        size="sm"
        variant="ghost"
        @click="searchVisible = false"
      >
        Close
      </Button>
    </div>

    <div class="min-h-0 flex-1 px-1">
      <div
        ref="terminalElement"
        class="h-full w-full overflow-hidden"
      />
    </div>

    <section
      v-if="withInformation"
      class="mx-3 rounded-t-md border border-b-0 bg-muted/70 p-3 text-sm"
    >
      <div class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        <p>
          <strong>CWD:</strong> {{ cwd }}
        </p>
        <p v-if="runningDate">
          <strong>Running:</strong> {{ runningDate }}
        </p>
        <p v-if="stoppedDate">
          <strong>Stopped:</strong> {{ stoppedDate }}
        </p>
        <p v-if="exitCode !== null">
          <strong>Exit Code:</strong> {{ exitCode }}
        </p>
        <p v-if="args !== null">
          <strong>Args:</strong> {{ args }}
        </p>
        <p v-if="env !== null">
          <strong>ENV Variables:</strong> {{ env }}
        </p>
      </div>
    </section>

    <footer class="mx-3 mb-3 mt-2 flex flex-wrap items-center gap-1 rounded-md border bg-card p-2">
      <SidebarToggle
        side="left"
        class="size-8"
      />
      <Button
        v-if="stream.stoppedDate"
        size="sm"
        variant="secondary"
        @click="actionStart"
      >
        <Play class="mr-1 size-3.5" /> Start
      </Button>
      <Button
        v-if="!stream.stoppedDate"
        size="sm"
        variant="secondary"
        @click="actionStop"
      >
        <Square class="mr-1 size-3.5" /> Stop
      </Button>
      <Button
        v-if="!stream.stoppedDate"
        size="sm"
        variant="secondary"
        @click="actionRestart"
      >
        <RotateCcw class="mr-1 size-3.5" /> Restart
      </Button>
      <Button
        size="sm"
        variant="secondary"
        @click="toggleSearch"
      >
        <Search class="mr-1 size-3.5" /> Search
      </Button>
      <Button
        size="sm"
        variant="secondary"
        @click="actionClear"
      >
        <Eraser class="mr-1 size-3.5" /> Clear
      </Button>
      <Button
        v-if="stream.stoppedDate"
        size="sm"
        variant="secondary"
        @click="actionClose"
      >
        <Trash2 class="mr-1 size-3.5" /> Close
      </Button>
      <Separator
        orientation="vertical"
        class="mx-1 h-6"
      />
      <p class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {{ fullName }}
      </p>
      <Button
        size="sm"
        variant="ghost"
        @click="withInformation = !withInformation"
      >
        {{ withInformation ? "Hide Details" : "Details" }}
      </Button>
      <SidebarToggle
        side="right"
        class="size-8"
      />
    </footer>
  </section>
</template>
