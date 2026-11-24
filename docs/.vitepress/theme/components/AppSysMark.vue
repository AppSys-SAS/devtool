<script setup lang="ts">
import { withBase } from 'vitepress'

const mark = `url(${withBase('/brand/appsys.svg')})`
</script>

<template>
  <a
    class="appsys-mark"
    href="https://appsys.digital"
    target="_blank"
    rel="noopener"
    title="AppSys"
  >
    <span class="by">by</span>
    <span class="wordmark" :style="{ maskImage: mark, WebkitMaskImage: mark }" />
  </a>
</template>

<style scoped>
.appsys-mark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 10px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  transition: color 0.25s;
}

.appsys-mark:hover {
  color: var(--vp-c-brand-1);
}

.wordmark {
  display: inline-block;
  width: 68px;
  height: 16px;
  background-color: currentColor;
  mask-repeat: no-repeat;
  mask-size: contain;
  mask-position: left center;
}

@media (max-width: 767px) {
  .appsys-mark {
    display: none;
  }
}
</style>
