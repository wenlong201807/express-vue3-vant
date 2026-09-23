const express = require('express')
const path = require('node:path')
const { createStore } = require('./store.js')
const recordsRouter = require('./routes/records.js')

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

module.exports = app
