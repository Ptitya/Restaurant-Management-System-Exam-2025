import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { authenticate } from '../middleware/auth'

const router = Router()

// POST /api/orders — เปิดโต๊ะใหม่
router.post('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { tableId, note } = req.body as { tableId?: number; note?: string }
    if (!tableId) { res.status(400).json({ error: 'tableId required' }); return }

    const table = await prisma.restaurantTable.findUnique({ where: { id: Number(tableId) } })
    if (!table) { res.status(404).json({ error: 'Table not found' }); return }

    const existing = await prisma.order.findFirst({
      where: { tableId: Number(tableId), status: { in: ['open', 'confirmed'] } }
    })
    if (existing) { res.status(409).json({ error: 'Table already has an active order' }); return }

    const order = await prisma.order.create({
      data: {
        tableId: Number(tableId),
        waiterId: (req as any).user.id,
        status: 'open',
        note: note || ""
      },
    })
    await prisma.restaurantTable.update({ where: { id: Number(tableId) }, data: { status: 'occupied' } })

    res.status(201).json(order)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// POST /api/orders/:id/items — เพิ่มอาหารลงในบิล
router.post('/:id/items', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = Number(req.params.id)
    if (isNaN(orderId)) { res.status(400).json({ error: 'Invalid Order ID' }); return }

    const { menuItemId, quantity = 1 } = req.body as { menuItemId?: number; quantity?: number }
    if (!menuItemId) { res.status(400).json({ error: 'menuItemId required' }); return }

    const order = await prisma.order.findUnique({ where: { id: orderId } })
    if (!order) { res.status(404).json({ error: 'Order not found' }); return }
    if (order.status !== 'open') { res.status(400).json({ error: 'Order is not open' }); return }

    const menuItem = await prisma.menuItem.findUnique({ where: { id: Number(menuItemId) } })
    if (!menuItem) { res.status(404).json({ error: 'Menu item not found' }); return }
    if (!menuItem.isAvailable) { res.status(400).json({ error: 'Menu item unavailable' }); return }

    const qty = Number(quantity) || 1
    const unitPrice = Number(menuItem.price)
    const subtotal = unitPrice * qty

    const item = await prisma.$transaction(async (tx) => {
      const newItem = await tx.orderItem.create({
        data: { orderId, menuItemId: menuItem.id, quantity: qty, unitPrice, subtotal },
        include: { menuItem: true },
      })

      const allItems = await tx.orderItem.findMany({ where: { orderId } })
      const total = allItems.reduce((s: number, i: any) => s + Number(i.subtotal), 0)
      await tx.order.update({ where: { id: orderId }, data: { totalAmount: total } })

      return newItem
    })

    // ✅ คืนค่า 201 ตามที่ Newman คาดหวัง
    res.status(201).json(item)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// PUT /api/orders/:id/confirm — ยืนยันออเดอร์
router.put('/:id/confirm', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = Number(req.params.id)
    if (isNaN(orderId)) { res.status(400).json({ error: 'Invalid Order ID' }); return }

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } })
    if (!order) { res.status(404).json({ error: 'Order not found' }); return }
    if (order.status !== 'open') { res.status(400).json({ error: 'Order is not open' }); return }
    if (!order.items || order.items.length === 0) {
      res.status(400).json({ error: 'Cannot confirm empty order' }); return
    }

    const updated = await prisma.order.update({ where: { id: orderId }, data: { status: 'confirmed' } })

    // ✅ คืนค่า 200 OK ตามที่ Newman คาดหวัง
    res.status(200).json(updated)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
