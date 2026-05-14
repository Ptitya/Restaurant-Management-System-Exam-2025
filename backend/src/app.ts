// src/app.ts
import 'dotenv/config'
import express, { Request, Response } from 'express'
import cors from 'cors'
import prisma from './lib/prisma'

import authRoutes    from './routes/auth'
import menuRoutes    from './routes/menu'
import orderRoutes   from './routes/orders'
import paymentRoutes from './routes/payments'
import reportRoutes  from './routes/reports'

const app = express()

app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }))
app.use(express.json())

app.use('/auth',     authRoutes)
app.use('/menu',     menuRoutes)
app.use('/orders',   orderRoutes)
app.use('/payments', paymentRoutes)
app.use('/reports',  reportRoutes)

// health check route พร้อม type ของ req/res
app.get('/api/health', (_req: Request, res: Response) =>
  res.json({ status: 'ok', timestamp: new Date(), version: '2.0.0' })
)

const PORT: number = Number(process.env.PORT) || 3001

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`RMS API v2 running on port ${PORT}`)
  })
}

export default app
