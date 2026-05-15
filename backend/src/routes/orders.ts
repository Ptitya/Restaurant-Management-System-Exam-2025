// src/routes/orders.ts
import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { authenticate, requireRole } from '../middleware/auth'

const router = Router()

// GET /api/orders/tables
router.get('/tables', authenticate, async (_req: Request, res: Response): Promise<void> => {
    try {
        const tables = await prisma.restaurantTable.findMany({ orderBy: { tableNumber: 'asc' } })
        res.json(tables)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// GET /api/orders
router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const { status, tableId } = req.query as { status?: string; tableId?: string }
        const orders = await prisma.order.findMany({
            where: {
                ...(status ? { status: status as any } : {}),
                ...(tableId ? { tableId: Number(tableId) } : {}),
            },
            include: {
                table: true,
                waiter: { select: { id: true, name: true } },
                items: { include: { menuItem: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
        res.json(orders)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// GET /api/orders/:id
router.get('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const order = await prisma.order.findUnique({
            where: { id: Number(req.params.id) },
            include: {
                table: true,
                waiter: { select: { id: true, name: true } },
                items: { include: { menuItem: true } },
                payment: true,
            },
        })
        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        res.json(order)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// POST /api/orders — open new order
// ✅ แก้ไข BUG-002 [Double Booking]
router.post('/', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const { tableId, note } = req.body as { tableId?: number; note?: string }
        if (!tableId) { res.status(400).json({ error: 'tableId required' }); return }

        const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } })
        if (!table) { res.status(404).json({ error: 'Table not found' }); return }

        const existing = await prisma.order.findFirst({
            where: {
                tableId,
                status: { in: ['open', 'confirmed'] as any }
            }
        })

        if (existing) {
            res.status(409).json({ error: 'Table already has an active order' });
            return
        }

        const [order] = await prisma.$transaction([
            prisma.order.create({
                data: {
                    tableId,
                    waiterId: (req as any).user.id, // ใช้ Type Casting แก้โค้ดแดง
                    status: 'open' as any,
                    note
                },
            }),
            prisma.restaurantTable.update({ where: { id: tableId }, data: { status: 'occupied' as any } }),
        ])

        res.status(201).json(order)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// POST /api/orders/:id/items
// ✅ แก้ไข TC-005 [Out of Stock]
router.post('/:id/items', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const orderId = Number(req.params.id)
        const { menuItemId, quantity = 1 } = req.body as { menuItemId?: number; quantity?: number }

        const [order, menuItem] = await Promise.all([
            prisma.order.findUnique({ where: { id: orderId } }),
            menuItemId ? prisma.menuItem.findUnique({ where: { id: menuItemId } }) : null,
        ])

        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        if (order.status !== 'open') { res.status(400).json({ error: 'Order is not open' }); return }
        if (!menuItem) { res.status(404).json({ error: 'Menu item not found' }); return }
        if (!menuItem.isAvailable) { res.status(400).json({ error: 'Menu item unavailable' }); return }

        const qty = Number(quantity) || 1

        // ✅ เช็กสต็อก (ใช้ (menuItem as any).stock เพื่อเลี่ยง Type Error หากชื่อฟิลด์ต่างกัน)
        const currentStock = (menuItem as any).stock ?? (menuItem as any).quantity ?? 0;
        if (currentStock < qty) {
            res.status(400).json({ error: 'Insufficient stock' });
            return
        }

        const unitPrice = Number(menuItem.price)
        const subtotal = unitPrice * qty

        const [item] = await prisma.$transaction([
            prisma.orderItem.create({
                data: { orderId, menuItemId: menuItem.id, quantity: qty, unitPrice, subtotal },
                include: { menuItem: true },
            }),
            // หักสต็อก
            prisma.menuItem.update({
                where: { id: menuItemId },
                data: { [(menuItem as any).stock !== undefined ? 'stock' : 'quantity']: { decrement: qty } }
            })
        ])

        // Recalculate total
        const allItems = await prisma.orderItem.findMany({ where: { orderId } })
        const total = allItems.reduce((s: number, i: any) => s + Number(i.subtotal), 0)
        await prisma.order.update({ where: { id: orderId }, data: { totalAmount: total } })

        res.status(201).json({ item, totalAmount: total })
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// PUT /api/orders/:id/confirm
// ✅ แก้ไข TC-010 [Empty Items]
router.put('/:id/confirm', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const orderId = Number(req.params.id)
        const order = await prisma.order.findUnique({
            where: { id: orderId }, include: { items: true },
        })
        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        if (order.status !== 'open') { res.status(400).json({ error: 'Order is not open' }); return }

        // ✅ ตรวจสอบว่ามีของในบิลไหม
        if (!order.items || order.items.length === 0) {
            res.status(400).json({ error: 'Cannot confirm empty order' });
            return
        }

        const updated = await prisma.order.update({ where: { id: orderId }, data: { status: 'confirmed' as any } })
        res.json(updated)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// PUT /api/orders/:id/cancel
router.put('/:id/cancel', authenticate, requireRole('admin', 'cashier'), async (req: Request, res: Response): Promise<void> => {
    try {
        const orderId = Number(req.params.id)
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { items: true }
        })
        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        if (order.status === 'paid') { res.status(400).json({ error: 'Cannot cancel paid order' }); return }

        // คืนสต็อกสินค้าทั้งหมด
        const stockRestores = order.items.map(item => {
            return prisma.menuItem.update({
                where: { id: item.menuItemId },
                data: { stock: { increment: item.quantity } } as any
            })
        })

        await prisma.$transaction([
            ...stockRestores,
            prisma.order.update({ where: { id: orderId }, data: { status: 'cancelled' as any } }),
            prisma.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'available' as any } }),
        ])
        res.json({ message: 'Order cancelled' })
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

export default router