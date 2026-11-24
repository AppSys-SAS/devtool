import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import 'virtual:group-icons.css'
import AppSysMark from './components/AppSysMark.vue'
import Configurator from './components/Configurator.vue'
import SecretGenerator from './components/SecretGenerator.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'nav-bar-title-after': () => h(AppSysMark)
  }),
  /**
   * Registers the components the Markdown pages use.
   * @param context The app being set up.
   * @param context.app The Vue application.
   */
  enhanceApp ({ app }) {
    app.component('configurator', Configurator)
    app.component('secret-generator', SecretGenerator)
  }
} satisfies Theme
