import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { authenticate, requireRole } from '../middleware/auth'

const router = Router()

// --- ส่วนที่เพิ่มใหม่เพื่อให้ Test ผ่าน ---

// GET /api/orders - ดึงรายการออเดอร์ทั้งหมด
router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const orders = await prisma.order.findMany({
            include: { items: { include: { menuItem: true } }, table: true }
        })
        res.json(orders)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// GET /api/orders/:id - ดึงรายละเอียดออเดอร์รายใบ
router.get('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const id = Number(req.params.id)
        if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

        const order = await prisma.order.findUnique({
            where: { id },
            include: { items: { include: { menuItem: true } }, table: true }
        })

        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        res.json(order)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// --- ส่วนเดิมที่เนมเขียนไว้ (พี่ปรับปรุง Logic เล็กน้อย) ---

// POST /api/orders — เปิดโต๊ะใหม่
router.post('/', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const { tableId, note } = req.body as { tableId?: number; note?: string }
        if (!tableId) { res.status(400).json({ error: 'tableId required' }); return }

        const table = await prisma.restaurantTable.findUnique({ where: { id: Number(tableId) } })
        if (!table) { res.status(404).json({ error: 'Table not found' }); return }

        const existing = await prisma.order.findFirst({
            where: {
                tableId: Number(tableId),
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
                    tableId: Number(tableId),
                    waiterId: (req as any).user.id,
                    status: 'open' as any,
                    note: note || ""
                },
            }),
            prisma.restaurantTable.update({ 
                where: { id: Number(tableId) }, 
                data: { status: 'occupied' as any } 
            }),
        ])

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

        const [order, menuItem] = await Promise.all([
            prisma.order.findUnique({ where: { id: orderId } }),
            prisma.menuItem.findUnique({ where: { id: Number(menuItemId) } }),
        ])

        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        if (order.status !== 'open') { res.status(400).json({ error: 'Order is not open' }); return }
        if (!menuItem) { res.status(404).json({ error: 'Menu item not found' }); return }
        if (!menuItem.isAvailable) { res.status(400).json({ error: 'Menu item unavailable' }); return }

        const qty = Number(quantity) || 1
        const currentStock = (menuItem as any).stock ?? (menuItem as any).quantity ?? 0;

        if (currentStock < qty) {
            res.status(400).json({ error: 'Insufficient stock' });
            return
        }

        const unitPrice = Number(menuItem.price)
        const subtotal = unitPrice * qty

        const item = await prisma.$transaction(async (tx) => {
            const newItem = await tx.orderItem.create({
                data: { orderId, menuItemId: menuItem.id, quantity: qty, unitPrice, subtotal },
                include: { menuItem: true },
            })

            await tx.menuItem.update({
                where: { id: Number(menuItemId) },
                data: { [(menuItem as any).stock !== undefined ? 'stock' : 'quantity']: { decrement: qty } }
            })

            const allItems = await tx.orderItem.findMany({ where: { orderId } })
            const total = allItems.reduce((s: number, i: any) => s + Number(i.subtotal), 0)
            
            await tx.order.update({ where: { id: orderId }, data: { totalAmount: total } })
            
            return newItem
        })

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

        const order = await prisma.order.findUnique({
            where: { id: orderId }, include: { items: true },
        })
        
        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        if (order.status !== 'open') { res.status(400).json({ error: 'Order is not open' }); return }
        if (!order.items || order.items.length === 0) {
            res.status(400).json({ error: 'Cannot confirm empty order' });
            return
        }

        const updated = await prisma.order.update({ 
            where: { id: orderId }, 
            data: { status: 'confirmed' as any } 
        })
        res.json(updated)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

export default router