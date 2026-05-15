import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { authenticate, requireRole } from '../middleware/auth'

const router = Router()

// ... (GET /tables และ GET / ตรงนี้เหมือนเดิมครับ)

// POST /api/orders — open new order
// ✅ ปรับปรุง BUG-002 [Double Booking] ให้รองรับ Newman
router.post('/', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const { tableId, note } = req.body as { tableId?: number; note?: string }
        if (!tableId) { res.status(400).json({ error: 'tableId required' }); return }

        const table = await prisma.restaurantTable.findUnique({ where: { id: Number(tableId) } })
        if (!table) { res.status(404).json({ error: 'Table not found' }); return }

        // ค้นหาออเดอร์ที่ยังค้างอยู่ (เปิด หรือ ยืนยันแล้ว)
        const existing = await prisma.order.findFirst({
            where: {
                tableId: Number(tableId),
                status: { in: ['open', 'confirmed'] as any }
            }
        })

        if (existing) {
            // ✅ คืน 409 ตามที่ TC-015 คาดหวัง
            res.status(409).json({ error: 'Table already has an active order' });
            return
        }

        // ใช้ Transaction เพื่อให้แน่ใจว่าสร้าง Order พร้อมเปลี่ยนสถานะโต๊ะ
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

// POST /api/orders/:id/items
// ✅ ปรับปรุง TC-005 และแก้ปัญหา URL/null
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
            // 1. สร้าง OrderItem
            const newItem = await tx.orderItem.create({
                data: { orderId, menuItemId: menuItem.id, quantity: qty, unitPrice, subtotal },
                include: { menuItem: true },
            })

            // 2. หักสต็อก
            await tx.menuItem.update({
                where: { id: Number(menuItemId) },
                data: { [(menuItem as any).stock !== undefined ? 'stock' : 'quantity']: { decrement: qty } }
            })

            // 3. คำนวณยอดรวมใหม่
            const allItems = await tx.orderItem.findMany({ where: { orderId } })
            const total = allItems.reduce((s: number, i: any) => s + Number(i.subtotal), 0)
            
            // 4. อัปเดตยอดรวมใน Order
            await tx.order.update({ where: { id: orderId }, data: { totalAmount: total } })
            
            return newItem
        })

        res.status(201).json(item)
    } catch (err) {
        res.status(500).json({ error: (err as Error).message })
    }
})

// PUT /api/orders/:id/confirm
router.put('/:id/confirm', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const orderId = Number(req.params.id)
        if (isNaN(orderId)) { res.status(400).json({ error: 'Invalid Order ID' }); return }

        const order = await prisma.order.findUnique({
            where: { id: orderId }, include: { items: true },
        })
        
        if (!order) { res.status(404).json({ error: 'Order not found' }); return }
        if (order.status !== 'open') { res.status(400).json({ error: 'Order is not open' }); return }

        // ✅ แก้ไข TC-010: ห้ามยืนยันถ้าไม่มีอาหารในบิล
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

// ... (PUT /cancel ตรงนี้โอเคแล้วครับ)

export default router