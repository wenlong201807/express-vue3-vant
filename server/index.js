import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.js'
import recordsRouter from './routes/records.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const store = createStore()

app.use(express.json())
app.use('/source', express.static(path.join(__dirname, '..', 'source')))
app.use('/api', recordsRouter(store))
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})

export default app
