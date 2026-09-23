import { createApp } from 'vue'
import Vant from 'vant'
import 'vant/lib/index.css'
import 'video.js/dist/video-js.css'
import './styles/theme.css'
import App from './App.vue'
import router from './router'

createApp(App).use(Vant).use(router).mount('#app')
