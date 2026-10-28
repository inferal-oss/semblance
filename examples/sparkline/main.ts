import { mount } from '@inferal-oss/semblance/web'
import app from './app.ttl?raw'

// URL-only preview choices; the interface and its receive/withdraw event are graph data.
const themes = ['Semblance', 'Paper', 'Terminal', 'Blueprint', 'Sunset', 'Classic', 'Tracker', 'Doodle', 'Cupertino', 'Fluent']
const params = new URLSearchParams(location.search)
const theme = themes.find((name) => name.toLowerCase() === params.get('theme')?.toLowerCase()) ?? 'Semblance'
const language = ['en', 'uk', 'de', 'ar'].find((name) => name === params.get('lang')) ?? 'en'
document.documentElement.lang = language
document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'
if (params.get('scheme') === 'light') document.documentElement.style.colorScheme = 'light'
else document.documentElement.style.colorScheme = 'dark'
await mount(document.getElementById('app')!, { root: 'https://example.org/sparkline#page', graphs: [app.replace('sty:Semblance', 'sty:' + theme)], store: 'wat', languages: [language], prefer: params.get('prefer') === 'function' ? 'function' : 'sparql' })
