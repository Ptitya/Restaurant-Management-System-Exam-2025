// src/routes/payments.ts
import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { authenticate, requireRole } from '../middleware/auth'

const router = Router()

router.post('/', authenticate, requireRole('admin', 'cashier'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId, amountPaid, method } = req.body as {
      orderId?: number
      amountPaid?: number
      method?: 'cash' | 'card' | 'qr'
    }

    if (!orderId || amountPaid === undefined) {
      res.status(400).json({ error: 'orderId and amountPaid required' }); return
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    })

    if (!order) { res.status(404).json({ error: 'Order not found' }); return }
    if (order.status !== 'confirmed') {
      res.status(400).json({ error: 'Order must be confirmed before payment' }); return
    }
    if (!order.items.length) {
      res.status(400).json({ error: 'Order has no items' }); return
    }

    const totalAmount = Number(order.totalAmount)
    const paid = Number(amountPaid)

    // ✅ ป้องกันการจ่ายเงินไม่พอ (BUG-001)
    if (paid < totalAmount) {
      res.status(400).json({ error: 'Insufficient payment amount' });
      return
    }

    const change = paid - totalAmount

    const payment = await prisma.payment.create({
      data: {
        orderId,
        cashierId: (req as any).user.id,
        totalAmount,
        amountPaid: paid,
        change,
        method: method ?? 'cash',
      },
    })

    await prisma.order.update({ where: { id: orderId }, data: { status: 'paid' } })
    await prisma.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'available' } })

    // ✅ คืนค่า 201 ตามที่ Newman/TC-019 คาดหวัง
    res.status(201).json({ payment, change, message: 'Payment processed successfully' })

  } catch (err) {
    if ((err as Error).message.includes('jwt expired')) {
      res.status(401).json({ error: 'Token expired' }); return
    }
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router