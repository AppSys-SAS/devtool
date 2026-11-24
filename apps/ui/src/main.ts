import { addAPIProvider } from '@iconify/vue'
import { createApp } from 'vue'
import pkg from '../package.json'
import App from './App.vue'
import router from './router'
import './style.css'

declare global {
  interface Window {
    devtool?: {
      version: string
    }
  }
}

window.devtool = {
  version: pkg.version
}

addAPIProvider('', { resources: [window.location.origin], path: '/icons/' })

const app = createApp(App)
app.use(router)
app.mount('#app')
