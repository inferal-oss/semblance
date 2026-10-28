import {defineConfig} from 'vite';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname);
export default defineConfig({root,server:{host:'127.0.0.1',port:59118,strictPort:true,fs:{allow:[resolve(root,'../../..')]},headers:{'Content-Security-Policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ws://127.0.0.1:59118; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"}},optimizeDeps:{exclude:['oxigraph']}});
