const express = require('express')
const path = require('node:path')
const { createStore } = require('./store.js')
const recordsRouter = require('./routes/records.js')
const incomeRouter = require('./routes/income.js')
const contentRouter = require('./routes/content.js')

const app = express()
const store = createStore()

app.use(express.json())
app.use('/source', express.static(path.join(__dirname, '..', 'source')))
app.use('/api', recordsRouter(store))
// 客户收益中心（R26102373）mock：homeH5 devServer 代理 pathRewrite 后落 /api/h5/income/*
app.use('/api/h5/income', incomeRouter())
// 首页 content 域 mock（功能码配置等）：落 /api/h5/content/*
app.use('/api/h5/content', contentRouter())
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})

module.exports = app
