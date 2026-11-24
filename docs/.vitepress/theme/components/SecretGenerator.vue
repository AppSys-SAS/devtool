<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'

const KEY_BYTES = 32
const MIN_LENGTH = 16
const MAX_LENGTH = 64
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%*+,-.:=?@^_~'
const SHELL_SYMBOLS = '!#%*+,-.:=?@^_~'

const key = shallowRef('')
const password = shallowRef('')
const length = shallowRef(32)
const copied = shallowRef<'key' | 'password' | null>(null)

const passwordCommand = computed(() => `LC_ALL=C tr -dc 'A-Za-z0-9${SHELL_SYMBOLS}' < /dev/urandom | head -c ${length.value}; echo`)

/**
 * Draws a random integer below a bound, without the bias of a plain modulo.
 * @param bound The exclusive upper bound, at most 2^32.
 * @returns An integer from 0 to bound - 1.
 */
function randomBelow (bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound
  const value = new Uint32Array(1)
  do {
    crypto.getRandomValues(value)
  } while (value[0] >= limit)
  return value[0] % bound
}

/**
 * Generates a new encryption key: random bytes in base64.
 */
function generateKey (): void {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  key.value = btoa(String.fromCharCode(...bytes))
}

/**
 * Generates a new password of the chosen length, from letters, digits and symbols.
 */
function generatePassword (): void {
  password.value = Array.from({ length: length.value }, () => ALPHABET[randomBelow(ALPHABET.length)]).join('')
}

/**
 * Copies a generated secret to the clipboard.
 * @param which The secret to copy.
 */
async function copy (which: 'key' | 'password'): Promise<void> {
  await navigator.clipboard.writeText(which === 'key' ? key.value : password.value)
  copied.value = which
  setTimeout(() => {
    if (copied.value === which) {
      copied.value = null
    }
  }, 1500)
}

/**
 * Takes the length chosen with the slider and generates a password of that length.
 * @param event The input event of the slider.
 */
function changeLength (event: Event): void {
  length.value = Number((event.target as HTMLInputElement).value)
  generatePassword()
}

onMounted(() => {
  generateKey()
  generatePassword()
})
</script>

<template>
  <div class="secret-generator">
    <p class="note">
      Generated in your browser with <code>crypto.getRandomValues</code>: nothing is sent anywhere.
    </p>

    <section class="secret">
      <h4>Encryption key</h4>
      <p class="note">
        32 random bytes in base64, for <code>{ key }</code>.
      </p>
      <output class="value">{{ key }}</output>
      <div class="actions">
        <button type="button" @click="generateKey">
          Regenerate
        </button>
        <button type="button" class="primary" @click="copy('key')">
          {{ copied === 'key' ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="note">
        In a terminal: <code>openssl rand -base64 32</code>
      </p>
    </section>

    <section class="secret">
      <h4>Password</h4>
      <p class="note">
        Letters, digits and symbols, for <code>{ password }</code> or to type when asked.
      </p>
      <label class="length">
        <span>Length: {{ length }}</span>
        <input
          type="range"
          :min="MIN_LENGTH"
          :max="MAX_LENGTH"
          :value="length"
          @input="changeLength"
        >
      </label>
      <output class="value">{{ password }}</output>
      <div class="actions">
        <button type="button" @click="generatePassword">
          Regenerate
        </button>
        <button type="button" class="primary" @click="copy('password')">
          {{ copied === 'password' ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="note">
        In a terminal: <code>{{ passwordCommand }}</code>
      </p>
    </section>
  </div>
</template>

<style scoped>
.secret-generator {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 16px 0;
}

.secret {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.secret h4 {
  margin: 0;
}

.value {
  display: block;
  padding: 10px 14px;
  overflow-wrap: anywhere;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
}

.actions,
.length {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.length {
  font-size: 14px;
}

.length input {
  flex: 1;
  min-width: 160px;
  accent-color: var(--vp-c-brand-1);
}

button {
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  transition: border-color 0.2s, background-color 0.2s;
}

button:hover {
  border-color: var(--vp-c-brand-1);
}

button.primary {
  border-color: var(--vp-button-brand-bg);
  background: var(--vp-button-brand-bg);
  color: #fff;
}

.note {
  margin: 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
</style>
