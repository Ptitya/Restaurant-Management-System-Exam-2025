// src/routes/payments.ts
import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { authenticate, requireRole } from '../middleware/auth'

const router = Router()

// POST /api/payments
router.post(
  '/',
  authenticate,
  requireRole('admin', 'cashier'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId, amountPaid, method } = req.body as {
        orderId?: number
        amountPaid?: number
        method?: 'cash' | 'card' | 'qr'
      }

      if (!orderId || amountPaid === undefined) {
        res.status(400).json({ error: 'orderId and amountPaid required' })
        return
      }

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      })
      if (!order) { res.status(404).json({ error: 'Order not found' }); return }
      if (order.status !== 'confirmed') {
        res.status(400).json({ error: 'Order must be confirmed before payment' })
        return
      }
      if (!order.items.length) {
        res.status(400).json({ error: 'Order has no items' })
        return
      }

      const totalAmount = Number(order.totalAmount)
      const paid = Number(amountPaid)

      // ✅ BUG-001: Underpayment → 400
      if (paid < totalAmount) {
        res.status(400).json({ error: 'Insufficient payment amount' })
        return
      }

      const change = paid - totalAmount

      const payment = await prisma.payment.create({
        data: {
          orderId,
          cashierId: req.user!.id,
          totalAmount,
          amountPaid: paid,
          change,
          method: method ?? 'cash',
        },
      })

      await prisma.order.update({ where: { id: orderId }, data: { status: 'paid' } })
      await prisma.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'available' } })

      // ✅ Payment Success → 201 Created (ตรงกับ TC-019)
      res.status(201).json({
        payment,
        change,
        message: 'Payment processed successfully',
      })
    } catch (err) {
      // ✅ BUG-014: Expired Token → 401 Unauthorized
      if ((err as Error).message.includes('jwt expired')) {
        res.status(401).json({ error: 'Token expired' })
        return
      }
      res.status(500).json({ error: (err as Error).message })
    }
  }
)

// GET /api/payments/:orderId
router.get('/:orderId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { orderId: Number(req.params.orderId) },
    })
    if (!payment) { res.status(404).json({ error: 'Payment not found' }); return }
    res.status(200).json(payment)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
